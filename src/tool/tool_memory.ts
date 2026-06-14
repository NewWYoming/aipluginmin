import { AIManager, GroupInfo, SessionInfo, UserInfo } from "../AI/AI";
import { ConfigManager } from "../config/configManager";
import { getCtxAndMsg } from "../utils/utils_seal";
import { Tool } from "./tool";
import { knowledgeMM, searchOptions as SearchOptions } from "../AI/memory";
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
        for (const n of about) {
            const ui = await ai.context.findUserInfo(ctx, n, true);
            if (ui !== null) uiList.push(ui);
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
                        description: '记忆ID列表，可为空',
                        items: {
                            type: 'integer'
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
                required: ['memory_type', 'name', 'id_list', 'keywords']
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
        ai.memory.deleteMemory(id_list, keywords);
        logger.info(`LLM调用del_memory: AI=${ai.id}, ids=[${id_list.join(',')}], keywords=[${keywords.join(',')}]`);
        AIManager.saveAI(ai.id);

        return { content: `删除记忆成功`, images: [] };
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
            const giList: GroupInfo[] = [];
            for (const n of groupList) {
                const gi = await ai.context.findGroupInfo(ctx, n);
                if (gi !== null) giList.push(gi);
            }
            const options: SearchOptions = { topK, keywords, userList, groupList, includeImages, method };
            const { roleIndex } = getRoleSetting(ctx);
            await knowledgeMM.updateKnowledgeMemory(roleIndex);
            if (knowledgeMM.memoryIds.length === 0) return { content: `暂无知识库记忆`, images: [] };
            const memoryList = await knowledgeMM.search(query, options);
            const images = Array.from(new Set([].concat(...memoryList.map(m => m.images))));
            return { content: knowledgeMM.buildKnowledgeMemory(memoryList) || '暂无知识库记忆', images };
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
        for (const n of userList) {
            const ui = await ai.context.findUserInfo(ctx, n, true);
            if (ui !== null) uiList.push(ui);
        }
        const giList: GroupInfo[] = [];
        for (const n of groupList) {
            const gi = await ai.context.findGroupInfo(ctx, n);
            if (gi !== null) giList.push(gi);
        }

        const options: SearchOptions = { topK, keywords, userList, groupList, includeImages, method };
        const memoryList = await targetAi.memory.search(query, options);
        logger.info(`LLM调用search_memory: scope=${ctx.isPrivate ? 'private' : 'group'}, query="${query}", topK=${topK}, 结果=${memoryList.length}条`);
        const images = Array.from(new Set([].concat(...memoryList.map(m => m.images))));
        return { content: targetAi.memory.buildMemory(si, memoryList) || '暂无记忆', images };
    }

    const toolClear = new Tool({
        type: 'function',
        function: {
            name: 'clear_memory',
            description: '清除长期记忆。当前对话是群聊则清除当前群的长期记忆，当前对话是私聊则清除当前用户的长期记忆。注意：你只能清除当前场景下的记忆，不能跨场景删除其他用户的记忆。',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: '确认要清除的群聊或用户名称。群聊中填群聊名称，私聊中填用户名称。'
                    }
                },
                required: ['name']
            }
        }
    });
    toolClear.solve = async (ctx, _, ai, args) => {
        const { name } = args;
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