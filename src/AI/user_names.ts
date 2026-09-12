import { ConfigManager } from "../config/configManager";
import { normalizeName } from "../utils/utils";

export interface UserNameRecord {
  primaryName: string;
  aliases: string[];
  updatedAt: number;
}

interface NameScopeRecord {
  users: { [uid: string]: UserNameRecord };
}

interface UserNameStore {
  version: 2;
  scopes: { [scopeId: string]: NameScopeRecord };
}

export interface UserNameMatch {
  uid: string;
  matchedName: string;
  record: UserNameRecord;
}

export interface NameMutationResult {
  ok: boolean;
  reason?: 'empty' | 'conflict' | 'missing';
  conflictUid?: string;
}

const STORAGE_KEY = 'userNameMap';
const MAX_NAME_LENGTH = 90;

function cleanName(name: string): string {
  return String(name || '').replace(/[\r\n]/g, '').trim().slice(0, MAX_NAME_LENGTH);
}

function cleanScope(scopeId: string): string {
  return String(scopeId || '').trim();
}

function sameName(a: string, b: string): boolean {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (left || right) return left !== '' && left === right;
  const rawLeft = cleanName(a);
  const rawRight = cleanName(b);
  return rawLeft !== '' && rawLeft === rawRight;
}

function referenceKey(name: string): string {
  const normalized = normalizeName(name);
  return normalized || `raw:${cleanName(name)}`;
}

function identityKey(name: string): string {
  const raw = cleanName(name);
  const number = raw.replace(/^QQ:/i, '');
  return /^\d{5,11}$/.test(number) ? `qq:${number}` : referenceKey(raw);
}

function matchesNameOrUid(name: string, uid: string): boolean {
  const raw = cleanName(name);
  const uidNumber = uid.replace(/^.+:/, '');
  const inputNumber = raw.replace(/^QQ:/i, '');
  return (inputNumber !== raw && inputNumber === uidNumber) ||
    (/^\d{5,11}$/.test(raw) && raw === uidNumber) ||
    sameName(raw, uid) ||
    sameName(raw, uidNumber);
}

function cloneRecord(record: UserNameRecord): UserNameRecord {
  return {
    primaryName: record.primaryName,
    aliases: [...record.aliases],
    updatedAt: record.updatedAt,
  };
}

export class UserNameManager {
  private static store: UserNameStore | null = null;
  private static reportedConflicts = new Set<string>();

  static scopeFromContext(ctx: seal.MsgContext): string {
    if (!ctx) return '';
    return ctx.isPrivate ? String(ctx.player?.userId || '') : String(ctx.group?.groupId || '');
  }

  private static getStore(): UserNameStore {
    if (this.store) return this.store;

    try {
      const raw = ConfigManager.ext.storageGet(STORAGE_KEY);
      const parsed = JSON.parse(raw || '{}');
      if (parsed && parsed.version === 2 && parsed.scopes && typeof parsed.scopes === 'object') {
        const scopes: { [scopeId: string]: NameScopeRecord } = {};
        for (const [scopeId, scopeValue] of Object.entries(parsed.scopes)) {
          const scope = scopeValue as Partial<NameScopeRecord>;
          const users: { [uid: string]: UserNameRecord } = {};
          const usedNames = new Set<string>();
          for (const [uid, value] of Object.entries(scope.users || {})) {
            const record = this.sanitizeRecord(value);
            if (record.primaryName) {
              const key = identityKey(record.primaryName);
              if (usedNames.has(key)) record.primaryName = '';
              else usedNames.add(key);
            }
            record.aliases = record.aliases.filter(alias => {
              if (sameName(alias, record.primaryName)) return false;
              const key = identityKey(alias);
              if (usedNames.has(key)) return false;
              usedNames.add(key);
              return true;
            });
            users[uid] = record;
          }
          scopes[scopeId] = { users };
        }
        this.store = { version: 2, scopes };
        return this.store;
      }
    } catch {
      // 损坏、旧版本或不存在时从空的群组作用域表开始。
    }

    this.store = { version: 2, scopes: {} };
    return this.store;
  }

  private static sanitizeRecord(value: unknown): UserNameRecord {
    const item = (value || {}) as Partial<UserNameRecord>;
    const primaryName = cleanName(item.primaryName || '');
    const aliases = Array.isArray(item.aliases)
      ? item.aliases.map(name => cleanName(String(name))).filter(Boolean)
      : [];
    return {
      primaryName,
      aliases: [...new Set(aliases)],
      updatedAt: Number(item.updatedAt) || 0,
    };
  }

