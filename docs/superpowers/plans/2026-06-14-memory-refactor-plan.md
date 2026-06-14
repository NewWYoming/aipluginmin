# 记忆系统重构 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复记忆系统核心 bug，增加 POV 作用域隔离、增量印象层、复合相关性打分，解决"记忆淹没当前对话"和"私聊信息泄露到群聊"两个核心痛点。

**Architecture:** 分 4 个 Phase 渐进实现。Phase 1 纯 bug 修复（零风险），Phase 2 POV 隔离，Phase 3 印象层取代短期记忆，Phase 4 复合打分 + LLM 精排。每个 Phase 独立可发布。

**Tech Stack:** TypeScript, SeaDice JS plugin, key-value storage, HTTP LLM API

**Spec:** `docs/superpowers/specs/2026-06-14-memory-refactor-design.md`

---

### Task 0: 版本号更新

每次提交 src/ 下的代码后，必须：
1. `src/config/config.ts` `VERSION` patch +1
2. `header.txt` `@version` patch +1
3. 使用 `edit` 工具，禁用 PowerShell `Set-Content`

---

## Phase 1: Bug 修复

### Task 1: 修复 updateMemoryWeight 的 Math.max/min 互换

**Files:**
- Modify: `src/AI/memory.ts:451,454`

- [ ] **Step 1: 修复两行代码**

```typescript
// Line 451 — Math.max → Math.min
m.weight = Math.min(10, m.weight + increase);

// Line 454 — Math.min → Math.max  
m.weight = Math.max(0, m.weight - decrease);
```

- [ ] **Step 2: 构建验证**

```bash
npm run build
```

- [ ] **Step 3: 版本号 + 提交**

```bash
git add src/AI/memory.ts src/config/config.ts header.txt
git commit -m "fix: swap Math.max/min in updateMemoryWeight — weights were locked at extremes"
```

### Task 2: 修复 limitMemory 调用顺序

**Files:**
- Modify: `src/AI/memory.ts:229-230`

- [ ] **Step 1: 调换两行顺序**

```typescript
// Before (bug):
await m.updateVector();
this.limitMemory();      // ← 在加入之前淘汰
this.memoryMap[id] = m;

// After (fix):
await m.updateVector();
this.memoryMap[id] = m;  // ← 先加入
this.limitMemory();      // ← 再淘汰
```

- [ ] **Step 2: 构建 + 版本号 + 提交**

```bash
npm run build
git add src/AI/memory.ts src/config/config.ts header.txt
git commit -m "fix: limitMemory after add, not before"
```

### Task 3: 修复记忆展示模板变量名不匹配

**Files:**
- Modify: `src/config/config_memory.ts:57`

- [ ] **Step 1: 修复模板变量名**

```diff
- {{{用户列表}}}
- {{{群聊列表}}}
+ {{{相关用户}}}
+ {{{相关群聊}}}
```

在 `memorySingleShowTemplate` 默认模板中修复。

- [ ] **Step 2: 构建 + 版本号 + 提交**

```bash
npm run build
git add src/config/config_memory.ts src/config/config.ts header.txt
git commit -m "fix: align memory template variable names with code keys"
```

---

## Phase 2: POV 作用域 + 旧记忆清理

### Task 4: Memory 新增 scope/witnesses/importance 字段

**Files:**
- Modify: `src/AI/memory.ts`

- [ ] **Step 1: 更新 validKeys 和字段定义**

```typescript
// Memory.validKeys (line 22) — 追加三个字段
static validKeys: (keyof Memory)[] = ['id', 'vector', 'text', 'sessionInfo', 'userList', 'groupList', 'createTime', 'lastMentionTime', 'keywords', 'weight', 'images', 'scope', 'witnesses', 'importance'];

// 新增字段声明（class body 中）
scope: 'private' | 'group' | 'universal';
witnesses: string[];
importance: 1 | 3 | 5;

// constructor 默认值
this.scope = 'group';
this.witnesses = [];
this.importance = 3;
```

