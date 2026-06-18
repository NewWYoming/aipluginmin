import { AIManager } from '../../AI/AI';
import { aliasToCmd } from '../../utils/utils';
import { M, U } from '../privilege';
import { SubCmd, SubCmdContext } from '../root';

/** 从位置参数解析 QQ 号：纯数字加前缀，已含 QQ: 直接返回 */
function parseQQFromArg(arg: string): string | null {
  if (!arg) return null;
  if (/^QQ:\d{5,}$/.test(arg)) return arg;
  if (/^\d{5,}$/.test(arg)) return `QQ:${arg}`;
  return null;
}

export function registerCmdImpression(): void {
  const cmd = new SubCmd('impression');
  cmd.desc = '查看用户印象';
  cmd.priv = { priv: U, args: { all: { priv: M } } };
  cmd.help = `【.ai impression】查看当前会话中自己的印象
【.ai impression @用户 或 QQ号】查看指定用户的印象
【.ai impression all @用户 或 QQ号】跨群查看某用户在所有群组的印象（骰主）`;
  cmd.solve = (scc: SubCmdContext) => {
    const { ctx, msg, cmdArgs, epId, ai, ret } = scc;
    const val2 = cmdArgs.getArgN(2);

    switch (aliasToCmd(val2)) {
      case 'all': {
        // 跨群搜索 —— 需要骰主权限
        const val3 = cmdArgs.getArgN(3);
        const targetUid = resolveTargetUid(cmdArgs, epId, ctx, val3);
        if (!targetUid) {
          seal.replyToSender(ctx, msg, '请@一个用户或提供QQ号以查看其跨群印象');
          return ret;
        }
        return showCrossImpressions(ctx, msg, targetUid, ret);
      }
      default: {
        // 默认：查看当前会话中某用户的印象
        const targetUid = resolveTargetUid(cmdArgs, epId, ctx, val2) || scc.uid;
        return showImpression(ctx, msg, ai, targetUid, ret);
      }
    }
  };
}

/** 解析目标用户 ID：@ > QQ号 > null */
function resolveTargetUid(
  cmdArgs: seal.CmdArgs,
  epId: string,
  ctx: seal.MsgContext,
  arg: string
): string | null {
  if (cmdArgs.at.length === 1 && cmdArgs.at[0].userId !== epId) {
    return cmdArgs.at[0].userId;
  }
  if (cmdArgs.at.length > 0) {
    const mctx = seal.getCtxProxyFirst(ctx, cmdArgs);
    return mctx.player.userId;
  }
  return parseQQFromArg(arg);
}

function showImpression(
  ctx: seal.MsgContext,
  msg: seal.Message,
  ai: ReturnType<typeof AIManager.getAI>,
  targetUid: string,
  ret: seal.CmdExecuteResult
): seal.CmdExecuteResult {
  const imp = ai.memory.impressions[targetUid];
  if (!imp) {
    seal.replyToSender(ctx, msg, `未找到用户 ${targetUid} 的印象`);
    return ret;
  }
  const daysAgo = Math.floor((Date.now() / 1000 - imp.updatedAt) / 86400);
  seal.replyToSender(ctx, msg,
    `用户: ${targetUid}\n` +
    `印象: ${imp.text}\n` +
    `更新于: ${daysAgo} 天前`
  );
  return ret;
}

function showCrossImpressions(
  ctx: seal.MsgContext,
  msg: seal.Message,
  targetUid: string,
  ret: seal.CmdExecuteResult
): seal.CmdExecuteResult {
  const results: { id: string; text: string; updatedAt: number }[] = [];
  for (const id in AIManager.cache) {
    const ai = AIManager.cache[id];
    const imp = ai?.memory?.impressions?.[targetUid];
    if (imp) {
      results.push({ id, text: imp.text, updatedAt: imp.updatedAt });
    }
  }
  if (results.length === 0) {
    seal.replyToSender(ctx, msg, `未在任何群组中找到用户 ${targetUid} 的印象`);
    return ret;
  }
  results.sort((a, b) => b.updatedAt - a.updatedAt);
  const lines = results.map(r => {
    const daysAgo = Math.floor((Date.now() / 1000 - r.updatedAt) / 86400);
    return `群组 ${r.id}: ${r.text} (${daysAgo}天前)`;
  });
  seal.replyToSender(ctx, msg, `用户 ${targetUid} 的跨群印象:\n${lines.join('\n')}`);
  return ret;
}