  private static getScope(scopeId: string, create: boolean = false): NameScopeRecord | null {
    const key = cleanScope(scopeId);
    if (!key) return null;

    const store = this.getStore();
    if (!store.scopes[key] && create) store.scopes[key] = { users: {} };
    return store.scopes[key] || null;
  }

  private static save(): void {
    ConfigManager.ext.storageSet(STORAGE_KEY, JSON.stringify(this.getStore()));
  }

  private static touch(record: UserNameRecord): void {
    record.updatedAt = Math.floor(Date.now() / 1000);
  }

  private static conflictKey(scopeId: string, uid: string, name: string, conflictUid: string): string {
    return `${cleanScope(scopeId)}\u0000${uid}\u0000${normalizeName(name)}\u0000${conflictUid}`;
  }

  private static reportConflict(
    scopeId: string,
    uid: string,
    name: string,
    conflictUid: string,
    notifyCtx?: seal.MsgContext,
  ): void {
    if (!notifyCtx?.notice) return;

    const key = this.conflictKey(scopeId, uid, name, conflictUid);
    if (this.reportedConflicts.has(key)) return;
    this.reportedConflicts.add(key);

    try {
      notifyCtx.notice(`名称冲突：当前会话中“${name}”已绑定用户 ${conflictUid}，用户 ${uid} 的新绑定已取消。`);
    } catch {
      // 通知列表不可用时仍保持拒绝写入，不影响名称表一致性。
    }
  }

  /** 冲突检查必须扫描同一作用域的全部名称，不能复用带优先级的解析结果。 */
  private static findConflicts(scopeId: string, name: string, excludeUid: string = ''): UserNameMatch[] {
    const scope = this.getScope(scopeId);
    if (!scope) return [];

    const matches: UserNameMatch[] = [];
    for (const [uid, record] of Object.entries(scope.users)) {
      if (uid === excludeUid) continue;
      const candidates = [record.primaryName, ...record.aliases, uid, uid.replace(/^.+:/, '')].filter(Boolean);
      const matchedName = candidates.find(candidate => sameName(candidate, name) || matchesNameOrUid(name, candidate));
      if (matchedName) matches.push({ uid, matchedName, record: cloneRecord(record) });
    }
    return matches;
  }

  static get(scopeId: string, uid: string): UserNameRecord | null {
    const record = this.getScope(scopeId)?.users[uid];
    return record ? cloneRecord(record) : null;
  }

  static getPrimary(scopeId: string, uid: string): string {
    return this.getScope(scopeId)?.users[uid]?.primaryName || '';
  }

  static setPrimary(scopeId: string, uid: string, name: string, notifyCtx?: seal.MsgContext): NameMutationResult {
    const primaryName = cleanName(name);
    if (!primaryName || !cleanScope(scopeId) || !uid) return { ok: false, reason: 'empty' };

    const conflict = this.findConflicts(scopeId, primaryName, uid)[0];
    if (conflict) {
      this.reportConflict(scopeId, uid, primaryName, conflict.uid, notifyCtx);
      return { ok: false, reason: 'conflict', conflictUid: conflict.uid };
    }

    const scope = this.getScope(scopeId, true);
    const record = scope.users[uid] || { primaryName: '', aliases: [], updatedAt: 0 };
    record.primaryName = primaryName;
    record.aliases = record.aliases.filter(alias => !sameName(alias, primaryName));
    this.touch(record);
    scope.users[uid] = record;
    this.save();
    return { ok: true };
  }

  static addAlias(
    scopeId: string,
    uid: string,
    name: string,
    rejectConflict: boolean = true,
    notifyCtx?: seal.MsgContext,
  ): NameMutationResult {
    const alias = cleanName(name);
    if (!alias || !cleanScope(scopeId) || !uid) return { ok: false, reason: 'empty' };

    const scope = this.getScope(scopeId, true);
    const record = scope.users[uid] || { primaryName: '', aliases: [], updatedAt: 0 };
    if (sameName(alias, record.primaryName) || record.aliases.some(item => sameName(item, alias))) {
      return { ok: true };
    }

    if (rejectConflict) {
      const conflict = this.findConflicts(scopeId, alias, uid)[0];
      if (conflict) {
        this.reportConflict(scopeId, uid, alias, conflict.uid, notifyCtx);
        return { ok: false, reason: 'conflict', conflictUid: conflict.uid };
      }
    }

    record.aliases.push(alias);
    this.touch(record);
    scope.users[uid] = record;
    this.save();
    return { ok: true };
  }

