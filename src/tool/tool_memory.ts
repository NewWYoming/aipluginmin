import { AIManager, GroupInfo, SessionInfo, UserInfo } from "../AI/AI";
import { ConfigManager } from "../config/configManager";
import { logger } from "../logger";
import { getCtxAndMsg } from "../utils/utils_seal";
import { Tool } from "./tool";
import { generateMergeText, knowledgeMM, searchOptions as SearchOptions } from "../AI/memory";
import { UserNameManager } from "../AI/user_names";
import { getRoleSetting } from "../utils/utils_message";

export function registerMemory() {
    const toolAdd = new Tool({
        type: 'function',
        function: {
            name: 'add_memory',
            description: '添加一条长期记忆。当前对话是群聊则记忆自动关联当前群，当前对话是私聊则关联当前用户。尽量不要重复记忆。',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: '记忆关联的用户或群聊名称。群聊中填用户名称，私聊中填当前用户名称即可。'
                    },
                    text: {
                        type: 'string',
                        description: '记忆内容，尽量简短，可用<|img:xxxxxx|>插入图片，无需附带时间与来源'
                    },
                    importance: {
                        type: 'number',
                        enum: [1, 3, 5],
                        description: '记忆重要性: 5=核心事实（身份、重要偏好、明确要求记住的事），3=一般信息（值得记但非关键），1=琐碎（随口一提的闲聊）。默认3。',
                        default: 3
                    },
                    keywords: {
                        type: 'array',
                        description: '记忆关键词，用于后续检索匹配',
                        items: { type: 'string' }
                    },
                    about: {
                        type: 'array',
                        description: '记忆涉及的用户名称列表（可选）。仅填当前对话中可以通过上下文找得到的用户名。',
                        items: { type: 'string' }
                    },
                    groupList: {
                        type: 'array',
                        description: '相关群聊名称列表',
                        items: { type: 'string' }
                    }
                },
                required: ['name', 'text']
            }
        }
    });
    toolAdd.solve = async (ctx, msg, ai, args) => {
        const { name, text, importance, keywords = [], about = [], groupList = [] } = args;
        let targetAi = ai;

        if (!ctx.isPrivate) {
            // Group chat: always store in current group's AI
            targetAi = AIManager.getAI(ctx.group.groupId);
        }
        // Private chat: ai is already the current user's AI, no change needed

        // Resolve about list to UserInfo (for userList association)
        const uiList: UserInfo[] = [];
        // name 优先激活，about 按 id 去重
        if (name && name.trim()) {
            const nameUi = await ai.context.findUserInfo(ctx, name, true);
            if (nameUi !== null) uiList.push(nameUi);
        }
        for (const n of about) {
            const ui = await ai.context.findUserInfo(ctx, n, true);
            if (ui !== null && !uiList.some(u => u.id === ui.id)) uiList.push(ui);
        }
        // Resolve groupList
        const giList: GroupInfo[] = [];
        for (const n of groupList) {
            const gi = await ai.context.findGroupInfo(ctx, n);
            if (gi !== null) giList.push(gi);
        }

        await targetAi.memory.addMemory(ctx, targetAi, uiList, giList, Array.isArray(keywords) ? keywords : [], [], text, importance || 3);
        AIManager.saveAI(targetAi.id);
        return { content: `添加记忆成功`, images: [] };
    }

    const toolDel = new Tool({
        type: 'function',
        function: {
            name: 'del_memory',
            description: '删除个人记忆或群聊记忆',
            parameters: {
                type: 'object',
                properties: {
                    memory_type: {
                        type: "string",
                        description: "记忆类型，个人或群聊。",
                        enum: ["private", "group"]
                    },
                    name: {
                        type: 'string',
                        description: '用户名称或群聊名称' + (ConfigManager.message.showNumber ? '或纯数字QQ号、群号' : '') + '，实际使用时与记忆类型对应'
                    },
                    id_list: {
                        type: 'array',
                        description: '记忆ID列表（6位字母数字串，可从search_memory结果获取），可为空',
                        items: {
                            type: 'string'
                        }
                    },
                    keywords: {
                        type: 'array',
                        description: '记忆关键词，可为空',
                        items: {
                            type: 'string'
                        }
                    }
                },
                required: ['memory_type', 'name']
            }
        }
    });
    toolDel.solve = async (ctx, _, ai, args) => {
        const { memory_type, name, id_list, keywords } = args;

        if (memory_type === "private") {
            const ui = await ai.context.findUserInfo(ctx, name, true);
            if (ui === null) return { content: `未找到<${name}>`, images: [] };

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, ui.id, ''));
            ai = AIManager.getAI(ui.id);
        } else if (memory_type === "group") {
            const gi = await ai.context.findGroupInfo(ctx, name);
            if (gi === null) return { content: `未找到<${name}>`, images: [] };

            ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, '', gi.id));
            ai = AIManager.getAI(gi.id);
        } else {
            return { content: `未知的记忆类型<${memory_type}>`, images: [] };
        }

        //记忆相关处理
        const deleted = ai.memory.deleteMemory(id_list, keywords);
        logger.info(`LLM调用del_memory: AI=${ai.id}, ids=[${(id_list || []).join(',')}], keywords=[${(keywords || []).join(',')}], deleted=${deleted}`);
        AIManager.saveAI(ai.id);

        if (deleted > 0) return { content: `已删除${deleted}条记忆`, images: [] };
        return { content: `未找到匹配的记忆，请先用search_memory确认记忆ID`, images: [] };
    }

    const toolUpdate = new Tool({
        type: 'function',
        function: {
            name: 'update_memory',
            description: '按记忆ID更新既有长期记忆（整体替换语义：传入的字段即新值，不传的字段保持原样）。保留创建时间与权重，仅刷新提及时间。注意：你只能更新当前场景下的记忆，不能跨场景修改其他用户的记忆。',
            parameters: {
                type: 'object',
                properties: {
                    id_list: {
                        type: 'array',
                        description: '要更新的记忆ID列表（6位字母数字串，可从search_memory结果获取）',
                        items: { type: 'string' }
                    },
                    text: {
                        type: 'string',
                        description: '新的记忆内容，整体替换旧内容（尽量简短，可用<|img:xxxxxx|>插入图片，无需附带时间与来源）。不传则保持原样。'
                    },
                    keywords: {
                        type: 'array',
                        description: '新的记忆关键词列表，整体替换旧关键词。不传则保持原样。',
                        items: { type: 'string' }
                    },
                    importance: {
                        type: 'number',
                        enum: [1, 3, 5],
                        description: '记忆重要性: 5=核心事实（身份、重要偏好、明确要求记住的事），3=一般信息（值得记但非关键），1=琐碎（随口一提的闲聊）。不传则保持原样。'
                    },
                    about: {
                        type: 'array',
                        description: '新的相关用户名称列表，整体替换userList（仅填当前对话中可以通过上下文找得到的用户名）。不传则保持原样。',
                        items: { type: 'string' }
                    }
                },
                required: ['id_list']
            }
        }
    });
    toolUpdate.solve = async (ctx, _, ai, args) => {
        const { id_list = [], text, keywords, importance, about = [] } = args;
        if (id_list.length === 0) return { content: '参数缺失：需提供 id_list', images: [] };

        // findUserInfo 是 async，必须 await Promise.all 并行解析
        const uiList = (await Promise.all(about.map(n => ai.context.findUserInfo(ctx, n, true)))).filter(ui => ui !== null);

        let updated = 0;
        for (const id of id_list) {
            const m = ai.memory.memoryMap[id];
            if (!m) continue;
            if (text !== undefined) m.text = text;  // 整体替换语义（用户确认）
            if (keywords !== undefined && Array.isArray(keywords)) m.keywords = keywords;
            if (importance !== undefined) m.importance = [1, 3, 5].includes(importance) ? importance : (importance >= 3 ? 5 : 1);  // 越界收拢到 1|3|5
            if (uiList.length > 0) m.userList = uiList;  // about 传了才替换；查无结果不清空
            m.lastMentionTime = Math.floor(Date.now() / 1000);  // 刷新保鲜；weight 不动
            updated++;
        }
        if (updated > 0) AIManager.saveAI(ai.id);
        return { content: updated > 0 ? `已更新 ${updated} 条记忆` : '未找到匹配的记忆，请先用 search_memory 确认记忆 ID', images: [] };
    }

    const toolMerge = new Tool({
        type: 'function',
        function: {
            name: 'merge_memory',
            description: '合并2-5条重复或高度重叠的长期记忆为一条（LLM 生成合并内容；合并失败不删除任何记忆）。注意：你只能合并当前场景下的记忆，不能跨场景操作其他用户的记忆。',
            parameters: {
                type: 'object',
                properties: {
                    id_list: {
                        type: 'array',
                        description: '要合并的记忆ID列表（至少2条、最多5条，6位字母数字串，可从search_memory结果获取）',
                        items: { type: 'string' }
                    }
                },
                required: ['id_list']
            }
        }
    });
    toolMerge.solve = async (ctx, _, ai, args) => {
        const { id_list = [] } = args;
        // 先按 id 去重再取记忆——重复 id（如 [A, A, B]）会让同一对象出现多次，slice(1) 的 restIds 会含基准 id 导致合并时基准被误删
        const memories = [...new Set(id_list)].map(id => ai.memory.memoryMap[id]).filter(m => m);
        if (memories.length < 2) return { content: '需至少 2 条有效记忆', images: [] };
        let truncated = false;
        if (memories.length > 5) { memories.length = 5; truncated = true; }  // 截断防护

        logger.info(`LLM调用merge_memory: AI=${ai.id}, ids=[${memories.map(m => m.id).join(',')}]`);
        const merged = await generateMergeText(memories);
        if (!merged) return { content: '合并失败，记忆未改动', images: [] };

        const result = ai.memory.mergeMemories(memories, merged.text, merged.keywords);
        AIManager.saveAI(ai.id);
        logger.info(`记忆已合并: ${memories.length}条 → ${result.id}`);
        return { content: `已合并 ${memories.length} 条记忆 → ${result.id}` + (truncated ? '（仅合并前 5 条，其余忽略）' : ''), images: [] };
    }

    const toolSearch = new Tool({
        type: 'function',
        function: {
            name: 'search_memory',
            description: '搜索长期记忆或知识库。当前对话是群聊则自动搜索当前群的长期记忆，当前对话是私聊则搜索当前用户的长期记忆。注意：你只能搜索当前场景下的记忆，不能跨场景查阅其他用户的私人记忆。',
            parameters: {
                type: 'object',
                properties: {
                    target: {
                        type: 'string',
                        enum: ['memory', 'knowledge'],
                        description: '搜索目标: memory=长期记忆, knowledge=知识库。默认 memory。知识库由骰主预先设置。',
                        default: 'memory'
                    },
                    name: {
                        type: 'string',
                        description: '用户或群聊名称，仅搜索长期记忆时使用。群聊中填用户名称，私聊中填当前用户名称，不填则搜索所有记忆。'
                    },
                    query: {
                        type: 'string',
                        description: '搜索查询词，为空时返回最近的记忆'
                    },
                    topK: {
                        type: 'number',
                        description: '返回记忆条数，默认5条'
                    },
                    keywords: {
                        type: 'array',
                        description: '记忆关键词过滤',
                        items: { type: 'string' }
                    },
                    userList: {
                        type: 'array',
                        description: '相关用户名称列表',
                        items: { type: 'string' }
                    },
                    groupList: {
                        type: 'array',
                        description: '相关群聊名称列表',
                        items: { type: 'string' }
                    },
                    includeImages: {
                        type: 'boolean',
                        description: '是否包含图片'
                    },
                    method: {
                        type: 'string',
                        description: '搜索方法，默认score（复合打分）',
                        enum: ['weight', 'score', 'early', 'late', 'recent']
                    }
                },
                required: []
            }
        }
    });
    toolSearch.solve = async (ctx, _, ai, args) => {
        const { target = 'memory', name = '', query = '', topK = 5, keywords = [], userList = [], groupList = [], includeImages = false, method = 'score' } = args;

        // Knowledge path: not scope-restricted (admin-defined global data)
        if (target === 'knowledge') {
            const options: SearchOptions = { topK, keywords, userList: [], groupList: [], includeImages, method };
            const { roleIndex } = getRoleSetting(ctx);
            await knowledgeMM.updateKnowledgeMemory(roleIndex);
            if (knowledgeMM.memoryIds.length === 0) return { content: `暂无知识库记忆`, images: [] };
            const memoryList = await knowledgeMM.search(query, options);
            const images = Array.from(new Set([].concat(...memoryList.map(m => m.images))));
            return { content: knowledgeMM.buildKnowledgeMemory(memoryList, UserNameManager.scopeFromContext(ctx)) || '暂无知识库记忆', images };
        }

        // Memory path: scope enforced by context
        let targetAi = ai;
        let si: SessionInfo = { isPrivate: false, id: '', name: '' };
        if (!ctx.isPrivate) {
            // Group chat → only search current group's memories
            targetAi = AIManager.getAI(ctx.group.groupId);
            si = { isPrivate: false, id: ctx.group.groupId, name: ctx.group.groupName };
        } else {
            // Private chat → only search current user's memories
            si = { isPrivate: true, id: ctx.player.userId, name: ctx.player.name };
        }

        if (targetAi.memory.memoryIds.length === 0) return { content: `暂无记忆`, images: [] };

        const uiList: UserInfo[] = [];
        // name 优先激活，userList 按 id 去重
        if (name && name.trim()) {
            const nameUi = await ai.context.findUserInfo(ctx, name, true);
            if (nameUi !== null) uiList.push(nameUi);
        }
        for (const n of userList) {
            const ui = await ai.context.findUserInfo(ctx, n, true);
            if (ui !== null && !uiList.some(u => u.id === ui.id)) uiList.push(ui);
        }

        const options: SearchOptions = { topK, keywords, userList: uiList, groupList: [], includeImages, method, hardUserFilter: (userList.length > 0 || name.length > 0) };
        const memoryList = await targetAi.memory.search(query, options);
        logger.info(`LLM调用search_memory: scope=${ctx.isPrivate ? 'private' : 'group'}, query="${query}", topK=${topK}, 结果=${memoryList.length}条`);
        const images = Array.from(new Set([].concat(...memoryList.map(m => m.images))));
        return { content: targetAi.memory.buildMemory(si, memoryList, UserNameManager.scopeFromContext(ctx)) || '暂无记忆', images };
    }

    const toolClear = new Tool({
        type: 'function',
        function: {
            name: 'clear_memory',
            description: '清除长期记忆。当前对话是群聊则清除当前群的长期记忆，当前对话是私聊则清除当前用户的长期记忆。注意：你只能清除当前场景下的记忆，不能跨场景删除其他用户的记忆。',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        }
    });
    toolClear.solve = async (ctx, _, ai, _args) => {
        let targetAi = ai;

        if (!ctx.isPrivate) {
            targetAi = AIManager.getAI(ctx.group.groupId);
        }
        // Private chat: ai is already the current user's AI

        targetAi.memory.clearMemory();
        logger.info(`LLM调用clear_memory: AI=${targetAi.id}`);
        AIManager.saveAI(targetAi.id);
        return { content: `清除记忆成功`, images: [] };
    }
}
