import { AIManager } from "../AI/AI";
import { Image } from "../AI/image";
import { logger } from "../logger";
import { ConfigManager } from "../config/configManager";
import { Tool } from "./tool";
import { generateId } from "../utils/utils";

export function registerImage() {
    const toolITT = new Tool({
        type: "function",
        function: {
            name: "image_to_text",
            description: `查看图片中的内容，可指定需要特别关注的内容`,
            parameters: {
                type: "object",
                properties: {
                    id: {
                        type: "string",
                        description: `图片id，或user_avatar:用户名称` + (ConfigManager.message.showNumber ? '或纯数字QQ号' : '') + `，或group_avatar:群聊名称` + (ConfigManager.message.showNumber ? '或纯数字群号' : '')
                    },
                    content: {
                        type: "string",
                        description: `需要特别关注的内容`
                    }
                },
                required: ["id"]
            }
        }
    });
    toolITT.solve = async (ctx, _, ai, args) => {
        const { id, content } = args;

        const image = await ai.context.findImage(ctx, id);
        if (!image) return { content: `未找到图片${id}`, images: [] };
        const text = content ? `请帮我用简短的语言概括这张图片中出现的:${content}` : ``;

        if (image.type === 'local') return { content: '本地图片暂时无法识别', images: [] };
        await image.imageToText(text);
        return { content: image.content || '图片识别失败', images: [] };
    }

    const toolTTI = new Tool({
        type: 'function',
        function: {
            name: 'text_to_image',
            description: '通过文字描述生成图像',
            parameters: {
                type: 'object',
                properties: {
                    prompt: {
                        type: 'string',
                        description: '图像描述'
                    },
                    negative_prompt: {
                        type: 'string',
                        description: '不希望图片中出现的内容描述'
                    },
                    save: {
                        type: "boolean",
                        description: "是否保存图片"
                    },
                    name: {
                        type: "string",
                        description: "如果保存图片，图片的名称"
                    }
                },
                required: ['prompt', 'save', 'name']
            }
        }
    });
    toolTTI.solve = async (ctx, msg, ai, args) => {
        const { prompt, negative_prompt, save, name } = args;

        const ext = seal.ext.find('AIDrawing');
        if (!ext) {
            logger.error(`未找到AIDrawing依赖`);
            return { content: `未找到AIDrawing依赖，请提示用户安装AIDrawing依赖`, images: [] };
        }

        // 切换到当前会话ai
        if (!ctx.isPrivate) ai = AIManager.getAI(ctx.group.groupId);

        const kws = ["tti", name];

        try {
            // 新版 AIDrawing
            if (globalThis.aiDrawing && typeof globalThis.aiDrawing.sendImageRequest === 'function') {
                const result = await globalThis.aiDrawing.sendImageRequest(prompt, negative_prompt);
                const img = new Image();
                img.id = `${name}_${generateId()}`;
                if (result.startsWith("http://") || result.startsWith("https://")) {
                    try {
                        await img.urlToBase64();
                    } catch (e) {
                        logger.error(`将图片URL转换为base64失败: ${e}`);
                        img.file = result;
                    }
                } else {
                    img.file = result;
                }

                img.format = img.format || 'unknown';
                img.content = `AI绘图<|img:${img.id}|>\n${prompt ? `描述: ${prompt}` : ''}\n${negative_prompt ? `不希望出现: ${negative_prompt}` : ''}`;

                if (save) ai.memory.addMemory(ctx, ai, [], [], kws, [img], img.content);

                return { content: `生成成功，请使用<|img:${img.id}|>发送`, images: [img] };
            }

            // 兼容旧版 AIDrawing
            if (globalThis.aiDrawing && typeof globalThis.aiDrawing.generateImage === 'function') {
                try {
                    await globalThis.aiDrawing.generateImage(prompt, ctx, msg, negative_prompt);
                    if (save) {
                        logger.warning('旧版 AIDrawing，无法直接保存图片');
                        return { content: `图像生成请求已发送`, images: [] };
                    }
                    return { content: `图像生成请求已发送`, images: [] };
                } catch (e) {
                    logger.error(`图像生成失败：：${e}`);
                    return { content: `图像生成失败：${e}`, images: [] };
                }
            }
            logger.error('未找到可用的 AIDrawing 接口，AIDrawing插件可能存在问题');
            return { content: `未找到可用的 AIDrawing 接口， AIDrawing插件可能存在问题`, images: [] };
        } catch (e) {
            logger.error(`图像生成失败：${e}`);
            return { content: `图像生成失败：${e}`, images: [] };
        }
    }

    const toolListImages = new Tool({
        type: 'function',
        function: {
            name: 'list_images',
            description: '列出图库中所有可发送的图片及其描述。不传 keyword 查看全部图片；传 keyword 则按关键词过滤。用于了解有哪些表情包可用，然后调用 send_image 按 id 精确发送。',
            parameters: {
                type: 'object',
                properties: {
                    keyword: {
                        type: 'string',
                        description: '可选，按关键词过滤描述。建议先按照当前想表达的情感传关键词'
                    }
                },
                required: []
            }
        }
    });
    toolListImages.solve = async (ctx, msg, ai, args) => {
        ai.imagePool.loadLocalImages();
        const kw = (args.keyword || '').trim();
        let list = ai.imagePool.images;
        if (kw) {
            list = list.filter(e => e.description.includes(kw));
        }
        if (list.length === 0) return { content: kw ? '[没有匹配"' + kw + '"的图片]' : '[图库为空]', images: [] };
        const text = list
            .map((e, i) => {
                // Clean description: trim raw JSON artifacts from old migrated data
                let desc = e.description;
                const m = desc.match(/text2[:：]\s*(.+?)(?:[}；]|$)/);
                if (m) desc = m[1].trim();
                if (desc.length > 80) desc = desc.slice(0, 80) + '...';
                return (i + 1) + '. [' + e.source + '] ' + desc + ' (id:' + e.id + ')';
            })
            .join('\n');
        return { content: text, images: [] };
    };

    const toolSendImage = new Tool({
        type: 'function',
        function: {
            name: 'send_image',
            description: '发送一张图片或表情包。可先用 list_images 查看图片 id，再传入 id 精确发送；或传入 description 从图库模糊匹配。',
            parameters: {
                type: 'object',
                properties: {
                    id: {
                        type: 'string',
                        description: '图片 id（来自 list_images 返回结果），精确匹配'
                    },
                    description: {
                        type: 'string',
                        description: '图片描述，如"开心的猫"、"疑惑"、"拍桌大笑"（与 id 二选一，优先使用 id）'
                    }
                },
                required: []
            }
        }
    });
    toolSendImage.solve = async (ctx, msg, ai, args) => {
        const { id, description: desc } = args;

        ai.imagePool.loadLocalImages();

        let entry;
        if (id) {
            entry = ai.imagePool.images.find(e => e.id === id);
            if (!entry) return { content: '[未找到图片 id:' + id + ']', images: [] };
        } else if (desc) {
            entry = ai.imagePool.search(desc);
            if (!entry) return { content: '[未找到匹配"' + desc + '"的图片，可用 list_images 查看可用图片]', images: [] };
        } else {
            return { content: '[send_image] 至少需要 id 或 description 参数', images: [] };
        }

        // Validate stolen image URLs
        if (entry.source === 'stolen') {
            const img = new Image();
            img.file = entry.file;
            if (!await img.checkImageUrl()) {
                ai.imagePool.remove(entry.id);
                return { content: '[图片链接已过期，已清理]', images: [] };
            }
        }

        seal.replyToSender(ctx, msg, '[CQ:image,file=' + entry.file + ']');
        return { content: '', images: [] };
    };
}