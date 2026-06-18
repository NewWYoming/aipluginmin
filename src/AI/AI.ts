import { Image, ImageManager } from "./image";
import { ConfigManager } from "../config/configManager";
import { replyToSender, revive, transformMsgId } from "../utils/utils";
import { AIClient } from "../service/AIClient";
import { ToolCallLoop } from "../service/ToolCallLoop";
import { OpenAIMessage } from "../service/providers";
import { Context } from "./context";
import { MemoryManager } from "./memory";
import { handleMessages } from "../utils/utils_message";
import { ToolManager } from "../tool/tool";
import { logger } from "../logger";
import { handleReply, MessageSegment, transformArrayToContent } from "../utils/utils_string";
import { TimerManager } from "../timer";
import { ImagePool } from './ImagePool';

export interface GroupInfo {
    isPrivate: false;
    id: string;
    name: string;
}

export interface UserInfo {
    isPrivate: true;
    id: string;
    name: string;
}

export type SessionInfo = GroupInfo | UserInfo;

export class Setting {
    static validKeys: (keyof Setting)[] = ['priv', 'standby', 'counter', 'timer', 'prob', 'activeTimeInfo'];
    priv: number;
    standby: boolean;
    counter: number;
    timer: number;
    prob: number;
    activeTimeInfo: {
        start: number;
        end: number;
        segs: number;
    }

    constructor() {
        this.priv = 0;
        this.standby = false;
        this.counter = -1;
        this.timer = -1;
        this.prob = -1;
        this.activeTimeInfo = {
            start: 0,
            end: 0,
            segs: 0
        }
    }
}

export class AI {
    static validKeys: (keyof AI)[] = ['context', 'tool', 'memory', 'imageManager', 'imagePool', 'setting', '_lastCleanupDate'];
    id: string;
    context: Context;
    tool: ToolManager;
    memory: MemoryManager;
    imageManager: ImageManager;
    imagePool: ImagePool;
    setting: Setting;
    isChatting: boolean;
    _lastCleanupDate: string;

    // 下面是临时变量，用于处理消息
    bucket: { // 触发次数令牌桶
        count: number,
        lastTime: number
    }

    constructor() {
        this.id = '';
        this.context = new Context();
        this.tool = new ToolManager();
        this.memory = new MemoryManager();
        this.imagePool = new ImagePool();
        this.imageManager = new ImageManager();
        this.imageManager.imagePool = this.imagePool; // 共享同一个池
        this.setting = new Setting();
        this.bucket = {
            count: 0,
            lastTime: 0
        }
        this.isChatting = false;
    }

    resetState() {
        clearTimeout(this.context.timer);
        this.context.timer = null;
        this.context.counter = 0;
        this.bucket.count--;
        this.tool.toolCallCount = 0;
    }

    async handleReceipt(ctx: seal.MsgContext, msg: seal.Message, ai: AI, messageArray: MessageSegment[]) {
        const { content, images } = await transformArrayToContent(ctx, ai, messageArray);
        await ai.context.addMessage(ctx, msg, ai, content, images, 'user', transformMsgId(msg.rawId));
    }

    async reply(ctx: seal.MsgContext, msg: seal.Message, contextArray: string[], replyArray: string[], images: Image[]) {
        for (let i = 0; i < contextArray.length; i++) {
            const content = contextArray[i];
            const reply = replyArray[i];
            const msgId = await replyToSender(ctx, msg, this, reply);
            await this.context.addMessage(ctx, msg, this, content, images, 'assistant', msgId);
        }

        // Image sending is now handled via ImagePool in image command
    }

