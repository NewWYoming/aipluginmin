import { AIManager } from "../../AI/AI";
import { ConfigManager } from "../../config/configManager";
import { aliasToCmd } from "../../utils/utils";
import { I, S, U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root";

interface MemoryScopeConfig {
    ai: any;
    saveId: string;
    isPrivate: boolean;
    scopePrefix: string;
    sessionInfoId: string;
    sessionInfoName: string;
}

async function handleMemoryScope(
    ctx: seal.MsgContext,
    msg: seal.Message,
    cmdArgs: seal.CmdArgs,
    ret: seal.CmdExecuteResult,
    page: number,
    cfg: MemoryScopeConfig
): Promise<seal.CmdExecuteResult> {
    const val3 = cmdArgs.getArgN(3);
    switch (aliasToCmd(val3)) {
        case 'delete': {
            const idList = cmdArgs.args.slice(3);
            const kw = cmdArgs.kwargs.map(item => item.name);
            if (idList.length === 0 && kw.length === 0) {
                seal.replyToSender(ctx, msg, `参数缺失，【.ai memo ${cfg.scopePrefix} del <ID1> <ID2> --关键词1 --关键词2】删除${cfg.isPrivate ? '个人' : '群聊'}记忆`);
                return ret;
            }
            cfg.ai.memory.deleteMemory(idList, kw);
            seal.replyToSender(ctx, msg, cfg.ai.memory.getLatestMemoryListText({
                isPrivate: cfg.isPrivate,
                id: cfg.sessionInfoId,
                name: cfg.sessionInfoName
            }, page) || '记忆已全部清除');
            AIManager.saveAI(cfg.saveId);
            return ret;
        }
        case 'list': {
            seal.replyToSender(ctx, msg, cfg.ai.memory.getLatestMemoryListText({
                isPrivate: cfg.isPrivate,
                id: cfg.sessionInfoId,
                name: cfg.sessionInfoName
            }, page) || '无记忆');
            return ret;
        }
        case 'tidy': {
            const result = await cfg.ai.memory.tidyMemories(true);
            if (result === 1) AIManager.saveAI(cfg.saveId);   // M2: 命令路径也 save
            seal.replyToSender(ctx, msg, result === 1 ? '记忆整理完成' : result === 2 ? '记忆整理失败，已记录日志' : '今日已整理过，明天再试');
            return ret;
        }
        default: {
            seal.replyToSender(ctx, msg, `参数缺失:\n` +
                `【.ai memo ${cfg.scopePrefix} del <ID1> <ID2> --关键词1 --关键词2】删除${cfg.isPrivate ? '个人' : '群聊'}记忆\n` +
                `【.ai memo ${cfg.scopePrefix} list】展示${cfg.isPrivate ? '个人' : '群聊'}记忆\n` +
                `【.ai memo ${cfg.scopePrefix} tidy】整理记忆（每日限一次）`);
            return ret;
        }
    }
}

export function registerCmdMemory() {
    const cmd = new SubCmd('memory');
    cmd.desc = '记忆相关操作';
    cmd.help = '';
    cmd.priv = {
        priv: U, args: {
            status: { priv: U },
            private: {
                priv: U, args: {
                    delete: { priv: U },
                    list: { priv: U },
                    tidy: { priv: I }
                }
            },
            group: {
                priv: I, args: {
                    delete: { priv: U },
                    list: { priv: U },
                    tidy: { priv: I }
                }
            },
        }
    };
    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, epId, sid, ai, page, ret } = scc;

        const mctx = seal.getCtxProxyFirst(ctx, cmdArgs);
        const muid = mctx.player.userId;

        const ai2 = AIManager.getAI(muid);
        const val2 = cmdArgs.getArgN(2);
        switch (aliasToCmd(val2)) {
            case 'status': {
                let ai3 = ai;
                if (cmdArgs.at.length > 0 && (cmdArgs.at.length !== 1 || cmdArgs.at[0].userId !== epId)) {
                    ai3 = ai2;
                }
                const { isMemory } = ConfigManager.memory;
                seal.replyToSender(ctx, msg, `${ai3.id}\n` +
                    `长期记忆开启状态: ${isMemory ? '是' : '否'}\n` +
                    `长期记忆条数: ${ai3.memory.memoryIds.length}\n` +
                    `关键词库: ${ai3.memory.keywords.join('、') || '无'}`);
                return ret;
            }
            case 'private': {
                return handleMemoryScope(ctx, msg, cmdArgs, ret, page, {
                    ai: ai2,
                    saveId: muid,
                    isPrivate: true,
                    scopePrefix: 'p',
                    sessionInfoId: mctx.player.userId,
                    sessionInfoName: mctx.player.name,
                });
            }
            case 'group': {
                if (ctx.isPrivate) {
                    seal.replyToSender(ctx, msg, '群聊记忆仅在群聊可用');
                    return ret;
                }
                return handleMemoryScope(ctx, msg, cmdArgs, ret, page, {
                    ai: ai,
                    saveId: sid,
                    isPrivate: false,
                    scopePrefix: 'g',
                    sessionInfoId: ctx.group.groupId,
                    sessionInfoName: ctx.group.groupName,
                });
            }
            
            default: {
                seal.replyToSender(ctx, msg, `帮助:\n` +
                    `【.ai memo status (@xxx)】查看记忆状态，@为查看个人记忆状态\n` +
                    `【.ai memo [p/g] del <ID1> <ID2> --关键词1 --关键词2】删除个人/群聊记忆\n` +
                    `【.ai memo [p/g] list】展示个人/群聊记忆\n` +
                    `【.ai memo [p/g] tidy】整理记忆（每日限一次）`);
                return ret;
            }
        }
    }
}