  static removeAlias(scopeId: string, uid: string, name: string): NameMutationResult {
    const record = this.getScope(scopeId)?.users[uid];
    if (!record) return { ok: false, reason: 'missing' };
    const index = record.aliases.findIndex(alias => sameName(alias, name));
    if (index < 0) return { ok: false, reason: 'missing' };

    record.aliases.splice(index, 1);
    this.touch(record);
    this.save();
    return { ok: true };
  }

  static clear(scopeId: string, uid: string): boolean {
    const scope = this.getScope(scopeId);
    if (!scope?.users[uid]) return false;
    delete scope.users[uid];
    this.save();
    return true;
  }

  /** 记录当前作用域的 SealDice 显示名称为别称，不改变 .nn 或群名片。 */
  static registerObserved(scopeId: string, uid: string, name: string, notifyCtx?: seal.MsgContext): NameMutationResult {
    if (!uid || !cleanName(name)) return { ok: false, reason: 'empty' };
    return this.addAlias(scopeId, uid, name, true, notifyCtx);
  }

  static find(scopeId: string, name: string): UserNameMatch[] {
    const scope = this.getScope(scopeId);
    if (!scope) return [];

    const raw = String(name || '').trim();
    const normalized = normalizeName(raw);
    const qq = raw.replace(/^QQ:/i, '');
    if (!normalized && !/^\d{5,11}$/.test(qq)) {
      // 纯 emoji/符号名称没有可归一化文本，只允许精确匹配。
      if (!raw) return [];
    }

    const idMatches: UserNameMatch[] = [];
    const primaryMatches: UserNameMatch[] = [];
    const otherMatches: UserNameMatch[] = [];

    for (const [uid, record] of Object.entries(scope.users)) {
      const candidates = [record.primaryName, ...record.aliases].filter(Boolean);
      const matchedPrimary = Boolean(record.primaryName && sameName(record.primaryName, raw));
      const matchedName = candidates.find(candidate => sameName(candidate, raw));
      const uidNumber = uid.replace(/^.+:/, '');
      const matchedId = (qq !== raw && qq === uidNumber) || (/^\d{5,11}$/.test(raw) && raw === uidNumber);
      if (matchedId || matchedName) {
        const match = { uid, matchedName: matchedName || uidNumber, record: cloneRecord(record) };
        if (matchedId) idMatches.push(match);
        else if (matchedPrimary) primaryMatches.push(match);
        else otherMatches.push(match);
      }
    }

    // QQ 号优先；手动主昵称优先于其他用户的观察别称；多个别称命中仍保留为歧义。
    return idMatches.length > 0 ? idMatches : (primaryMatches.length > 0 ? primaryMatches : otherMatches);
  }

  static formatDisplayName(scopeId: string, uid: string, displayName: string): string {
    const raw = cleanName(displayName);
    const primaryName = this.getPrimary(scopeId, uid);
    if (!primaryName || !raw || sameName(raw, primaryName)) return raw;
    return `${raw}（用户：${primaryName}）`;
  }

  /** 替换当前作用域用户消息中的已知别称；冲突别称会被跳过。 */
  static replaceReferences(scopeId: string, text: string): string {
    if (!text) return text;
    const scope = this.getScope(scopeId);
    if (!scope) return text;

    const tokenMap = new Map<string, { token: string; primaryName: string; uid: string }>();
    const conflicted = new Set<string>();
    for (const [uid, record] of Object.entries(scope.users)) {
      if (!record.primaryName) continue;
      const names = [...record.aliases, uid.replace(/^.+:/, ''), uid]
        .filter(name => name.length >= 2)
        .filter(name => !sameName(name, record.primaryName));
      for (const name of names) {
        const key = referenceKey(name);
        if (!key) continue;
        const existing = tokenMap.get(key);
        if (existing && (existing.uid !== uid || existing.primaryName !== record.primaryName)) {
          conflicted.add(key);
        } else {
          tokenMap.set(key, { token: name, primaryName: record.primaryName, uid });
        }
      }
    }

    const entries = [...tokenMap.entries()]
      .filter(([key]) => !conflicted.has(key))
      .map(([, entry]) => entry)
      .sort((a, b) => b.token.length - a.token.length);
    if (entries.length === 0) return text;

    const escaped = entries.map(item => {
      const value = item.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return /^\d+$/.test(item.token) ? `(?<!\\d)${value}(?!\\d)` : value;
    });
    const replacementByNormalized = new Map(entries.map(item => [referenceKey(item.token), item.primaryName]));
    const pattern = new RegExp(escaped.join('|'), 'giu');
    return text.replace(pattern, match => `${match}（用户：${replacementByNormalized.get(referenceKey(match))}）`);
  }
}