    async chat(ctx: seal.MsgContext, msg: seal.Message, reason: string = ''): Promise<void> {
        if (this.isChatting) {
            logger.info('跳过重复触发: 已有回复在进行中');
            return;
        }
        this.isChatting = true;
        logger.info('触发回复:', reason || '未知原因');

        try {
        if (reason !== '函数回调触发') {
            const { bucketLimit, fillInterval } = ConfigManager.received;
            // 补充并检查触发次数
            if (Date.now() - this.bucket.lastTime > fillInterval * 1000) {
                const fillCount = (Date.now() - this.bucket.lastTime) / (fillInterval * 1000);
                this.bucket.count = Math.min(this.bucket.count + fillCount, bucketLimit);
                this.bucket.lastTime = Date.now();
            }
            if (this.bucket.count <= 0) {
                logger.warning(`触发次数不足，无法回复`);
                return;
            }
        }

        // 检查toolsNotAllow状态
        const { toolsNotAllow } = ConfigManager.tool;
        toolsNotAllow.forEach(key => {
            if (this.tool.toolStatus.hasOwnProperty(key)) {
                this.tool.toolStatus[key] = false;
            }
        });

        //清空数据
        this.resetState();

        const { isTool } = ConfigManager.tool;
        const requestConfig = ConfigManager.request;

        const client = new AIClient({
            apiProvider: requestConfig.apiProvider,
            url: requestConfig.url,
            apiKey: requestConfig.apiKey,
            model: requestConfig.model,
            maxTokens: requestConfig.maxTokens,
            timeout: requestConfig.timeout,
            thinkingEnabled: requestConfig.thinkingEnabled,
            reasoningEffort: requestConfig.reasoningEffort,
            toolThinkingEnabled: requestConfig.toolThinkingEnabled,
            toolReasoningEffort: requestConfig.toolReasoningEffort,
            temperature: requestConfig.temperature,
            topP: requestConfig.topP,
            extraBody: requestConfig.extraBody,
        });

        const messages = await handleMessages(ctx, this) as OpenAIMessage[];
        AIManager.saveAI(this.id);
        const tools = isTool ? this.tool.getToolsInfo(msg.messageType) : null;

        if (isTool && tools) {
            const loop = new ToolCallLoop(client, requestConfig);
            const result = await loop.run(ctx, msg, this, messages, tools);
            const replyText = result.content;

            if (replyText) {
                const { contextArray, replyArray, images } = await handleReply(ctx, msg, this, replyText);
                await this.reply(ctx, msg, contextArray, replyArray, images);
            }
        } else {
            const response = await client.chat(messages, null, 'none');
            const { contextArray, replyArray, images } = await handleReply(ctx, msg, this, response.content);
            await this.reply(ctx, msg, contextArray, replyArray, images);
        }

        AIManager.saveAI(this.id);
    } catch (e) {
        logger.error('chat() 异常:', e?.message || e);
    } finally {
        this.isChatting = false;
    }
}

    // 若不在活动时间范围内，返回-1
    get curActiveTimeSegIndex(): number {
        const now = new Date();
        const cur = now.getHours() * 60 + now.getMinutes();
        const { start, end, segs } = this.setting.activeTimeInfo;
        const endReal = end >= start ? end : end + 24 * 60;
        const curReal = cur >= start ? cur : cur + 24 * 60;

        if (curReal >= endReal) return -1;

        const segLen = (endReal - start) / segs;
        const index = Math.floor((curReal - start) / segLen);
        return Math.min(index, segs - 1);
    }

    // 若没有下一个活跃时间点，返回-1
    getNextTimePoint(curSegIndex: number): number {
        const { start, end, segs } = this.setting.activeTimeInfo;

        if (start === 0 && end === 0) return -1;

        const endReal = end >= start ? end : end + 24 * 60;
        const segLen = (endReal - start) / segs;
        const nextSegIndex = (curSegIndex + 1) % segs;
        const todayMin = Math.floor(start + nextSegIndex * segLen + Math.random() * segLen) % (24 * 60);

        const nextTime = new Date();
        nextTime.setHours(Math.floor(todayMin / 60), todayMin % 60, Math.floor(Math.random() * 60), 0);

        // 如果时间已过，设置为明天
        if (nextTime.getTime() <= Date.now()) {
            nextTime.setDate(nextTime.getDate() + 1);
        }

        return Math.floor(nextTime.getTime() / 1000);
    }

