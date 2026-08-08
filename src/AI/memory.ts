import { ConfigManager } from "../config/configManager";
import { AI, AIManager, GroupInfo, SessionInfo, UserInfo } from "./AI";
import { Context } from "./context";
import { generateId, getCommonUser, revive } from "../utils/utils";
import { AIClient } from "../service/AIClient";
import { logger } from "../logger";
import { fmtDate } from "../utils/utils_string";
import { Image, ImageManager } from "./image";

export interface searchOptions {
    topK: number;
    keywords: string[];
    userList: UserInfo[];
    groupList: GroupInfo[];
    includeImages: boolean;
    method: 'weight' | 'score' | 'early' | 'late' | 'recent';
    hardUserFilter?: boolean;   // 新增：工具路径显式点名用户时硬过滤
}

// ---- 共享检索打分工具（search 与 scoreCandidates 统一使用）----

const HAN_RE = /[\u4e00-\u9fff]/;

/** 分词：按标点/空白切分；汉字连续段额外生成 bigram；非汉字 token 原样保留 */
function tokenizeForScore(s: string): string[] {
    const out: string[] = [];
    for (const seg of s.split(/[\s,，。！？、；：""'':"'\n]+/)) {
        if (!seg) continue;
        // 拆出汉字段与非汉字段
        const parts = seg.split(/([\u4e00-\u9fff]+)/);
        for (const p of parts) {
            if (!p) continue;
            if (HAN_RE.test(p) && !/[^\u4e00-\u9fff]/.test(p)) {
                // 纯汉字段：生成 bigram（长度1保留单字）
                if (p.length === 1) { out.push(p); }
                else {
                    for (let i = 0; i < p.length - 1; i++) out.push(p.slice(i, i + 2));
                }
            } else {
                out.push(p);
            }
        }
    }
    return out;
}

function jaccardSimilarity(a: string[], b: string[]): number {
    const setA = new Set(a), setB = new Set(b);
    let intersection = 0;
    setA.forEach(x => { if (setB.has(x)) intersection++; });
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

/** 综合打分：kwScore=关键词与正文 Jaccard 取最大；userMatch 为提交3预留，默认0 */
function calcBaseScore(kwScore: number, recency: number, importanceScore: number, userMatch = 0): number {
    return 0.45 * kwScore + 0.25 * recency + 0.20 * importanceScore + 0.10 * userMatch;
}

/** djb2 内容哈希（32 位无符号，toString(36) 短 id）——知识库无 ID 条目稳定 id 与 Y5 解析缓存共用 */
function djb2Hash(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
}

export class Memory {
    static validKeys: (keyof Memory)[] = ['id', 'text', 'sessionInfo', 'userList', 'groupList', 'createTime', 'lastMentionTime', 'keywords', 'weight', 'images', 'scope', 'importance'];
    id: string; // 记忆ID
    text: string; // 记忆内容
    sessionInfo: SessionInfo;
    userList: UserInfo[];
    groupList: GroupInfo[];
    createTime: number; // 秒级时间戳
    lastMentionTime: number;
    keywords: string[];
    weight: number; // 记忆权重，0-10
    images: Image[];
    scope: 'private' | 'group' | 'universal';
    importance: 1 | 3 | 5;

    constructor() {
        this.id = '';
        this.text = '';
        this.sessionInfo = {
            id: '',
            isPrivate: false,
            name: '',
        };
        this.userList = [];
        this.groupList = [];
        this.createTime = 0;
        this.lastMentionTime = 0;
        this.keywords = [];
        this.weight = 0;
        this.images = [];
        this.scope = 'group';
        this.importance = 3;
    }

    get copy(): Memory {
        const m = new Memory();
        m.id = this.id;
        m.text = this.text;
        m.sessionInfo = JSON.parse(JSON.stringify(this.sessionInfo));
        m.userList = JSON.parse(JSON.stringify(this.userList));
        m.groupList = JSON.parse(JSON.stringify(this.groupList));
        m.createTime = this.createTime;
        m.lastMentionTime = this.lastMentionTime;
        m.keywords = [...this.keywords];
        m.weight = this.weight;
        m.images = [...this.images];
        m.scope = this.scope;
        m.importance = this.importance;
        return m;
    }

    /**
     * 计算记忆的新鲜度衰减因子，越大表示越新鲜
     * @returns 衰减因子（1→0）
     */
    get decay() {
        const now = Math.floor(Date.now() / 1000);
        const ageInDays = (now - this.createTime) / (24 * 60 * 60);
        const activityInHours = (now - this.lastMentionTime) / (60 * 60);
        // 基础新鲜度: exp(-ageInDays / 7)
        const ageDecay = Math.exp(-ageInDays / 7);
        // 活跃度: exp(-activityInHours / 4)
        const activityDecay = Math.exp(-activityInHours / 4);
        // 衰减因子，取年龄衰减和活跃度衰减的较大值
        return Math.max(ageDecay, activityDecay);
    }

}
export interface UserObservation {
  rawMessages: string[];
  lastSpeak: number;
  /** Y9: 印象 LLM 失败冷却时间戳（秒）；失败不丢观察，冷却后整批重试。随 observations 整对象拷贝落盘（validKeys 含 observations，revive 无深度校验），最长 5 分钟，无害 */
  impressionFailAt?: number;
}

export interface Impression {
  text: string;
  updatedAt: number;
}

export class MemoryManager {
    static validKeys: (keyof MemoryManager)[] = ['memoryMap', 'impressions', 'observations'];
    memoryMap: { [id: string]: Memory };
    impressions: { [userId: string]: Impression };
    observations: { [userId: string]: UserObservation };

    constructor() {
        this.memoryMap = {};
        this.impressions = {};
        this.observations = {};
    }

    reviveMemoryMap() {
        // 旧格式记忆（无 scope 字段或 scope 为空）——按 sessionInfo 推断迁移，保留数据
        let migrated = false;
        for (const id in this.memoryMap) {
            const m = this.memoryMap[id] as any;
            if (!m.hasOwnProperty('scope') || m.scope == null) {
                m.scope = m.sessionInfo && m.sessionInfo.isPrivate ? 'private' : 'group';
                if (!m.sessionInfo || !m.sessionInfo.id) {
                    m.sessionInfo = { id: '', isPrivate: false, name: '' };
                }
                migrated = true;
            }
        }
        if (migrated) {
            (this as any)._needsSave = true;
            logger.info('检测到旧格式记忆（无 scope 字段），已按 sessionInfo 推断迁移，记忆数据保留。');
        }

        // 正常 revival（原有逻辑）
        for (const id in this.memoryMap) {
            this.memoryMap[id] = revive(Memory, this.memoryMap[id]);
            if (!this.memoryMap[id].text) {
                delete this.memoryMap[id];
                continue;
            }
            if (!this.memoryMap[id].hasOwnProperty('images')) this.memoryMap[id].images = [];
            this.memoryMap[id].images = this.memoryMap[id].images.map(image => revive(Image, image));
        }
    }

    get memoryIds() {
        return Object.keys(this.memoryMap);
    }

    get memoryList() {
        return Object.values(this.memoryMap);
    }

    get keywords() {
        const keywords = new Set<string>();
        this.memoryList.forEach(m => m.keywords.forEach(kw => keywords.add(kw)));
        return Array.from(keywords);
    }

    async addMemory(ctx: seal.MsgContext, ai: AI, ul: UserInfo[], gl: GroupInfo[], kws: string[], images: Image[], text: string, importance: 1 | 3 | 5 = 3) {
        let id = generateId(), a = 0;
        while (this.memoryMap.hasOwnProperty(id)) {
            id = generateId();
            a++;
            if (a > 1000) {
                logger.error(`生成记忆id失败，已尝试1000次，放弃`);
                return;
            }
        }

        const scope = ctx.isPrivate ? 'private' : 'group';
        for (const id of this.memoryIds) {
            const m = this.memoryMap[id];
            if (m.scope === scope && jaccardSimilarity(tokenizeForScore(text), tokenizeForScore(m.text)) >= 0.7) {
                m.keywords = Array.from(new Set([...m.keywords, ...kws]));
                m.lastMentionTime = Math.floor(Date.now() / 1000);
                m.weight = Math.min(10, m.weight + 1);
                logger.info(`记忆已存在(相似去重)，id:${id}，合并关键词:${m.keywords.join(',')}`);
                return;
            }
        }

        // 添加文本内插入的图片
        const imgIdSet = new Set(images.map(img => img.id));
        (await ImageManager.extractExistingImagesToSave(ctx, ai, text)).forEach(img => {
            if (imgIdSet.has(img.id)) return;
            imgIdSet.add(img.id);
            images.push(img);
        });

        const now = Math.floor(Date.now() / 1000);
        const m = new Memory();
        m.id = id;
        m.text = text;
        m.sessionInfo = {
            id: ai.id,
            isPrivate: ctx.isPrivate,
            name: ctx.isPrivate ? ctx.player.name : ctx.group.groupName,
        };
        m.userList = ul;
        m.groupList = gl;
        m.createTime = now;
        m.lastMentionTime = now;
        m.keywords = kws;
        m.weight = 5;
        m.scope = ctx.isPrivate ? 'private' : 'group';
        m.importance = importance;
        m.images = images;
        this.memoryMap[id] = m;
        this.limitMemory();
        logger.info(`新记忆已创建: id=${id}, scope=${m.scope}, 重要性=${importance}, 关键词=[${kws.join(',')}], 文本=${text.slice(0, 50)}`);
    }

    deleteMemory(ids: string[] = [], kws: string[] = []): number {
        if (ids.length === 0 && kws.length === 0) return 0;
        const map = this.memoryMap || {};
        const before = Object.keys(map).length;

        ids.forEach(id => delete map[String(id)]);

        if (kws.length > 0) {
            for (const id in map) {
                // P4: 纯子串匹配（删除语义比 O1.1 的子串+token 更宽）；单字关键词（len<2）不可删，有意取舍
                if (kws.some(kw => kw.length >= 2 && (map[id].keywords.some(k => k.includes(kw)) || map[id].text.includes(kw)))) {
                    delete map[id];
                }
            }
        }
        const deleted = before - Object.keys(map).length;
        if (deleted > 0) {
            logger.info(`记忆已删除: ${deleted}条, ids=[${ids.join(',')}], keywords=[${kws.join(',')}]`);
        } else {
            logger.warning(`未找到匹配的记忆: ids=[${ids.join(',')}], keywords=[${kws.join(',')}]`);
        }
        return deleted;
    }

    limitMemory() {
        const { memoryLimit } = ConfigManager.memory;
        const limit = memoryLimit > 0 ? Math.max(1, memoryLimit - 1) : 0; // 预留1个位置用于存储最新记忆（=0 禁用；=1 保留最高分 1 条）
        if (this.memoryList.length <= limit) return;
        const beforeCount = this.memoryList.length;
        this.memoryList.map((m) => {
            return {
                id: m.id,
                score: m.decay * m.weight
            }
        })
            .sort((a, b) => b.score - a.score) // 从大到小排序
            .slice(limit)
            .forEach(item => delete this.memoryMap?.[item.id]);
        const evicted = beforeCount - this.memoryList.length;
        if (evicted > 0) logger.info('记忆淘汰: ' + evicted + '条 (当前' + this.memoryList.length + '/' + memoryLimit + ')');
    }

    clearMemory() {
        this.memoryMap = {};
        logger.info(`所有记忆已清除`);
    }

    async search(query: string, options: searchOptions = {
        topK: 10,
        userList: [],
        groupList: [],
        keywords: [],
        includeImages: false,
        method: 'score'
    }) {
        if (!this.memoryList.length) return [];
        const { userList: ul, keywords: kws, includeImages, method, hardUserFilter = false } = options;
        const now = Math.floor(Date.now() / 1000);
        // 关键词软合并：query + keywords 统一分词
        const qTokens = [...new Set([...tokenizeForScore(query), ...tokenizeForScore(kws.join(' '))])];

        return this.memoryList
            .map(function(m) {
                if (includeImages && m.images.length === 0) return null;
                const mc = m.copy;

                // Composite pre-score
                const kwScore = Math.max(
                    jaccardSimilarity(qTokens, tokenizeForScore(mc.keywords.join(' '))),
                    jaccardSimilarity(qTokens, tokenizeForScore(mc.text))
                );
                if (method === 'score' && query.trim() && kwScore === 0) return null;
                // 硬过滤：显式点名用户时，无共同用户的记忆直接淘汰
                if (hardUserFilter && ul.length > 0 && getCommonUser(ul, m.userList).length === 0) return null;
                const daysSinceCreate = (now - mc.createTime) / 86400;
                const recency = Math.exp(-Math.log(2) * daysSinceCreate / 14);
                const importanceMap: { [key: number]: number } = { 1: 0.2, 3: 0.5, 5: 0.8 };
                const importanceScore = importanceMap[mc.importance] || 0.5;
                const userMatch = ul.length > 0 ? (getCommonUser(ul, m.userList).length > 0 ? 1 : 0) : 0;
                const baseScore = calcBaseScore(kwScore, recency, importanceScore, userMatch);

                (mc as any)._baseScore = baseScore;
                return mc;
            })
            .filter(function(m) { return m !== null; })
            .filter(function(m: any) { return method === 'weight' || method === 'early' || method === 'late' || method === 'recent' || m._baseScore > 0.1; })
            .sort(function(a: any, b: any) {
                switch (method) {
                    case 'weight': return b.weight - a.weight;
                    case 'score': return (b._baseScore || 0) - (a._baseScore || 0);
                    case 'early': return a.createTime - b.createTime;
                    case 'late': return b.createTime - a.createTime;
                    case 'recent': return b.lastMentionTime - a.lastMentionTime;
                    default: return (b._baseScore || 0) - (a._baseScore || 0);
                }
            })
            .slice(0, options.topK || 10);
    }

    updateMemoryWeight(s: string, role: 'user' | 'assistant') {
        const increase = role === 'user' ? 1 : 0.1;
        const decrease = role === 'user' ? 0.1 : 0;
        const now = Math.floor(Date.now() / 1000);
        const sTokens = tokenizeForScore(s);  // M3: hoist 循环外

        for (const id in this.memoryMap) {
            const m = this.memoryMap[id];
            // O1.1: len>=2 守卫 + 子串+token 双通道（对全部关键词）；单字关键词（len<2）永不命中；中文 3+ 字词走子串兜底
            if (m.keywords.some(kw => kw.length >= 2 && (s.includes(kw) || sTokens.includes(kw)))) {
                m.weight = Math.min(10, m.weight + increase);
                m.lastMentionTime = now;
                // Y5: 知识库权重脏标记（仅 KnowledgeMemoryManager 实例；会话 AI 无此字段，instanceof 守卫跳过）
                if (this instanceof KnowledgeMemoryManager) (this as any)._weightsDirty = true;
            } else {
                // O1.2: 新记忆保护期——创建后 1 天内不衰减（时间保护与逐消息衰减错配的最小取舍，M4）
                if (now - m.createTime < 86400) continue;
                m.weight = Math.max(0, m.weight - decrease);
                if (this instanceof KnowledgeMemoryManager) (this as any)._weightsDirty = true;
            }
        }
    }

    updateRelatedMemoryWeight(ctx: seal.MsgContext, context: Context, s: string, role: 'user' | 'assistant') {
        // bot记忆权重更新
        AIManager.getAI(ctx.endPoint.userId).memory.updateMemoryWeight(s, role);
        // 知识库记忆权重更新
        knowledgeMM.updateMemoryWeight(s, role);
        // 会话自身记忆权重更新
        this.updateMemoryWeight(s, role);
        // 群内用户的记忆权重更新
        // P5: 只对已缓存实例执行，避免 create-on-read 生成僵尸 AI 实例永久驻留 cache（未缓存用户更新空 memoryMap 本就是 no-op）
        if (!ctx.isPrivate) context.userInfoList.forEach(ui => { const cached = AIManager.cache[ui.id]; if (cached) cached.memory.updateMemoryWeight(s, role); });
    }

    /** LLM 精排候选记忆（Phase 4 — 后处理步骤） */
    async llmRerank(query: string, candidates: Memory[], topK: number): Promise<Memory[]> {
        if (candidates.length === 0) return [];
        if (candidates.length <= 5) return candidates.slice(0, topK);

        const listText = candidates.map(function(m, i) { return i + '. [' + m.id + '] ' + m.text.slice(0, 100); }).join('\n');
        const prompt = '根据当前对话，评估以下记忆的相关度 (0-5分):\n当前对话: ' + query.slice(0, 200) + '\n\n记忆列表:\n' + listText + '\n\n返回 JSON: {"scores": {"id1": 4, "id2": 2, ...}}';

        try {
            const requestConfig = ConfigManager.request;
            const client = new AIClient({
                apiProvider: requestConfig.apiProvider,
                url: requestConfig.url,
                apiKey: requestConfig.apiKey,
                model: requestConfig.memoryModel,
                maxTokens: 256,
                timeout: 15000,
                thinkingEnabled: false,
                reasoningEffort: 'low',
                toolThinkingEnabled: false,
                toolReasoningEffort: 'minimal',
                extraBody: {},
            });

            const response = await client.chat(
                [{ role: 'user', content: prompt }],
                null, 'none',
            );

            const content = response.content || '{}';
            const scores = JSON.parse(content).scores || {};

            const result = candidates
                .map(function(m: any) {
                    // O2: 缺分回退 _baseScore（LLM 返回序号而非 id 或漏评时不再系统性淘汰）
                    const llmScore = scores[m.id] !== undefined ? scores[m.id] / 5 : (m._baseScore || 0);
                    const finalScore = 0.7 * llmScore + 0.3 * ((m._baseScore || 0));
                    (m as any)._finalScore = finalScore;
                    return m;
                })
                .filter(function(m: any) { return m._finalScore > 0.2; })
                .sort(function(a: any, b: any) { return b._finalScore - a._finalScore; })
                .slice(0, topK);
            // 返空兜底：过滤后为空时回退原排序（candidates 已按 base 降序，与 catch 分支一致）
            const finalResult = result.length > 0 ? result : candidates.slice(0, topK);
            logger.info('LLM 精排完成: 入参' + candidates.length + '条 → 返回' + finalResult.length + '条');
            return finalResult;
        } catch (e: any) {
            logger.error('LLM 精排失败: ' + (e?.message || e) + '，回退到 base_score');
            return candidates.slice(0, topK);
        }
    }

    /** 获取相关记忆（复合打分 + LLM 精排） */
    async getRelevantMemories(text: string, ui: UserInfo, gi: GroupInfo, topK: number, preFiltered?: Memory[]): Promise<Memory[]> {
        let candidates: Memory[];
        if (preFiltered) {
            // Use pre-filtered list — apply composite scoring directly
            candidates = MemoryManager.scoreCandidates(preFiltered, text, ui);
        } else {
            candidates = await this.search(text, {
                topK: 20,
                userList: ui ? [ui] : [],
                groupList: gi ? [gi] : [],
                keywords: [],
                includeImages: false,
                method: 'score'
            });
        }
        if (topK <= 5) return candidates.slice(0, topK);  // 少时不调精排
        return await this.llmRerank(text, candidates, topK);
    }

    /** 对候选记忆列表应用复合评分（静态方法，可被 search 复用） */
    private static scoreCandidates(candidates: Memory[], query: string, ui?: UserInfo): Memory[] {
        const now = Math.floor(Date.now() / 1000);
        const qTokens = tokenizeForScore(query);

        return candidates
            .map(m => {
                const kwScore = Math.max(
                    jaccardSimilarity(qTokens, tokenizeForScore(m.keywords.join(' '))),
                    jaccardSimilarity(qTokens, tokenizeForScore(m.text))
                );
                if (query.trim() && kwScore === 0) return null;
                const daysSinceCreate = (now - m.createTime) / 86400;
                const recency = Math.exp(-Math.log(2) * daysSinceCreate / 14);
                const importanceMap: { [key: number]: number } = { 1: 0.2, 3: 0.5, 5: 0.8 };
                const importanceScore = importanceMap[m.importance] || 0.5;
                const userMatch = ui ? (getCommonUser([ui], m.userList).length > 0 ? 1 : 0) : 0;
                const baseScore = calcBaseScore(kwScore, recency, importanceScore, userMatch);
                (m as any)._baseScore = baseScore;
                return m;
            })
            .filter((m: any) => m !== null && m._baseScore > 0.1)
            .sort((a: any, b: any) => b._baseScore - a._baseScore)
            .slice(0, 20);
    }

    getPOVFilteredMemories(currentScope: string, currentSessionId: string): Memory[] {
        return this.memoryList.filter(m => {
            // 预留分支：当前无写入方（addMemory 只产生 private/group），bot 记忆块恒空
            if (m.scope === 'universal') return true;
            if (m.scope === currentScope && m.sessionInfo.id === currentSessionId) return true;
            return false;
        });
    }

    /** 为指定用户更新印象（Tier 2）；rawMessages 可传调用方快照，异步期间新消息不受影响 */
    async updateImpression(uid: string, rawMessages?: string[]): Promise<boolean> {
      const obs = this.observations[uid];
      if (!obs) return false;
      const msgs = rawMessages || obs.rawMessages;
      if (msgs.length < 3) return false;

      const current = this.impressions[uid];
      const oldImpression = current?.text || '无';
      const now = Math.floor(Date.now() / 1000);

      const prompt = '你正在根据最近的观察，更新对某个群友的简短印象。\n当前印象: ' + oldImpression + '\n最近观察:\n' +
        msgs.map(function(m, i) { return (i + 1) + '. ' + m; }).join('\n') +
        '\n\n请用 ≤80 字更新印象。只描述性格特点、说话风格、行为习惯。不要描述具体事件。如果初次观察，给出初次印象。\n返回 JSON: {"impression": "印象文字"}';

      try {
        const requestConfig = ConfigManager.request;
        const client = new AIClient({
          apiProvider: requestConfig.apiProvider,
          url: requestConfig.url,
          apiKey: requestConfig.apiKey,
          model: requestConfig.memoryModel,
          maxTokens: 256,
          timeout: 30000,
          thinkingEnabled: false,
          reasoningEffort: 'low',
          toolThinkingEnabled: false,
          toolReasoningEffort: 'minimal',
          extraBody: {},
        });

        const response = await client.chat(
          [{ role: 'user', content: prompt }],
          null, 'none',
        );

        const content = response.content || '';
        const parsed = JSON.parse(content);
        if (parsed?.impression && typeof parsed.impression === 'string') {
          const maxLen = ConfigManager.memory.impressionMaxLength || 80;
          this.impressions[uid] = {
            text: parsed.impression.slice(0, maxLen),
            updatedAt: now
          };
          logger.info('印象更新: ' + uid + ' → ' + this.impressions[uid].text);
        }
        return true;
      } catch (e: any) {
        logger.error('印象更新失败 (' + uid + '): ' + (e?.message || e));
        return false;
      }
    }

    /** 基于当前 context 构建印象层提示文本 */
    buildImpressionPrompt(ctx: seal.MsgContext, context: Context): string {
      const lines: string[] = [];
      const seen = new Set<string>();

      for (const msg of context.messages) {
        if (msg.role !== 'user') continue;
        const uid = msg.uid;
        if (!uid || seen.has(uid)) continue;
        seen.add(uid);

        const imp = this.impressions[uid];
        if (!imp || !imp.text) continue;  // 空印象跳过

        const name = msg.name || '未知用户';
        lines.push(name + ': ' + imp.text);
      }

      return lines.join('\n');
    }

    /** 清理已退群 + 长期沉默用户的印象（每天 0 点，仅群聊） */
    async cleanupImpressions(ctx: seal.MsgContext, ai: AI): Promise<void> {
      if (ctx.isPrivate) return;

      const now = Math.floor(Date.now() / 1000);
      const inactiveDays = ConfigManager.memory.cleanupInactiveDays || 30;

      // 尝试获取当前群成员列表
      const memberIds = new Set<string>();
      let memberListFetched = false;
      try {
        const { getGroupMemberList } = require('../utils/utils_ob11');
        const { netExists } = require('../utils/utils_ob11');
        if (netExists()) {
          const gid = (ctx as any).group?.groupId?.replace(/^.+:/, '') || '';
          const members = await getGroupMemberList((ctx as any).endPoint?.userId, gid);
          if (members && Array.isArray(members)) {
            memberListFetched = true;
            for (const m of members) {
              memberIds.add('QQ:' + (m.user_id || ''));
            }
          }
        }
      } catch { /* 获取失败跳过 */ }

      for (const uid of Object.keys(this.observations)) {
        const obs = this.observations[uid];
        const silentDays = (now - obs.lastSpeak) / 86400;

        const notInGroup = memberListFetched && !memberIds.has(uid);
        if (notInGroup || silentDays > inactiveDays) {
          delete this.impressions[uid];
          delete this.observations[uid];
          logger.info('印象清理: ' + uid);
        }
      }
    }

    getLatestMemoryListText(si: SessionInfo, p: number = 1): string {
        if (this.memoryList.length === 0) return '';
        if (p > Math.ceil(this.memoryList.length / 5)) p = Math.ceil(this.memoryList.length / 5);
        const latestMemoryList = this.memoryList
            .sort((a, b) => b.createTime - a.createTime)
            .slice((p - 1) * 5, p * 5);
        return this.buildMemory(si, latestMemoryList) + `\n当前页码: ${p}/${Math.ceil(this.memoryList.length / 5)}`;
    }

    buildMemory(si: SessionInfo, ml: Memory[]): string {
        if (ml.length === 0) return '';
        const { showNumber } = ConfigManager.message;
        const { memoryShowTemplate, memorySingleShowTemplate } = ConfigManager.memory;

        let memoryContent = '';
        if (ml.length === 0) {
            memoryContent = '无';
        } else {
            memoryContent = ml
                .map((m, i) => {
                    return memorySingleShowTemplate({
                        "序号": i + 1,
                        "记忆ID": m.id,
                        "记忆时间": fmtDate(m.createTime, ConfigManager.message.utcOffset),
                        "个人记忆": si.isPrivate,
                        "私聊": m.sessionInfo.isPrivate,
                        "展示号码": showNumber,
                        "群聊名称": m.sessionInfo.name,
                        "群聊号码": m.sessionInfo.id,
                        "相关用户": m.userList.map(u => u.name + (showNumber ? `(${u.id.replace(/^.+:/, '')})` : '')).join(';'),
                        "相关群聊": m.groupList.map(g => g.name + (showNumber ? `(${g.id.replace(/^.+:/, '')})` : '')).join(';'),
                        "关键词": m.keywords.join(';'),
                        "记忆内容": m.text
                    });
                }).join('\n');
        }

        return memoryShowTemplate({
            "私聊": si.isPrivate,
            "展示号码": showNumber,
            "用户名称": si.name,
            "用户号码": si.id.replace(/^.+:/, ''),
            "群聊名称": si.name,
            "群聊号码": si.id.replace(/^.+:/, ''),
            "记忆列表": memoryContent
        }) + '\n';
    }

    async buildMemoryPrompt(ctx: seal.MsgContext, context: Context, text: string, ui: UserInfo, gi: GroupInfo): Promise<string> {
        const { memoryShowNumber } = ConfigManager.memory;
        const currentScope = ctx.isPrivate ? 'private' : 'group';
        const currentSessionId = ctx.isPrivate ? ctx.player.userId : ctx.group.groupId;

        // Bot's own memories (universal + matching scope)
        const botAI = AIManager.getAI(ctx.endPoint.userId);
        // POV filter: bot may have private + group memories; only inject relevant scope
        const botFiltered = botAI.memory.getPOVFilteredMemories(currentScope, currentSessionId);
        const scoredBot = await botAI.memory.getRelevantMemories(text, ui, gi, memoryShowNumber, botFiltered);
        let s = botAI.memory.buildMemory(
            { isPrivate: true, id: ctx.endPoint.userId, name: seal.formatTmpl(ctx, '核心:骰子名字') },
            scoredBot
        );

        if (ctx.isPrivate) {
            // Private chat: user's private memories (POV filtered)
            const userAI = AIManager.getAI(ctx.player.userId);
            const userFiltered = userAI.memory.getPOVFilteredMemories('private', ctx.player.userId);
            const scored = await userAI.memory.getRelevantMemories(text, ui, gi, memoryShowNumber, userFiltered);
            return s + userAI.memory.buildMemory(
                { isPrivate: true, id: ctx.player.userId, name: ctx.player.name },
                scored
            );
        } else {
            // Group chat: group memories ONLY. No per-user private memory injection!
            const groupAI = AIManager.getAI(ctx.group.groupId);
            const groupFiltered = groupAI.memory.getPOVFilteredMemories('group', ctx.group.groupId);
            const scored = await groupAI.memory.getRelevantMemories(text, ui, gi, memoryShowNumber, groupFiltered);
            return s + groupAI.memory.buildMemory(
                { isPrivate: false, id: ctx.group.groupId, name: ctx.group.groupName },
                scored
            );
        }
    }

    findImage(id: string): Image | null {
        for (const m of this.memoryList) {
            const image = m.images.find(img => img.id === id);
            if (image) {
                m.weight += 0.2;
                return image;
            }
        }
        return null;
    }

    findMemoryAndImageByImageIdPrefix(id: string): { memory: Memory, image: Image } | null {
        for (const m of this.memoryList) {
            const image = m.images.find(img => img.id.replace(/_\d+$/, "") === id);
            if (image) {
                m.weight += 0.2;
                return { memory: m, image };
            }
        }
        return null;
    }
}

export class KnowledgeMemoryManager extends MemoryManager {
    /** Y5: 上次成功解析的知识库文本哈希（运行时字段，不入存储；文本未变则跳过全量解析+写盘） */
    _lastParsedHash: string = '';
    /** Y5: 知识库记忆权重脏标记——updateMemoryWeight 实际变更时置位，save() 后清除（防 hash 缓存跳过写盘致权重漂移） */
    _weightsDirty: boolean = false;

    constructor() {
        super();
    }

    reviveMemoryMap() {
        // 知识库记忆不清空旧格式，保持原样存活
        for (const id in this.memoryMap) {
            this.memoryMap[id] = revive(Memory, this.memoryMap[id]);
            if (!this.memoryMap[id].text) {
                delete this.memoryMap[id];
                continue;
            }
            if (!this.memoryMap[id].hasOwnProperty('images')) this.memoryMap[id].images = [];
            this.memoryMap[id].images = this.memoryMap[id].images.map(image => revive(Image, image));
        }
    }

    init() {
        this.memoryMap = JSON.parse(ConfigManager.ext.storageGet('knowledgeMemoryMap') || '{}');
        this.reviveMemoryMap();
    }

    save() {
        ConfigManager.ext.storageSet('knowledgeMemoryMap', JSON.stringify(this.memoryMap));
    }

    async updateKnowledgeMemory(roleIndex: number) {
        const { knowledgeMemoryStringList } = ConfigManager.memory;
        if (roleIndex < 0 || roleIndex >= knowledgeMemoryStringList.length) return;
        const s = knowledgeMemoryStringList[roleIndex];
        if (!s) return;

        // Y5: 内容哈希缓存——文本未变则跳过全量解析与写盘（roleIndex 参与哈希，多知识库条目正确切换）
        const hash = djb2Hash(roleIndex + '\n' + s);
        if (this._lastParsedHash === hash) {
            if (this._weightsDirty) { this.save(); this._weightsDirty = false; }
            return;
        }

        const memoryMap: { [id: string]: Memory } = {}
        const segs = s.split(/\n-{3,}\n/);
        for (const seg of segs) {
            if (!seg.trim()) continue;

            const lines = seg.split('\n');
            if (lines.length === 0) continue;

            const m = new Memory();
            for (let i = 0; i < lines.length; i++) {
                const match = lines[i].match(/^\s*?(ID|用户|群聊|关键词|图片|内容)\s*?[:：](.*)/);
                if (!match) {
                    continue;
                }
                const type = match[1];
                const value = match[2].trim();
                switch (type) {
                    case 'ID': {
                        m.id = value;
                        break;
                    }
                    case '用户': {
                        m.userList = value.split(/[,，]/).map(s => {
                            const segs = s.split(/[:：]/).map(s => s.trim()).filter(s => s);
                            if (segs.length < 2) return null;
                            const name = segs[0];
                            const id = 'QQ:' + segs[segs.length - 1];
                            if (!name || !id) return null;
                            return { isPrivate: true, id, name };
                        }).filter(ui => ui) as UserInfo[];
                        break;
                    }
                    case '群聊': {
                        m.groupList = value.split(/[,，]/).map(s => {
                            const segs = s.split(/[:：]/).map(s => s.trim()).filter(s => s);
                            if (segs.length < 2) return null;
                            const name = segs[0];
                            const id = 'QQ-Group:' + segs[segs.length - 1];
                            if (!name || !id) return null;
                            return { isPrivate: false, id, name };
                        }).filter(ui => ui) as GroupInfo[];
                        break;
                    }
                    case '关键词': {
                        m.keywords = value.split(/[,，]/).map(kw => kw.trim()).filter(kw => kw);
                        break;
                    }
                    case '图片': {
                        const { localImagePathMap } = ConfigManager.image;

                        m.images = value.split(/[,，]/).map(id => id.trim()).map(id => {
                            if (localImagePathMap.hasOwnProperty(id)) {
                                const image = new Image();
                                image.file = localImagePathMap[id];
                                return image;
                            }
                            logger.error(`图片${id}不存在`);
                            return null;
                        }).filter(img => img);
                        break;
                    }
                    case '内容': {
                        m.text = lines.slice(i).join('\n').trim().replace(/^内容[:：]/, '');
                        break;
                    }
                    default: continue;
                }
            }

            if (!m.text) continue;
            if (!m.id) {
                // 无 ID 条目：内容哈希生成稳定 id（跨 rebuild 统计可保留，LLM 可引用）
                m.id = 'kb' + djb2Hash(m.text);
            }

            memoryMap[m.id] = m;
        }

        const now = Math.floor(Date.now() / 1000);
        Object.values(memoryMap).forEach(m => {
            if (this.memoryMap.hasOwnProperty(m.id)) {
                const m2 = this.memoryMap[m.id];
                m.createTime = m2.createTime;
                m.lastMentionTime = m2.lastMentionTime;
                m.weight = m2.weight;
            } else {
                m.createTime = now;
                m.lastMentionTime = now;
                m.weight = 5;
            }
        })

        this.memoryMap = memoryMap;
        this._lastParsedHash = hash;
        this._weightsDirty = false;
        this.save();
    }

    buildKnowledgeMemory(memoryList: Memory[]) {
        const { showNumber } = ConfigManager.message;
        const { knowledgeMemorySingleShowTemplate } = ConfigManager.memory;
        if (memoryList.length === 0) return '';

        let prompt = '';
        if (memoryList.length === 0) {
            prompt = '无';
        } else {
            prompt = memoryList
                .map((m, i) => {
                    return knowledgeMemorySingleShowTemplate({
                        "序号": i + 1,
                        "记忆ID": m.id,
                        "用户列表": m.userList.map(u => u.name + (showNumber ? `(${u.id.replace(/^.+:/, '')})` : '')).join(';'),
                        "群聊列表": m.groupList.map(g => g.name + (showNumber ? `(${g.id.replace(/^.+:/, '')})` : '')).join(';'),
                        "关键词": m.keywords.join(';'),
                        "记忆内容": m.text
                    });
                }).join('\n');
        }

        return prompt;
    }

    async buildKnowledgeMemoryPrompt(roleIndex: number, text: string, ui: UserInfo, gi: GroupInfo): Promise<string> {
        await this.updateKnowledgeMemory(roleIndex);
        if (this.memoryIds.length === 0) return '';

        const { knowledgeMemoryShowNumber } = ConfigManager.memory;
        const memoryList = await this.search(text, {
            topK: knowledgeMemoryShowNumber,
            userList: [],
            groupList: [],
            keywords: [],
            includeImages: false,
            method: 'score'
        });

        return this.buildKnowledgeMemory(memoryList);
    }
}

export const knowledgeMM = new KnowledgeMemoryManager();

// 可以通过维护一组索引来优化搜索性能。
// 好麻烦，不想弄
// 目前数量级应该没什么优化的需求