- [ ] **Step 2: 构建验证**

```bash
npm run build
```

### Task 5: 清空旧记忆（数据迁移）

**Files:**
- Modify: `src/AI/memory.ts` — `MemoryManager.reviveMemoryMap()`

- [ ] **Step 1: 在 reviveMemoryMap 中检测并清空旧记忆**

```typescript
reviveMemoryMap() {
  let hasOldFormat = false;
  for (const id in this.memoryMap) {
    const m = this.memoryMap[id];
    // 检测旧格式（无 scope 字段）
    if (!m.hasOwnProperty('scope')) {
      hasOldFormat = true;
      delete this.memoryMap[id];
      continue;
    }
    // 正常 revival...
    this.memoryMap[id] = revive(Memory, m);
    // ...
  }
  if (hasOldFormat) {
    logger.info('检测到旧格式记忆，已清空。新记忆将使用新格式。');
  }
}
```

KnowledgeMemoryManager 覆盖此方法，**不清空知识记忆**，在 revival 后强制 `scope = 'universal'`。

- [ ] **Step 2: 构建 + 版本号 + 提交**

```bash
npm run build
git add src/AI/memory.ts src/config/config.ts header.txt
git commit -m "feat: add scope/witnesses/importance to Memory, clear old memories"
```

### Task 6: POV 过滤 + buildMemoryPrompt 重写

**Files:**
- Modify: `src/AI/memory.ts` — 新增 `getPOVFilteredMemories` + 重写 `buildMemoryPrompt`

- [ ] **Step 1: 新增 getPOVFilteredMemories 方法**

```typescript
getPOVFilteredMemories(text: string, currentScope: string, currentSessionId: string) {
  return this.memoryList.filter(m => {
    if (m.scope === 'universal') return true;
    if (m.scope === currentScope && m.sessionInfo.id === currentSessionId) return true;
    if (m.scope === 'private' && m.sessionInfo.id === currentSessionId) return true;
    return false;
  });
}
```

- [ ] **Step 2: 重写 buildMemoryPrompt (memory.ts:531-571)**

删除遍历 `context.userInfoList` 注入所有用户私人记忆的代码段（原 553-567 行）。
替换为：

```typescript
async buildMemoryPrompt(ctx, context, text, ui, gi): Promise<string> {
  const currentScope = ctx.isPrivate ? 'private' : 'group';
  const currentSessionId = ctx.isPrivate ? ctx.player.userId : ctx.group.groupId;
  
  // Bot 的长期记忆（universal + 当前 scope 匹配）
  const botAI = AIManager.getAI(ctx.endPoint.userId);
  const botMemories = botAI.memory.getPOVFilteredMemories(text, currentScope, currentSessionId);
  const scoredBot = botAI.memory.scoreAndSlice(botMemories, text, ui, gi);
  let s = botAI.memory.buildMemory(
    { isPrivate: true, id: ctx.endPoint.userId, name: seal.formatTmpl(ctx, "核心:骰子名字") },
    scoredBot
  );

  if (ctx.isPrivate) {
    // 私聊：当前用户的 private 记忆
    const userAI = AIManager.getAI(ctx.player.userId);
    const userMemories = userAI.memory.getPOVFilteredMemories(text, currentScope, currentSessionId);
    const scored = userAI.memory.scoreAndSlice(userMemories, text, ui, gi);
    s += userAI.memory.buildMemory(
      { isPrivate: true, id: ctx.player.userId, name: ctx.player.name },
      scored
    );
  } else {
    // 群聊：仅本群 group 记忆，不注入任何人的 private 记忆
    const groupAI = AIManager.getAI(ctx.group.groupId);
    const groupMemories = groupAI.memory.getPOVFilteredMemories(text, currentScope, currentSessionId);
    const scored = groupAI.memory.scoreAndSlice(groupMemories, text, ui, gi);
    s += groupAI.memory.buildMemory(
      { isPrivate: false, id: ctx.group.groupId, name: ctx.group.groupName },
      scored
    );
  }

  return s;
}
```

