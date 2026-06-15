import { ConfigManager } from "../config/configManager";
import { AI, AIManager, GroupInfo, SessionInfo, UserInfo } from "./AI";
import { Context } from "./context";
import { generateId, getCommonGroup, getCommonKeyword, getCommonUser, revive } from "../utils/utils";
import { AIClient } from "../service/AIClient";
import { logger } from "../logger";
import { fmtDate } from "../utils/utils_string";
import { Image, ImageManager } from "./image";

export interface searchOptions {
    topK: number;
    userList: UserInfo[];
    groupList: GroupInfo[];
    keywords: string[];
    includeImages: boolean;
    method: 'weight' | 'score' | 'early' | 'late' | 'recent';
}

export class Memory {
    static validKeys: (keyof Memory)[] = ['id', 'text', 'sessionInfo', 'userList', 'groupList', 'createTime', 'lastMentionTime', 'keywords', 'weight', 'images', 'scope', 'witnesses', 'importance'];
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
    witnesses: string[];
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
        this.witnesses = [];
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
        m.witnesses = [...this.witnesses];
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

    /**
     * 计算记忆与查询的相似度分数
     * @param ul 查询用户列表
     * @param gl 查询群组列表
     * @param kws 查询关键词列表
     * @returns 相似度分数（0-1）
     */
    calculateSimilarity(ul: UserInfo[], gl: GroupInfo[], kws: string[]): number {
        // 总权重
        const totalWeight = (ul.length ? 0.2 : 0) + (gl.length ? 0.2 : 0) + (kws.length ? 0.2 : 0);
        if (totalWeight === 0) return 0;
        // 用户相似度分数 0-1
        const commonUser = getCommonUser(this.userList, ul);
        const userSimilarity = (ul && ul.length > 0) ? commonUser.length / (this.userList.length + ul.length - commonUser.length) : 0;
        // 群组相似度分数 0-1
        const commonGroup = getCommonGroup(this.groupList, gl);
        const groupSimilarity = (gl && gl.length > 0) ? commonGroup.length / (this.groupList.length + gl.length - commonGroup.length) : 0;
        // 关键词匹配分数 0-1
        const commonKeyword = getCommonKeyword(this.keywords, kws);
        const keywordSimilarity = (kws && kws.length > 0) ? commonKeyword.length / kws.length : 0;
        // 综合相似度分数 0-1
        const avgSimilarity = userSimilarity * 0.2 + groupSimilarity * 0.2 + keywordSimilarity * 0.2;
        // 相似度增强因子 0-1
        return avgSimilarity / totalWeight;
    }

    /**
     * 计算记忆的最终分数
     * @param ul 查询用户列表
     * @param gl 查询群组列表
     * @param kws 查询关键词列表
     * @returns 相似度分数（0-1）
     */
    calculateScore(ul: UserInfo[], gl: GroupInfo[], kws: string[]): number {
        return this.weight * 0.03 + this.calculateSimilarity(ul, gl, kws) * 0.7;
    }

}

export interface UserObservation {
  rawMessages: string[];
  msgCount: number;
  lastSpeak: number;
}

export interface Impression {
  text: string;
  updatedAt: number;
}

export class MemoryManager {
    static validKeys: (keyof MemoryManager)[] = ['persona', 'memoryMap', 'impressions', 'observations'];
    persona: string;
    memoryMap: { [id: string]: Memory };
    impressions: { [userId: string]: Impression };
    observations: { [userId: string]: UserObservation };

    constructor() {
        this.persona = '无';
        this.memoryMap = {};
        this.impressions = {};
        this.observations = {};
    }

