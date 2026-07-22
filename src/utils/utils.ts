import { AI, GroupInfo, UserInfo } from "../AI/AI";
import { logger } from "../logger";
import { ConfigManager } from "../config/configManager";
import { transformTextToArray } from "./utils_string";
import { aliasMap } from "../config/config";
import { netExists, sendGroupMsg, sendPrivateMsg } from "./utils_ob11";

export function transformMsgId(msgId: string | number | null): string {
    if (msgId !== null && typeof msgId === 'object' && 'MessageId' in msgId) {
        msgId = (msgId as any).MessageId;
    }
    if (msgId === null) {
        return '';
    }
    if (typeof msgId === 'string') {
        msgId = parseInt(msgId);
    }
    return isNaN(msgId) ? '' : msgId.toString(36); // 将数字转换为36进制字符串
}

export function transformMsgIdBack(msgId: string): number {
    return parseInt(msgId, 36); // 将36进制字符串转换为数字 
}

export function generateId() {
    const timestamp = Date.now().toString(36); // 将时间戳转换为36进制字符串
    const random = Math.random().toString(36).substring(2, 6); // 随机数部分
    return (timestamp + random).slice(-6); // 截取最后6位
}

export async function replyToSender(ctx: seal.MsgContext, msg: seal.Message, ai: AI, s: string): Promise<string> {
    if (!s) {
        return '';
    }

    const { showMsgId } = ConfigManager.message;
    if (showMsgId && netExists()) {
        const rawMessageArray = transformTextToArray(s);
        const messageArray = rawMessageArray.filter(item => item.type !== 'poke');

        // 处理戳戳戳
        const pokeMsgArr = rawMessageArray.filter(item => item.type === 'poke');
        if (pokeMsgArr.length > 0) {
            pokeMsgArr.forEach(item => {
                const s = `[CQ:poke,qq=${item.data.qq}]`;
                ai.context.lastReply = s;
                seal.replyToSender(ctx, msg, s);
            });
        }

        if (messageArray.length === 0) return '';

        const epId = ctx.endPoint.userId;
        const gid = ctx.group.groupId;
        const uid = ctx.player.userId;
        if (msg.messageType === 'private') {
            const result = await sendPrivateMsg(epId, uid.replace(/^.+:/, ''), messageArray);
            if (result?.message_id) {
                logger.info(`(${result.message_id})发送给${uid}:${s}`);
                return transformMsgId(result.message_id);
            }
        } else if (msg.messageType === 'group') {
            const result = await sendGroupMsg(epId, gid.replace(/^.+:/, ''), messageArray);
            if (result?.message_id) {
                logger.info(`(${result.message_id})发送给${gid}:${s}`);
                return transformMsgId(result.message_id);
            }
        }
        logger.warning(`无法获取message_id`);
    }
    ai.context.lastReply = s;
    seal.replyToSender(ctx, msg, s);
    return '';
}

export function withTimeout<T>(asyncFunc: () => Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
        asyncFunc(),
        new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(`操作超时 (${timeoutMs}ms)`)), timeoutMs);
        })
    ]);
}

/**
 * 恢复一个对象，只恢复构造函数中定义的属性，暂不支持嵌套属性
 * @param constructor 传入构造函数，必须有 validKeys 属性
 * @param value 要恢复的对象
 * @returns 恢复后的对象
 */
export function revive<T>(constructor: { new(): T, validKeys: (keyof T)[] }, value: any): T {
    const obj = new constructor();

    if (!constructor.validKeys) {
        logger.error(`revive: ${constructor.name} 没有 validKeys 属性`);
        return obj;
    }

    for (const k of constructor.validKeys) {
        if (value.hasOwnProperty(k)) {
            obj[k] = value[k];
        }
    }

    return obj;
}

export function aliasToCmd(val: string) {
    return aliasMap[val] || val;
}


export function getCommonUser(a: UserInfo[], b: UserInfo[]): UserInfo[] {
    if (a.length === 0 || b.length === 0) return [];
    const aid = new Set(a.map(u => u.id));
    return b.filter(u => aid.has(u.id));
}
export function getCommonGroup(a: GroupInfo[], b: GroupInfo[]): GroupInfo[] {
    if (a.length === 0 || b.length === 0) return [];
    const aid = new Set(a.map(g => g.id));
    return b.filter(g => aid.has(g.id));
}
export function levenshteinDistance(a: string, b: string): number {
    const m = a.length, n = b.length;
    const dp: number[][] = [];
    for (let i = 0; i <= m; i++) {
        dp[i] = [i];
    }
    for (let j = 0; j <= n; j++) {
        dp[0][j] = j;
    }
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : Math.min(dp[i - 1][j - 1], dp[i][j - 1], dp[i - 1][j]) + 1;
        }
    }
    return dp[m][n];
}

export function getCommonKeyword(a: string[], b: string[]): string[] {
    if (a.length === 0 || b.length === 0) return [];
    const aid = new Set(a);
    return b.filter(k => aid.has(k));
}