- [ ] **Step 3: 构建 + 版本号 + 提交**

```bash
npm run build
git add src/AI/memory.ts src/config/config.ts header.txt
git commit -m "feat: add POV-filtered memory injection, remove N×5 group user injection"
```

### Task 7: add_memory 工具 API 扩展

**Files:**
- Modify: `src/tool/tool_memory.ts`

- [ ] **Step 1: 扩展 add_memory 参数 schema**

在 `add_memory` 的 parameters.properties 中添加：

```typescript
importance: {
  type: 'number',
  enum: [1, 3, 5],
  description: '重要性: 5=核心事实(身份/偏好), 3=一般信息, 1=琐碎',
  default: 3
}
```

`scope` 不从工具参数取，在 solve 中自动推导：`memory_type === 'private' ? 'private' : 'group'`。

- [ ] **Step 2: 更新 solve 方法传递新参数**

```typescript
// tool_memory.ts add_memory solve 中:
await ai.memory.addMemory(
  ctx, ai, uiList, giList, keywords, [],
  args.text,
  scope,        // 从 memory_type 推导
  [],           // witnesses — 自动从当前 context 提取
  args.importance || 3
);
```

- [ ] **Step 3: 更新 MemoryManager.addMemory 签名**

```typescript
async addMemory(
  ctx, ai, ul, gl, kws, images, text,
  scope: 'private' | 'group' | 'universal' = 'group',
  witnesses: string[] = [],
  importance: 1 | 3 | 5 = 3
) {
  // ... 现有逻辑 ...
  m.scope = scope;
  m.witnesses = witnesses;
  m.importance = importance;
}
```

- [ ] **Step 4: 构建 + 版本号 + 提交**

```bash
npm run build
git add src/tool/tool_memory.ts src/AI/memory.ts src/config/config.ts header.txt
git commit -m "feat: extend add_memory with scope/witnesses/importance"
```

---

## Phase 3: 印象层

### Task 8: MemoryManager 新增 impressions + observations

**Files:**
- Modify: `src/AI/memory.ts`

- [ ] **Step 1: 定义数据结构**

```typescript
interface UserObservation {
  rawMessages: string[];
  msgCount: number;
  lastSpeak: number;
}

interface Impression {
  text: string;
  updatedAt: number;
}
```

- [ ] **Step 2: 更新 validKeys + 字段 + 构造**

```typescript
// MemoryManager.validKeys
static validKeys: (keyof MemoryManager)[] = ['persona', 'memoryMap', 'impressions', 'observations'];

// 新增字段
impressions: { [userId: string]: Impression };
observations: { [userId: string]: UserObservation };

// 构造初始化
this.impressions = {};
this.observations = {};
```

删除：`useShortMemory`, `shortMemoryList` 字段及 validKeys 引用，`limitShortMemory()`, `clearShortMemory()`, `updateShortMemory()` 方法，以及 `shortMemorySummaryRound` 相关逻辑。

- [ ] **Step 3: 构建验证**

```bash
npm run build
```

### Task 9: context.ts 替换短期记忆为印象收集

**Files:**
- Modify: `src/AI/context.ts`

- [ ] **Step 1: 删除短期记忆相关代码**

删除：
- `validKeys` 中的 `'summaryCounter'`
- `summaryCounter` 字段声明和构造初始化
- 原 147-155 行的短期记忆触发块（`updateShortMemory` 调用）

- [ ] **Step 2: 新增 Tier 1 印象收集**

在 `addMessage` 中，`updateRelatedMemoryWeight` 调用之后、`limitMessages()` 之前，插入：