    reviveMemoryMap() {
        // 检测旧格式记忆（无 scope 字段）——直接清空
        let hasOldFormat = false;
        for (const id in this.memoryMap) {
            const m = this.memoryMap[id] as any;
            if (!m.hasOwnProperty('scope')) {
                hasOldFormat = true;
                break;
            }
        }
        if (hasOldFormat) {
            this.memoryMap = {};
            (this as any)._needsSave = true;
            logger.info('检测到旧格式记忆（无 scope 字段），已清空。新记忆将使用新格式。');
            return;
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

        for (const id of this.memoryIds) {
            const m = this.memoryMap[id];
            if (text === m.text && m.sessionInfo.id === ai.id && getCommonUser(ul, m.userList).length > 0 && getCommonGroup(gl, m.groupList).length > 0) {
                m.keywords = Array.from(new Set([...m.keywords, ...kws]));
                logger.info(`记忆已存在，id:${id}，合并关键词:${m.keywords.join(',')}`);
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

    deleteMemory(ids: string[] = [], kws: string[] = []) {
        if (ids.length === 0 && kws.length === 0) return;

        ids.forEach(id => delete this.memoryMap?.[id])

        if (kws.length > 0) {
            for (const id in this.memoryMap) {
                if (kws.some(kw => this.memoryMap[id].keywords.includes(kw))) {
                    delete this.memoryMap[id];
                }
            }
        }
        logger.info(`记忆已删除: ids=[${ids.join(',')}], keywords=[${kws.join(',')}]`);
    }

    limitMemory() {
        const { memoryLimit } = ConfigManager.memory;
        const limit = memoryLimit > 0 ? memoryLimit - 1 : 0; // 预留1个位置用于存储最新记忆
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
        const { userList: ul, groupList: gl, keywords: kws, includeImages, method } = options;

        // Helper: Jaccard similarity
        const jaccard = function(a: string[], b: string[]): number {
            const setA = new Set(a), setB = new Set(b);
            const intersection = [...setA].filter(function(x) { return setB.has(x); }).length;
            const union = new Set([...setA, ...setB]).size;
            return union === 0 ? 0 : intersection / union;
        };
        const tokenize = function(s: string): string[] {
            return s.split(/[\s,，。！？、；：""'']+/).filter(function(t) { return t.length > 0; });
        };
        const now = Math.floor(Date.now() / 1000);

        return this.memoryList
            .map(function(m) {
                if (includeImages && m.images.length === 0) return null;
                const mc = m.copy;

                // Composite pre-score
                const kwJaccard = jaccard(tokenize(query), mc.keywords);
                const daysSinceCreate = (now - mc.createTime) / 86400;
                const recency = Math.exp(-Math.log(2) * daysSinceCreate / 14);
                const importanceMap: { [key: number]: number } = { 1: 0.2, 3: 0.5, 5: 0.8 };
                const importanceScore = importanceMap[mc.importance] || 0.5;
                const baseScore = 0.50 * kwJaccard + 0.30 * recency + 0.20 * importanceScore;

                (mc as any)._baseScore = baseScore;
                return mc;
            })
            .filter(function(m) { return m !== null; })
            .filter(function(m: any) { return m._baseScore > 0.1; })
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

        for (const id in this.memoryMap) {
            const m = this.memoryMap[id];
            if (m.keywords.some(kw => s.includes(kw))) {
                m.weight = Math.min(10, m.weight + increase);
                m.lastMentionTime = now;
            } else {
                m.weight = Math.max(0, m.weight - decrease);
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
        if (!ctx.isPrivate) context.userInfoList.forEach(ui => AIManager.getAI(ui.id).memory.updateMemoryWeight(s, role));
    }

    async getTopScoreMemoryList(text: string = '', ui: UserInfo = null, gi: GroupInfo = null, preFiltered?: Memory[]) {
        const { memoryShowNumber } = ConfigManager.memory;
        if (preFiltered) {
            return this.scoreAndSlice(preFiltered, text, ui, gi, memoryShowNumber);
        }
        return await this.search(text, {
            topK: memoryShowNumber,
            userList: ui ? [ui] : [],
            groupList: gi ? [gi] : [],
            keywords: [],
            includeImages: false,
            method: 'score'
        });
    }

    private scoreAndSlice(candidates: Memory[], text: string, ui: UserInfo, gi: GroupInfo, topK: number): Memory[] {
        return candidates
            .sort((a, b) => b.calculateScore(ui ? [ui] : [], gi ? [gi] : [], []) - a.calculateScore([], ui ? [ui] : [], gi ? [gi] : [], []))
            .slice(0, topK);
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

            return candidates
                .map(function(m: any) {
                    const llmScore = (scores[m.id] || 0) / 5;
                    const finalScore = 0.7 * llmScore + 0.3 * ((m._baseScore || 0));
                    (m as any)._finalScore = finalScore;
                    return m;
                })
                .filter(function(m: any) { return m._finalScore > 0.2; })
                .sort(function(a: any, b: any) { return b._finalScore - a._finalScore; })
                .slice(0, topK);
            logger.info('LLM 精排完成: 入参' + candidates.length + '条 → 返回' + Math.min(topK, candidates.length) + '条');
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
            candidates = MemoryManager.scoreCandidates(preFiltered, text);
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
    private static scoreCandidates(candidates: Memory[], query: string): Memory[] {
        const jaccard = (a: string[], b: string[]): number => {
            const setA = new Set(a), setB = new Set(b);
            const intersection = [...setA].filter(x => setB.has(x)).length;
            const union = new Set([...setA, ...setB]).size;
            return union === 0 ? 0 : intersection / union;
        };
        const tokenize = (s: string): string[] =>
            s.split(/[\s,，。！？、；：""'']+/).filter(t => t.length > 0);
        const now = Math.floor(Date.now() / 1000);

        return candidates
            .map(m => {
                const kwJaccard = jaccard(tokenize(query), m.keywords);
                const daysSinceCreate = (now - m.createTime) / 86400;
                const recency = Math.exp(-Math.log(2) * daysSinceCreate / 14);
                const importanceMap: { [key: number]: number } = { 1: 0.2, 3: 0.5, 5: 0.8 };
                const baseScore = 0.50 * kwJaccard + 0.30 * recency + 0.20 * (importanceMap[m.importance] || 0.5);
                (m as any)._baseScore = baseScore;
                return m;
            })
            .filter((m: any) => m._baseScore > 0.1)
            .sort((a: any, b: any) => b._baseScore - a._baseScore)
            .slice(0, 20);
    }

    getPOVFilteredMemories(currentScope: string, currentSessionId: string): Memory[] {
        return this.memoryList.filter(m => {
            if (m.scope === 'universal') return true;
            if (m.scope === currentScope && m.sessionInfo.id === currentSessionId) return true;
            return false;
        });
    }

    /** 为指定用户更新印象（Tier 2） */
    async updateImpression(uid: string): Promise<void> {
      const obs = this.observations[uid];
      if (!obs || obs.rawMessages.length < 3) return;

      const current = this.impressions[uid];
      const oldImpression = current?.text || '无';
      const now = Math.floor(Date.now() / 1000);

      const prompt = '你正在根据最近的观察，更新对某个群友的简短印象。\n当前印象: ' + oldImpression + '\n最近观察:\n' +
        obs.rawMessages.map(function(m, i) { return (i + 1) + '. ' + m; }).join('\n') +
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
          [{ role: 'user', content: prompt + '\n返回 JSON: {"impression": "印象文字"}' }],
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
      } catch (e: any) {
        logger.error('印象更新失败 (' + uid + '): ' + (e?.message || e));
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
        if (this.persona === '无' && ml.length === 0) return '';
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
            "设定": this.persona,
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
                            const name = value.replace(/[:：].*$/, '').trim();
                            const id = segs[segs.length - 1];
                            if (!name || !id) return null;
                            return { isPrivate: true, id, name };
                        }).filter(ui => ui) as UserInfo[];
                        break;
                    }
                    case '群聊': {
                        m.groupList = value.split(/[,，]/).map(s => {
                            const segs = s.split(/[:：]/).map(s => s.trim()).filter(s => s);
                            if (segs.length < 2) return null;
                            const name = value.replace(/[:：].*$/, '').trim();
                            const id = segs[segs.length - 1];
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

            if (!m.id && !m.text) continue;

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
            userList: ui ? [ui] : [],
            groupList: gi ? [gi] : [],
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