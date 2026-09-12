import { UserNameManager } from "../../AI/user_names";
import { PRIVILEGELEVELMAP } from "../../config/config";
import { aliasToCmd } from "../../utils/utils";
import { U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root";

function restArgs(cmdArgs: seal.CmdArgs, n: number): string {
  if (cmdArgs.getRestArgsFrom) return cmdArgs.getRestArgsFrom(n).trim();
  return cmdArgs.args.slice(n - 1).join(' ').trim();
}

function parseUserId(raw: string): string | null {
  const value = String(raw || '').trim();
  if (/^QQ:\d+$/i.test(value)) return `QQ:${value.slice(3)}`;
  if (/^\d{5,11}$/.test(value)) return `QQ:${value}`;
  return null;
}

function sameUser(a: string, b: string): boolean {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function isSelfToken(value: string): boolean {
  return ['self', 'me', 'myself', 'now', '自己', '本人'].includes(aliasToCmd(value));
}

async function resolveTarget(scc: SubCmdContext, raw: string): Promise<string | null> {
  const value = String(raw || '').trim();
  if (!value || isSelfToken(value)) return scc.uid;

  const userId = parseUserId(value);
  if (userId) return userId;

  const userInfo = await scc.ai.context.findUserInfo(scc.ctx, value, true);
  return userInfo?.id || null;
}

async function resolveTargetAndValue(scc: SubCmdContext): Promise<{ uid: string; value: string } | null> {
  const { cmdArgs } = scc;
  const mentioned = cmdArgs.at?.find(item => !sameUser(item.userId, scc.epId))?.userId;
  if (mentioned) {
    return { uid: mentioned, value: restArgs(cmdArgs, 3) };
  }

  const first = cmdArgs.getArgN(3).trim();
  const rest = restArgs(cmdArgs, 4);
  if (!first) return { uid: scc.uid, value: '' };
  if (isSelfToken(first)) return { uid: scc.uid, value: rest };

  // 两段参数时优先按“目标 + 名称”解析；单段参数始终视为自己的名称。
  if (rest) {
    const target = await resolveTarget(scc, first);
    if (target) return { uid: target, value: rest };
  }

  return { uid: scc.uid, value: restArgs(cmdArgs, 3) };
}

async function resolveTargetOnly(scc: SubCmdContext): Promise<string | null> {
  const mentioned = scc.cmdArgs.at?.find(item => !sameUser(item.userId, scc.epId))?.userId;
  if (mentioned) return mentioned;
  const raw = scc.cmdArgs.getArgN(3).trim();
  if (!raw) return scc.uid;
  return resolveTarget(scc, raw);
}

function canManage(ctx: seal.MsgContext, requesterUid: string, targetUid: string): boolean {
  if (sameUser(requesterUid, targetUid)) return true;
  // 私聊上下文在 SealDice 中可能带有管理员级默认权限，不能因此允许任意用户替他人改名。
  const requiredLevel = ctx.isPrivate ? PRIVILEGELEVELMAP.master : PRIVILEGELEVELMAP.admin;
  return ctx.privilegeLevel >= requiredLevel;
}

function importObservedAliases(scc: SubCmdContext, uid: string): void {
  const names = scc.ai.context.aliases[uid]?.names || [];
  for (const name of names) {
    const result = UserNameManager.registerObserved(scc.sid, uid, name, scc.ctx);
    if (result.reason === 'conflict') scc.ai.context.markAmbiguousName(name);
  }
}

function showRecord(scopeId: string, uid: string): string {
  const record = UserNameManager.get(scopeId, uid);
  if (!record) return `用户 ${uid} 尚未设置主昵称或别称`;
  return `用户：${uid}\n主昵称：${record.primaryName || '未设置'}\n别称：${record.aliases.join('、') || '无'}`;
}

export function registerCmdName() {
  const cmd = new SubCmd('name');
  cmd.desc = '管理当前群或私聊会话内 AI 使用的主昵称和别称';
  cmd.help = `帮助:
【.ai name set <主昵称>】设置自己的主昵称
【.ai name set <用户或QQ号> <主昵称>】管理员替他人设置主昵称
【.ai name add <别称>】为自己添加别称
【.ai name add <用户或QQ号> <别称>】管理员为他人添加别称
【.ai name del <别称>】删除自己的别称
【.ai name list [用户或QQ号]】查看名称映射
【.ai name clear [用户或QQ号]】清除主昵称和别称`;
  cmd.priv = {
    priv: U,
    args: {
      set: { priv: U },
      add: { priv: U },
      delete: { priv: U },
      list: { priv: U },
      clear: { priv: U },
    }
  };
  cmd.solve = async (scc: SubCmdContext) => {
    const { ctx, msg, cmdArgs, ret } = scc;
    const operation = aliasToCmd(cmdArgs.getArgN(2));

    if (operation === 'set' || operation === 'add') {
      const targetAndValue = await resolveTargetAndValue(scc);
      if (!targetAndValue || !targetAndValue.value) {
        seal.replyToSender(ctx, msg, cmd.help);
        return ret;
      }
      const { uid, value } = targetAndValue;
      if (!canManage(ctx, scc.uid, uid)) {
        seal.replyToSender(ctx, msg, '权限不足：只能修改自己的名称，管理员可以修改他人名称');
        return ret;
      }

      importObservedAliases(scc, uid);
      const result = operation === 'set'
        ? UserNameManager.setPrimary(scc.sid, uid, value, ctx)
        : UserNameManager.addAlias(scc.sid, uid, value, true, ctx);
      if (!result.ok) {
        if (result.reason === 'conflict') {
          seal.replyToSender(ctx, msg, `名称“${value}”已绑定到其他用户，未执行修改`);
        } else {
          seal.replyToSender(ctx, msg, '名称不能为空');
        }
        return ret;
      }

      seal.replyToSender(ctx, msg, operation === 'set'
        ? `已将用户 ${uid} 的 AI 主昵称设置为“${value}”`
        : `已将“${value}”添加为用户 ${uid} 的 AI 别称`);
      return ret;
    }

    if (operation === 'delete') {
      const targetAndValue = await resolveTargetAndValue(scc);
      if (!targetAndValue || !targetAndValue.value) {
        seal.replyToSender(ctx, msg, cmd.help);
        return ret;
      }
      const { uid, value } = targetAndValue;
      if (!canManage(ctx, scc.uid, uid)) {
        seal.replyToSender(ctx, msg, '权限不足：只能修改自己的名称，管理员可以修改他人名称');
        return ret;
      }
      const result = UserNameManager.removeAlias(scc.sid, uid, value);
      scc.ai.context.removeAlias(uid, value);
      seal.replyToSender(ctx, msg, result.ok ? `已删除别称“${value}”` : `未找到别称“${value}”`);
      return ret;
    }

    if (operation === 'list') {
      const uid = await resolveTargetOnly(scc);
      if (!uid) {
        seal.replyToSender(ctx, msg, '无法唯一确定目标用户');
        return ret;
      }
      if (!canManage(ctx, scc.uid, uid)) {
        seal.replyToSender(ctx, msg, '权限不足：只能查看自己的名称，管理员可以查看他人名称');
        return ret;
      }
      seal.replyToSender(ctx, msg, showRecord(scc.sid, uid));
      return ret;
    }

    if (operation === 'clear') {
      const uid = await resolveTargetOnly(scc);
      if (!uid) {
        seal.replyToSender(ctx, msg, '无法唯一确定目标用户');
        return ret;
      }
      if (!canManage(ctx, scc.uid, uid)) {
        seal.replyToSender(ctx, msg, '权限不足：只能清除自己的名称，管理员可以清除他人名称');
        return ret;
      }
      const removed = UserNameManager.clear(scc.sid, uid);
      scc.ai.context.clearAliases(uid);
      seal.replyToSender(ctx, msg, removed ? `已清除用户 ${uid} 的主昵称和别称` : '该用户没有已保存的主昵称或别称');
      return ret;
    }

    seal.replyToSender(ctx, msg, cmd.help);
    return ret;
  };
}