```typescript
// 印象层 Tier 1 — 静默收集（仅 user 消息）
if (role === 'user') {
  const uid = ctx.player.userId;
  if (!ai.memory.observations[uid]) {
    ai.memory.observations[uid] = { rawMessages: [], msgCount: 0, lastSpeak: 0 };
  }
  const obs = ai.memory.observations[uid];
  obs.rawMessages.push(content);
  obs.msgCount += 1;
  obs.lastSpeak = now;

  const maxObserved = ConfigManager.memory.maxObservedMessages || 10;
  if (obs.rawMessages.length >= maxObserved) {
    ai.memory.updateImpression(uid, obs);
    obs.rawMessages = [];
  }
}
```

- [ ] **Step 3: 构建 + 版本号 + 提交**

```bash
npm run build
git add src/AI/context.ts src/AI/memory.ts src/config/config.ts header.txt
git commit -m "feat: replace short-term memory with impression observation collection"
```

### Task 10: 印象生成 + 注入 + 清理

**Files:**
- Modify: `src/AI/memory.ts` — 新增 `updateImpression`, `cleanupImpressions`
- Modify: `src/utils/utils_message.ts` — 新增印象模板变量
- Modify: `src/config/config_message.ts` — 模板添加印象段

- [ ] **Step 1: 新增 updateImpression 方法（Tier 2）**

```typescript
async updateImpression(uid: string, obs: UserObservation) {
  const current = this.impressions[uid];
  const oldImpression = current?.text || '无';
  const now = Math.floor(Date.now() / 1000);

  // 该用户的观察太少，跳过
  if (obs.rawMessages.length < 3) return;

  const prompt = `你正在根据最近的观察，更新对某个群友的简短印象。
当前印象: ${oldImpression}
最近观察:
${obs.rawMessages.map((m, i) => `${i + 1}. ${m}`).join('\n')}

请用 ≤80 字更新印象。只描述性格特点、说话风格、行为习惯。
不要描述具体事件。如果初次观察，给出初次印象。
返回 JSON: {"impression": "印象文字"}`;

  try {
    const body = {
      messages: [{ role: 'user', content: prompt }],
      // 使用记忆总结 API 配置（复用旧配置，或新增专用配置）
    };
    const response = await sendMemorySummaryRequest(body);
    const parsed = JSON.parse(response);
    if (parsed?.impression && typeof parsed.impression === 'string') {
      this.impressions[uid] = {
        text: parsed.impression.slice(0, ConfigManager.memory.impressionMaxLength || 80),
        updatedAt: now
      };
    }
  } catch (e) {
    logger.error(`印象更新失败 (${uid}): ${e.message}`);
  }
}
```

- [ ] **Step 2: 新增 buildImpressionPrompt 方法**

```typescript
buildImpressionPrompt(ctx: seal.MsgContext, context: Context): string {
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const msg of context.messages) {
    if (msg.role !== 'user') continue;
    const uid = msg.uid;
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);

    const imp = this.impressions[uid];
    if (!imp || !imp.text) continue;  // 空印象不注入

    const name = msg.name || '未知用户';
    lines.push(`${name}: ${imp.text}`);
  }

  return lines.join('\n');
}
```

- [ ] **Step 3: 新增 cleanupImpressions 方法（每天 0 点）**

```typescript
async cleanupImpressions(ctx: seal.MsgContext, ai: AI) {
  const now = Math.floor(Date.now() / 1000);
  const inactiveDays = ConfigManager.memory.cleanupInactiveDays || 30;

  // 仅群聊执行
  if (ctx.isPrivate) return;

  // 获取当前群成员列表
  const gid = ctx.group.groupId.replace(/^.+:/, '');
  const memberIds = new Set<string>();
  try {
    const members = await getGroupMemberList(ctx.endPoint.userId, gid);
    if (members) {
      for (const m of members) {
        memberIds.add(`QQ:${m.user_id}`);
      }
    }
  } catch { /* 群成员获取失败，跳过退群清理 */ }

  // 清理已退群用户 + 长期沉默用户
  for (const uid of Object.keys(this.observations)) {
    const obs = this.observations[uid];
    const silentDays = (now - obs.lastSpeak) / 86400;

    if (!memberIds.has(uid) || silentDays > inactiveDays) {
      delete this.impressions[uid];
      delete this.observations[uid];
    }
  }
}
```