    async checkActiveTimer(ctx: seal.MsgContext) {
        // 每天 0 点清理印象
        const today = new Date().toDateString();
        if (today !== this._lastCleanupDate) {
            this._lastCleanupDate = today;
            await this.memory.cleanupImpressions(ctx, this);
            this.context.cleanupStaleAliases();
        }

        const { segs, start, end } = this.setting.activeTimeInfo;
        if (segs !== 0 && (start !== 0 || end !== 0)) {
            const timers = TimerManager.getTimers(this.id, '', ['activeTime']);
            if (timers.length === 0) {
                const curSegIndex = this.curActiveTimeSegIndex;
                const nextTimePoint = this.getNextTimePoint(curSegIndex);
                if (nextTimePoint !== -1) TimerManager.addActiveTimeTimer(ctx, this, nextTimePoint);
                else logger.error(`活跃时间定时器添加失败，无法生成时间点，当前时段序号:${curSegIndex}`);
            }
        }
    }
}

export interface UsageInfo {
    prompt_tokens: number,
    completion_tokens: number
}

export class AIManager {
    static cache: { [key: string]: AI } = {};
    static usageMapCache: { [model: string]: { [time: number]: UsageInfo } } = null;

    static get usageMap(): { [model: string]: { [time: number]: UsageInfo } } {
        if (!this.usageMapCache) {
            try {
                this.usageMapCache = JSON.parse(ConfigManager.ext.storageGet('usageMap') || '{}');
            } catch (error) {
                logger.error(`从数据库中获取usageMap失败:`, error);
            }
        }
        return this.usageMapCache;
    }

    static clearCache() {
        this.cache = {};
    }

    /** 从缓存中驱逐 AI 实例（先持久化） */
    static evictAI(id: string): void {
        if (!this.cache[id]) return;
        this.saveAI(id);
        delete this.cache[id];
        logger.info(`AI 实例已释放: ${id}`);
    }

    /** 驱逐所有私聊 AI 实例（群聊实例保留） */
    static evictPrivateInstances(): void {
        const privateIds = Object.keys(this.cache).filter(id => !id.includes(':Group:'));
        for (const id of privateIds) {
            this.evictAI(id);
        }
        logger.info(`私聊AI实例已清理: ${privateIds.length} 个`);
    }

    static getAI(id: string) {
        if (!this.cache.hasOwnProperty(id)) {
            let ai = new AI();

            try {
                ai = JSON.parse(ConfigManager.ext.storageGet(`AI_${id}`) || '{}', (key, value) => {
                    if (key === "") {
                        return revive(AI, value);
                    }

                    if (key === "context") {
                        const context = revive(Context, value);
                        context.reviveMessages();
                        return context;
                    }
                    if (key === "tool") {
                        const tm = revive(ToolManager, value);
                        tm.reviveToolStauts();
                        return tm;
                    }
                    if (key === "memory") {
                        const mm = revive(MemoryManager, value);
                        mm.reviveMemoryMap();
                        return mm;
                    }
                    if (key === "imageManager") {
                        return revive(ImageManager, value);
                    }
                    if (key === "imagePool") {
                        return revive(ImagePool, value);
                    }
                    if (key === "setting") {
                        return revive(Setting, value);
                    }

                    return value;
                });
            } catch (error) {
                logger.error(`从数据库中获取${`AI_${id}`}失败:`, error);
            }

            // 确保 imageManager 和 imagePool 共享同一个实例
            if (ai.imagePool && ai.imageManager) {
                ai.imageManager.imagePool = ai.imagePool;
            }

            // Persist memoryMap clear from reviveMemoryMap old-format detection
            if ((ai.memory as any)._needsSave) {
                (ai.memory as any)._needsSave = false;
                // 直接写 storage — saveAI 此时 cache 未就绪，会静默跳过
                ConfigManager.ext.storageSet(`AI_${id}`, JSON.stringify(ai));
                logger.info(`AI_${id}: 旧格式记忆已清除并持久化`);
            }

            // Migrate old stolenImages to ImagePool (one-time)
            try {
                const rawData = ConfigManager.ext.storageGet('AI_' + id);
                if (rawData) {
                    const raw = JSON.parse(rawData);
                    if (raw.imageManager && raw.imageManager.stolenImages && raw.imageManager.stolenImages.length > 0) {
                        if (!ai.imagePool) ai.imagePool = new ImagePool();
                        for (const img of raw.imageManager.stolenImages) {
                            if (img.file && img.id) {
                                ai.imagePool.add({
                                    id: img.id,
                                    file: img.file,
                                    description: img.content || '用户发送的图片',
                                    source: 'stolen',
                                    createdAt: Math.floor(Date.now() / 1000)
                                });
                            }
                        }
                        AIManager.saveAI(id);
                    }
                }
            } catch { /* migration is best-effort */ }

            ai.id = id;
            this.cache[id] = ai;
        }

        return this.cache[id];
    }

