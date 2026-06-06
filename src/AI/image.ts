import { ConfigManager } from "../config/configManager";
import { sendITTRequest } from "../service/legacy";
import { generateId } from "../utils/utils";
import { logger } from "../logger";
import { AI } from "./AI";
import { MessageSegment, parseSpecialTokens } from "../utils/utils_string";
import { ImagePool, ImageEntry } from './ImagePool';

export class Image {
    static validKeys: (keyof Image)[] = ['id', 'file', 'content'];
    id: string;
    file: string; // 图片url或本地路径
    content: string;

    constructor() {
        this.id = generateId();
        this.file = '';
        this.content = '';
    }

    get type(): 'url' | 'local' | 'base64' {
        if (this.file.startsWith('http')) return 'url';
        if (this.format) return 'base64';
        return 'local';
    }

    get base64(): string {
        return ConfigManager.ext.storageGet(`base64_${this.id}`) || '';
    }
    set base64(value: string) {
        this.file = '';
        ConfigManager.ext.storageSet(`base64_${this.id}`, value);
    }

    get format(): string {
        return ConfigManager.ext.storageGet(`format_${this.id}`) || '';
    }
    set format(value: string) {
        ConfigManager.ext.storageSet(`format_${this.id}`, value);
    }

    get CQCode(): string {
        const file = this.type === 'base64' ? seal.base64ToImage(this.base64) : this.file;
        return `[CQ:image,file=${file}]`;
    }

    get base64Url(): string {
        let format = this.format;
        if (!format || format === "unknown") format = 'png';
        return `data:image/${format};base64,${this.base64}`
    }

    /**
     * 获取图片的URL，若为base64则返回base64Url
     */
    get url(): string {
        return this.type === 'base64' ? this.base64Url : this.file;
    }

    async checkImageUrl(): Promise<boolean> {
        if (this.type !== 'url') return true;
        let isValid = false;
        try {
            const response = await fetch(this.file, { method: 'GET' });

            if (response.ok) {
                const contentType = response.headers.get('Content-Type');
                if (contentType && contentType.startsWith('image')) {
                    logger.info('URL有效且未过期');
                    isValid = true;
                } else {
                    logger.warning(`URL有效但未返回图片 Content-Type: ${contentType}`);
                }
            } else {
                if (response.status === 500) {
                    logger.warning(`URL不知道有没有效 状态码: ${response.status}`);
                    isValid = true;
                } else {
                    logger.warning(`URL无效或过期 状态码: ${response.status}`);
                }
            }
        } catch (error) {
            logger.error('在checkImageUrl中请求出错:', error);
        }
        return isValid;
    }

    async urlToBase64() {
        if (this.type !== 'url') return;
        const { imageTobase64Url } = ConfigManager.backend;
        try {
            const response = await fetch(`${imageTobase64Url}/image-to-base64`, {
                method: 'POST',
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                },
                body: JSON.stringify({ url: this.file })
            });

            const text = await response.text();
            if (!response.ok) throw new Error(`请求失败! 状态码: ${response.status}\n响应体: ${text}`);
            if (!text) throw new Error("响应体为空");

            try {
                const data = JSON.parse(text);
                if (data.error) throw new Error(`请求失败! 错误信息: ${data.error.message}`);
                if (!data.base64 || !data.format) throw new Error(`响应体中缺少base64或format字段`);
                this.base64 = data.base64;
                this.format = data.format;
            } catch (e) {
                throw new Error(`解析响应体时出错:${e}\n响应体:${text}`);
            }
        } catch (error) {
            logger.error("在imageUrlToBase64中请求出错：", error);
        }
    }

    async imageToText(prompt = '') {
        const { defaultPrompt, urlToBase64, maxChars } = ConfigManager.image;

        if (urlToBase64 == '总是' && this.type === 'url') await this.urlToBase64();

        const messages = [{
            role: "user",
            content: [{
                "type": "image_url",
                "image_url": { "url": this.url }
            }, {
                "type": "text",
                "text": prompt ? prompt : defaultPrompt
            }]
        }]

        this.content = (await sendITTRequest(messages)).slice(0, maxChars);

        if (!this.content && urlToBase64 === '自动' && this.type === 'url') {
            logger.info(`图片${this.id}第一次识别失败，自动尝试使用转换为base64`);
            await this.urlToBase64();
            messages[0].content[0].image_url.url = this.base64Url;
            this.content = (await sendITTRequest(messages)).slice(0, maxChars);
        }

        if (!this.content) logger.error(`图片${this.id}识别失败`);
    }
}

export class ImageManager {
    static validKeys: (keyof ImageManager)[] = ['imagePool'];
    imagePool: ImagePool;

    constructor() {
        this.imagePool = new ImagePool();
    }