- [ ] **Step 4: 定时器接入**

在 `AI.checkActiveTimer()` 中添加跨天检测：

```typescript
const today = new Date().toDateString();
const lastCheck = this._lastCleanupDate || '';
if (today !== lastCheck) {
  this._lastCleanupDate = today;
  await this.memory.cleanupImpressions(ctx, this);
}
```

- [ ] **Step 5: 印象模板变量（utils_message.ts）**

在 `buildSystemMessage` 中新增：

```typescript
const impressionText = isMemory ? ai.memory.buildImpressionPrompt(ctx, ai.context) : '';
const content = systemMessageTemplate({
  // ... 现有变量 ...
  "印象层": impressionText,
  // 删除: "开启短期记忆", "短期记忆信息"
});
```

- [ ] **Step 6: 系统消息模板更新（config_message.ts）**

在长期记忆段之后，新增：

```
{{#if 印象层}}

## 你对群友的印象
{{{印象层}}}
{{/if}}
```

同时删除 `{{#if 开启短期记忆}}...{{/if}}` 整段。

- [ ] **Step 7: 构建 + 版本号 + 提交**

```bash
npm run build
git add src/AI/memory.ts src/AI/context.ts src/utils/utils_message.ts src/config/config_message.ts src/config/config.ts header.txt
git commit -m "feat: add impression layer — collect, generate, inject, cleanup daily"
```

---

## Phase 4: 复合打分 + LLM 精排

### Task 11: 重写 search() 为复合打分

**Files:**
- Modify: `src/AI/memory.ts` — `search()` 方法

- [ ] **Step 1: 实现 Jaccard + recency + importance 复合打分**

```typescript
async search(query: string, options: searchOptions = {}) {
  // ... POV 过滤同 Phase 2 ...

  const jaccard = (a: string[], b: string[]): number => {
    const setA = new Set(a), setB = new Set(b);
    const intersection = [...setA].filter(x => setB.has(x)).length;
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0 : intersection / union;
  };

  const tokenize = (s: string): string[] => 
    s.split(/[\s,，。！？、；：""'']+/).filter(t => t.length > 0);

  const now = Math.floor(Date.now() / 1000);

  return this.memoryList
    .map(m => {
      const kwJaccard = jaccard(tokenize(query), m.keywords);
      const daysSinceCreate = (now - m.createTime) / 86400;
      const recency = Math.exp(-Math.log(2) * daysSinceCreate / 14);
      const importanceScore = { 1: 0.2, 3: 0.5, 5: 0.8 }[m.importance] || 0.5;

      const baseScore = 0.50 * kwJaccard + 0.30 * recency + 0.20 * importanceScore;

      return { ...m.copy, _baseScore: baseScore };
    })
    .filter(m => m._baseScore > 0.1)  // 极低分排除
    .sort((a, b) => b._baseScore - a._baseScore)
    .slice(0, options.topK || memoryShowNumber);
}
```

删除旧 keyword boost 行：`if (mc.keywords.some(kw => query.includes(kw))) mc.weight += 10;`

- [ ] **Step 2: 构建验证**

```bash
npm run build
```

### Task 12: LLM 精排层

**Files:**
- Modify: `src/AI/memory.ts` — 新增 `llmRerank` + 修改 `buildMemoryPrompt` 调用

- [ ] **Step 1: 新增 llmRerank 方法**

```typescript
async llmRerank(query: string, candidates: Memory[], topK: number): Promise<Memory[]> {
  if (candidates.length === 0) return [];
  if (candidates.length <= 5) return candidates.slice(0, topK);  // ≤5 不调精排

  const prompt = `根据当前对话，评估以下记忆的相关度 (0-5分):