    static saveAI(id: string) {
        if (this.cache.hasOwnProperty(id)) {
            ConfigManager.ext.storageSet(`AI_${id}`, JSON.stringify(this.cache[id]));
        }
    }

    static clearUsageMap() {
        this.usageMapCache = {};
    }

    static clearExpiredUsage(model: string) {
        const now = new Date();
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth() + 1;
        const currentDay = now.getDate();
        const currentYM = currentYear * 12 + currentMonth;
        const currentYMD = currentYear * 12 * 31 + currentMonth * 31 + currentDay;

        if (!this.usageMap.hasOwnProperty(model)) {
            return;
        }

        for (const key in this.usageMap[model]) {
            const [year, month, day] = key.split('-').map(Number);
            const ym = year * 12 + month;
            const ymd = year * 12 * 31 + month * 31 + day;

            let newKey = '';

            if (ymd < currentYMD - 30) {
                newKey = `${year}-${month}-0`;
            }

            if (ym < currentYM - 11) {
                newKey = `0-0-0`;
            }

            if (newKey) {
                if (!this.usageMap[model].hasOwnProperty(newKey)) {
                    this.usageMap[model][newKey] = {
                        prompt_tokens: 0,
                        completion_tokens: 0
                    };
                }

                this.usageMap[model][newKey].prompt_tokens += this.usageMap[model][key].prompt_tokens;
                this.usageMap[model][newKey].completion_tokens += this.usageMap[model][key].completion_tokens;

                delete this.usageMap[model][key];
            }
        }
    }

    static saveUsageMap() {
        ConfigManager.ext.storageSet('usageMap', JSON.stringify(this.usageMapCache));
    }

    static updateUsage(model: string, usage: {
        prompt_tokens: number,
        completion_tokens: number,
        total_tokens: number
    }) {
        if (!model) {
            return;
        }
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth() + 1;
        const day = now.getDate();
        const key = `${year}-${month}-${day}`;
        if (!this.usageMap.hasOwnProperty(model)) {
            this.usageMap[model] = {};
        }

        if (!this.usageMap[model].hasOwnProperty(key)) {
            this.usageMap[model][key] = {
                prompt_tokens: 0,
                completion_tokens: 0
            };

            this.clearExpiredUsage(model);
        }

        this.usageMap[model][key].prompt_tokens += usage.prompt_tokens || 0;
        this.usageMap[model][key].completion_tokens += usage.completion_tokens || 0;

        this.saveUsageMap();
    }

    static getModelUsage(model: string): {
        prompt_tokens: number,
        completion_tokens: number
    } {
        if (!this.usageMap.hasOwnProperty(model)) {
            return {
                prompt_tokens: 0,
                completion_tokens: 0
            };
        }

        const usage = {
            prompt_tokens: 0,
            completion_tokens: 0
        }

        for (const key in this.usageMap[model]) {
            usage.prompt_tokens += this.usageMap[model][key].prompt_tokens;
            usage.completion_tokens += this.usageMap[model][key].completion_tokens;
        }

        return usage;
    }
}