    static getUserAvatar(uid: string): Image {
        const img = new Image();
        img.id = `user_avatar:${uid}`;
        img.file = `https://q1.qlogo.cn/g?b=qq&nk=${uid.replace(/^.+:/, '')}&s=640`;
        return img;
    }

    static getGroupAvatar(gid: string): Image {
        const img = new Image();
        img.id = `group_avatar:${gid}`;
        img.file = `https://p.qlogo.cn/gh/${gid.replace(/^.+:/, '')}/${gid.replace(/^.+:/, '')}/640`;
        return img;
    }

    static getLocalImageListText(p: number = 1): string {
        const { localImagePathMap } = ConfigManager.image;
        const images = Object.keys(localImagePathMap).map(id => {
            const image = new Image();
            image.id = id;
            image.file = localImagePathMap[id];
            return image;
        });
        if (images.length == 0) return '';
        if (p > Math.ceil(images.length / 5)) p = Math.ceil(images.length / 5);
        return images.slice((p - 1) * 5, p * 5)
            .map((img, i) => {
                return `${i + 1 + (p - 1) * 5}. 名称:${img.id}
${img.CQCode}`;
            }).join('\n') + `\n当前页码:${p}/${Math.ceil(images.length / 5)}`;
    }

    /**
     * 提取并替换CQ码中的图片
     * @param ctx 
     * @param message 
     * @returns 
     */
    async handleImageMessageSegment(ctx: seal.MsgContext, seg: MessageSegment): Promise<{ content: string, images: Image[] }> {
        const { receiveImage } = ConfigManager.image;
        if (!receiveImage || seg.type !== 'image') return { content: '', images: [] };

        let content = '';
        const images: Image[] = [];
        try {
            const file = seg.data.url || seg.data.file || '';
            if (!file) return { content: '', images: [] };

            const image = new Image();
            image.file = file;
            const { condition } = ConfigManager.image;
            const fmtCondition = parseInt(seal.format(ctx, `{${condition}}`));
            if (fmtCondition === 1) await image.imageToText();

            // Parse JSON result from imageToText (new JSON prompt)
            // Model may return array, nested object, or different key names — normalize
            let text1 = '', text2 = image.content, isEmoji = false;
            if (image.content) {
                try {
                    let parsed = JSON.parse(image.content);
                    // Unwrap array response: ["{...}"] or [{...}]
                    if (Array.isArray(parsed)) {
                        parsed = parsed[0];
                        if (!parsed) throw new Error('empty array');
                    }
                    // If still a string (model double-wrapped JSON), parse again
                    if (typeof parsed === 'string') {
                        try { parsed = JSON.parse(parsed); } catch { /* not JSON string */ }
                    }
                    // Normalize: try both flat and nested formats
                    const obj: any = parsed;
                    if (obj) {
                        text1 = obj.text1 || obj.ocr_text || (obj.image_content?.ocr_text) || '';
                        text2 = obj.text2 || obj.description || (obj.image_content?.description) || image.content;
                        isEmoji = obj.isEmoji === true || obj.is_emoji === true || (obj.image_content?.is_emoji) === true;
                    }
                } catch {
                    // Old format or non-JSON response: treat whole content as text2
                    text2 = image.content;
                }
            }

            content += text2 ? `<|img:${image.id}:${text2}|>` : `<|img:${image.id}|>`;
            images.push(image);

            // Auto-steal: if emoji and probability hits → store in ImagePool
            if (isEmoji) {
                logger.info(`检测到表情包: ${text2 || '(无描述)'}`);
                const { p } = ConfigManager.image;
                const rolled = Math.random() * 100;
                if (rolled < p) {
                    this.imagePool.add({
                        id: image.id,
                        file: image.file,
                        description: text2 || '表情包',
                        source: 'stolen',
                        createdAt: Math.floor(Date.now() / 1000)
                    });
                    logger.info(`表情包已存入图库 (${rolled.toFixed(1)}% < ${p}%), 当前共${this.imagePool.stolenCount}张`);
                } else {
                    logger.info(`表情包未存入图库 (${rolled.toFixed(1)}% >= ${p}%)`);
                }
            }
        } catch (error) {
            logger.error('在handleImageMessage中处理图片时出错:', error);
        }

        return { content, images };
    }

    static async extractExistingImagesToSave(ctx: seal.MsgContext, ai: AI, s: string): Promise<Image[]> {
        const segs = parseSpecialTokens(s);
        const images: Image[] = [];
        for (const seg of segs) {
            switch (seg.type) {
                case 'img': {
                    const id = seg.content;
                    const image = await ai.context.findImage(ctx, id);

                    if (image) {
                        if (image.type === 'url') await image.urlToBase64();
                        images.push(image);
                    } else {
                        logger.warning(`无法找到图片：${id}`);
                    }
                    break;
                }
            }
        }
        return images;
    }
}