当前对话: ${query.slice(0, 200)}

记忆列表:
${candidates.map((m, i) => `${i}. [${m.id}] ${m.text.slice(0, 100)}`).join('\n')}

返回 JSON: {"scores": {"id1": 4, "id2": 2, ...}}`;

  try {
    const body = {
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' }
    };
    const response = await sendMemorySummaryRequest(body);
    const scores = JSON.parse(response).scores || {};

    return candidates
      .map(m => ({ ...m, _finalScore: 0.7 * (scores[m.id] || 0) / 5 + 0.3 * m._baseScore }))
      .sort((a, b) => b._finalScore - a._finalScore)
      .slice(0, topK)
      .filter(m => m._finalScore > 0.2);  // 阈值过滤
  } catch (e) {
    logger.error(`LLM 精排失败: ${e.message}，回退到 base_score`);
    return candidates.slice(0, topK);
  }
}
```

- [ ] **Step 2: 在 buildMemoryPrompt 中接入精排**

```typescript
// scoreAndSlice 方法（改名为 getRelevantMemories）
async getRelevantMemories(text, ui, gi, topK) {
  const candidates = this.search(text, { topK: 20, ... }) as any;
  return await this.llmRerank(text, candidates, topK);
}
```

- [ ] **Step 3: 构建 + 版本号 + 提交**

```bash
npm run build
git add src/AI/memory.ts src/config/config.ts header.txt
git commit -m "feat: composite memory scoring (Jaccard+recency+importance) + LLM rerank"
```

---

## Phase 5: 清理 + 配置

### Task 13: 删除旧短期记忆配置 + 命令

**Files:**
- Modify: `src/config/config_memory.ts`
- Modify: `src/cmd/sub_cmd/memory.ts`  
- Modify: `src/utils/utils_message.ts`

- [ ] **Step 1: 删除 config_memory.ts 中的 6 个短期记忆相关 key**

删除 `register()` 调用和 `get()` 返回值：
- `是否启用短期记忆` (isShortMemory)
- `短期记忆上限` (shortMemoryLimit)
- `短期记忆总结轮数` (shortMemorySummaryRound)
- `记忆总结 url地址`
- `记忆总结 API Key`
- `记忆总结 body` / `记忆总结 prompt模板`

新增 config key（register + get）：
- `印象层观察缓存上限` (IntConfig, default 10)
- `印象最长天数` (IntConfig, default 3)
- `印象最大字数` (IntConfig, default 80)
- `印象清理沉默天数` (IntConfig, default 30)

- [ ] **Step 2: 删除 cmd/sub_cmd/memory.ts 中的 short/sum 命令**

删除 `case 'short':` 及 `case 'sum':` 整个代码块。
更新 help 文本，移除这些命令的说明。

- [ ] **Step 3: 清理 utils_message.ts 中的短期记忆引用**

确认已删除 `isShortMemory`、`shortMemoryList` 相关变量和模板注入。

- [ ] **Step 4: 构建 + 版本号 + 提交**

```bash
npm run build
git add src/config/config_memory.ts src/cmd/sub_cmd/memory.ts src/utils/utils_message.ts src/config/config.ts header.txt
git commit -m "chore: remove short-memory config and commands, add impression config"
```

### Task 14: 最终验证

- [ ] **Step 1: 搜索残留引用**

```bash
rg "shortMemory|shortMemoryList|updateShortMemory|useShortMemory|summaryCounter" src/
```

预期：仅在 `KnowledgeMemoryManager` 的 `updateKnowledgeMemory` 中有合法使用。

- [ ] **Step 2: 完整构建**

```bash
npm run build
```

- [ ] **Step 3: 提交**

```bash
git add -A
git commit -m "chore: final cleanup of memory refactor"
```
