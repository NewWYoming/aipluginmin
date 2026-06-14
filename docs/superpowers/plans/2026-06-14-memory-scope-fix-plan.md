# 记忆 Scope 修复 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 6 个记忆系统 bug：reviveMemoryMap 重复日志、add/search/clear 三个工具 scope 由 LLM 决定存在越权风险、POV 过滤器安全隐患、向量死代码残留、findGroupInfo ID 格式不一致。

**Architecture:** 渐进修复，每个 Task 独立可提交。先从最简单无风险的开始（Task 1 复活持久化），再到核心行为变更（Task 2 scope 强制推导），最后清理（Task 3-5）。

**Tech Stack:** TypeScript, SeaDice JS plugin, key-value storage

**Spec:** `docs/superpowers/specs/2026-06-14-memory-refactor-design.md`（此为原重构 spec，本 plan 是在其上做 bug 修复）

---

### Task 0: 版本号更新

每次提交 src/ 下的代码后，必须：
1. `src/config/config.ts` `VERSION` patch +1
2. `header.txt` `@version` patch +1
3. 使用 `edit` 工具，禁用 PowerShell `Set-Content`

---

## Task 1: 修复 reviveMemoryMap 清除后不持久

**问题**：`MemoryManager.reviveMemoryMap()` 检测到旧格式记忆后清除 `memoryMap = {}`，但从不调用 `saveAI`。下次加载时存储中的旧数据仍在，再次检测到、再次日志。

**Files:**
- Modify: `src/AI/memory.ts:177-191`（添加脏标记）
- Modify: `src/AI/AI.ts:297-300,318`（检测标记并持久化）

- [ ] **Step 1: 在 reviveMemoryMap 设置脏标记**

```typescript
// memory.ts:177-191 — 在 hasOldFormat 分支添加 _needsSave
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

    // 正常 revival（原有逻辑 — 不变）
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
```

- [ ] **Step 2: 在 getAI 中检测脏标记并持久化**

```typescript
// AI.ts:318 — 在 imageManager/imagePool 连接之后、stolenImages 迁移之前插入
// 确保 imageManager 和 imagePool 共享同一个实例
if (ai.imagePool && ai.imageManager) {
    ai.imageManager.imagePool = ai.imagePool;
}

// 新增：reviveMemoryMap 清除了旧格式记忆，需要持久化
if ((ai.memory as any)._needsSave) {
    AIManager.saveAI(id);
    logger.info(`AI_${id}: 旧格式记忆已清除并持久化`);
}

// Migrate old stolenImages to ImagePool (one-time)
try {
    // ... 原有代码不变 ...
```

- [ ] **Step 3: 构建验证**

```bash
npm run build
```

- [ ] **Step 4: 版本号 + 提交**

```bash
git add src/AI/memory.ts src/AI/AI.ts src/config/config.ts header.txt
git commit -m "fix: persist memoryMap clear on old-format detection to avoid repeated logging"
```

---

## Task 2: add_memory / search_memory / clear_memory — 三个工具的 scope 均由上下文强制推导

**问题**：`add_memory`、`search_memory`、`clear_memory` 三个工具 schema 均暴露 `memory_type: "private" | "group"` 给 LLM。后果：

| 工具 | LLM 在群聊中选 `"private"` 的后果 |
|------|-----|
| `add_memory` | 把群聊记忆错写进用户私人 AI 存储 → 群聊中不可见 |
| `search_memory` | **直接搜任何用户的私人记忆** → 越权读取 |
| `clear_memory` | **直接删任何用户的私人记忆** → 越权删除 |

**修复策略**：
- 三个工具统一从 schema **移除 `memory_type` 参数**
- scope 由当前对话上下文（`ctx.isPrivate`）强制决定
- 群聊中始终操作当前群的 group 记忆；私聊中始终操作当前用户的 private 记忆
- `search_memory` 保留 knowledge 查询能力，通过 `method` 参数或独立 schema 区分
- `name` 参数语义调整为"记忆关联的用户/群名"（仅用于模板展示），不再决定 scope

**Files:**
- Modify: `src/tool/tool_memory.ts`（重写三个工具的 schema 和 solve）

---

### Step 1: 重写 add_memory 工具 — 移除 memory_type

```typescript
// tool_memory.ts:9-101 — 替换整个 toolAdd 定义（schema + solve）
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
    const scope = ctx.isPrivate ? 'private' : 'group';
    let targetAi = ai;

    if (!ctx.isPrivate) {
        // 群聊：记忆存入当前群 AI
        targetAi = AIManager.getAI(ctx.group.groupId);
    }
    // 私聊：ai 就是当前用户的 AI，无需额外操作

    const uiList: UserInfo[] = [];
    for (const n of about) {
        const ui = await ai.context.findUserInfo(ctx, n, true);
        if (ui !== null) uiList.push(ui);
    }
    const giList: GroupInfo[] = [];
    for (const n of groupList) {
        const gi = await ai.context.findGroupInfo(ctx, n);
        if (gi !== null) giList.push(gi);
    }

    await targetAi.memory.addMemory(ctx, targetAi, uiList, giList, Array.isArray(keywords) ? keywords : [], [], text, importance || 3);
    AIManager.saveAI(targetAi.id);
    return { content: `添加记忆成功`, images: [] };
}
```

---

### Step 2: 重写 search_memory 工具 — 移除 memory_type，保留 knowledge 路径

```typescript
// tool_memory.ts:165-299 — 替换整个 toolSearch 定义（schema + solve）
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
                    enum: ['weight', 'similarity', 'score', 'early', 'late', 'recent']
                }
            },
            required: []
        }
    }
});
toolSearch.solve = async (ctx, _, ai, args) => {
    const { target = 'memory', name = '', query = '', topK = 5, keywords = [], userList = [], groupList = [], includeImages = false, method = 'score' } = args;

    // knowledge 路径：不受 scope 限制（知识库是骰主预设的全局数据）
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

    // memory 路径：scope 由上下文强制决定
    let targetAi = ai;
    let si: SessionInfo = { isPrivate: false, id: '', name: '' };
    if (!ctx.isPrivate) {
        // 群聊 → 只能搜当前群的 group 记忆
        targetAi = AIManager.getAI(ctx.group.groupId);
        si = { isPrivate: false, id: ctx.group.groupId, name: ctx.group.groupName };
    } else {
        // 私聊 → 只能搜当前用户的 private 记忆
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
    const images = Array.from(new Set([].concat(...memoryList.map(m => m.images))));
    return { content: targetAi.memory.buildMemory(si, memoryList) || '暂无记忆', images };
}
```

---

### Step 3: 重写 clear_memory 工具 — 移除 memory_type

```typescript
// tool_memory.ts:301-345 — 替换整个 toolClear 定义（schema + solve）
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
    // 私聊：ai 就是当前用户的 AI

    targetAi.memory.clearMemory();
    AIManager.saveAI(targetAi.id);
    return { content: `清除记忆成功`, images: [] };
}
```

---

### Step 4: 日志补充 scope 字段

```typescript
// memory.ts:268 — 在已有日志行补充 scope
logger.info(`新记忆已创建: id=${id}, scope=${m.scope}, 重要性=${importance}, 关键词=[${kws.join(',')}], 文本=${text.slice(0, 50)}`);
```

- [ ] **Step 5: 构建验证**

```bash
npm run build
```

- [ ] **Step 6: 版本号 + 提交**

```bash
git add src/tool/tool_memory.ts src/AI/memory.ts src/config/config.ts header.txt
git commit -m "fix: derive memory scope from context — remove memory_type from add/search/clear tools"
```

---

## Task 3: 删除 getPOVFilteredMemories 不安全的 private 分支

**问题**：`memory.ts:526` 的 `if (m.scope === 'private' && m.sessionInfo.id === currentSessionId)` 允许 private scope 记忆以当前 session ID 匹配通过。在群聊中，若任何 private 记忆的 `sessionInfo.id` 碰巧等于 `group.groupId`（理论上不应发生但因 bug 可能出现），就会泄露。

**修复**：删除该分支。POV 过滤严格按 scope 类型匹配。

**Files:**
- Modify: `src/AI/memory.ts:522-529`

- [ ] **Step 1: 删除不安全分支**

```typescript
// memory.ts:522-529 — 删除 line 526
getPOVFilteredMemories(currentScope: string, currentSessionId: string): Memory[] {
    return this.memoryList.filter(m => {
        if (m.scope === 'universal') return true;
        if (m.scope === currentScope && m.sessionInfo.id === currentSessionId) return true;
        // 删除: if (m.scope === 'private' && m.sessionInfo.id === currentSessionId) return true;
        return false;
    });
}
```

- [ ] **Step 2: 构建验证**

```bash
npm run build
```

- [ ] **Step 3: 版本号 + 提交**

```bash
git add src/AI/memory.ts src/config/config.ts header.txt
git commit -m "fix: remove unsafe private-scope bypass in getPOVFilteredMemories"
```

---

## Task 4: 向量死代码清理

**问题**：设计 spec 明确声明"复合打分不需要向量数据库"，但以下代码残留未清理：
- `Memory.validKeys` 包含 `'vector'` → 序列化/反序列化时携带无用数据
- `addMemory` 无条件调用 `updateVector()` → 配置关掉时浪费 CPU
- `search()` 无条件调用 `getEmbedding(query)` → 同上
- `search()` 中的维度重校验循环 → 同上

**修复**：
- 从 `validKeys` 移除 `'vector'`（旧数据中的 vector 字段在下次 `storageSet` 时自动丢弃）
- `addMemory` 中 `updateVector()` 调用加 `if (isMemoryVector)` 守卫
- `search()` 中 query embedding 调用加 `if (isMemoryVector)` 守卫
- `search()` 中维度重校验加 `if (isMemoryVector)` 守卫

**Files:**
- Modify: `src/AI/memory.ts:22, 265, 318-334`

- [ ] **Step 1: 从 validKeys 移除 vector**

```typescript
// memory.ts:22 — Memory.validKeys
// Before:
static validKeys: (keyof Memory)[] = ['id', 'vector', 'text', 'sessionInfo', 'userList', 'groupList', 'createTime', 'lastMentionTime', 'keywords', 'weight', 'images', 'scope', 'witnesses', 'importance'];

// After:
static validKeys: (keyof Memory)[] = ['id', 'text', 'sessionInfo', 'userList', 'groupList', 'createTime', 'lastMentionTime', 'keywords', 'weight', 'images', 'scope', 'witnesses', 'importance'];
```

- [ ] **Step 2: addMemory — updateVector 加守卫**

```typescript
// memory.ts:265 — 替换
// Before:
await m.updateVector();

// After:
const { isMemoryVector } = ConfigManager.memory;
if (isMemoryVector) {
    await m.updateVector();
}
```

- [ ] **Step 3: search() — query embedding 和维度重校验加守卫**

```typescript
// memory.ts:318-334 — 将整个 query embedding + 维度校验块包入 if (isMemoryVector)
// Before (lines 316-334):
    let qv: number[] = [];
    if (isMemoryVector) {
        qv = await getEmbedding(query) || [];
        if (!qv || qv.length === 0) {
            logger.error('查询向量为空');
            return [];
        }
        
        const { embeddingDimension } = ConfigManager.memory;
        for (const id of this.memoryIds) {
            const m = this.memoryMap[id];
            if (m.vector.length > 0 && m.vector.length !== embeddingDimension) {
                logger.info('记忆向量维度不匹配，重新获取向量: ' + m.id);
                await m.updateVector();
            }
        }
    }

// After — 同逻辑，但将维度重校验的 logger.info 改为 logger.warning:
    let qv: number[] = [];
    if (isMemoryVector) {
        qv = await getEmbedding(query) || [];
        if (!qv || qv.length === 0) {
            logger.error('查询向量为空');
            return [];
        }
        
        const { embeddingDimension } = ConfigManager.memory;
        for (const id of this.memoryIds) {
            const m = this.memoryMap[id];
            if (m.vector.length > 0 && m.vector.length !== embeddingDimension) {
                logger.warning('记忆向量维度不匹配，重新获取向量: ' + m.id);
                await m.updateVector();
            }
        }
    }
```

- [ ] **Step 4: 同时删除 updateVector 中的 logger.info**

```typescript
// memory.ts:137 — 删除该行
// logger.info(`更新记忆向量: ${this.id}`);
```

- [ ] **Step 5: 构建验证**

```bash
npm run build
```

- [ ] **Step 6: 版本号 + 提交**

```bash
git add src/AI/memory.ts src/config/config.ts header.txt
git commit -m "chore: remove vector from validKeys, guard updateVector behind isMemoryVector config"
```

---

## Task 5: findGroupInfo ID 格式统一

**问题**：`findGroupInfo`（context.ts:368-420）在不同匹配路径下返回不同的 `gi.id` 格式：

| 匹配方式 | `gi.id` | 位置 |
|---------|---------|------|
| 纯数字 | `"QQ-Group:${groupName}"` | line 373 |
| 群名匹配当前群 | `ctx.group.groupId` | line 381 |
| API 搜索 | `"QQ-Group:${group_id}"` | line 409 |
| 模糊匹配当前群 | `ctx.group.groupId` | line 415 |

当 `ctx.group.groupId` ≠ `"QQ-Group:..."` 时，记忆的 `sessionInfo.id`（存入时用 `gi.id`）与 `buildMemoryPrompt` 查询时用的 `ctx.group.groupId` 不匹配 → 记忆存了查不出。

**修复**：所有路径统一返回 `ctx.group.groupId` 格式。对于纯数字输入，通过 API 解析后映射到 `ctx.group.groupId` 格式。

**Files:**
- Modify: `src/AI/context.ts:368-420`

- [ ] **Step 1: 统一 ID 格式 — 所有路径返回 ctx.group.groupId**

```typescript
// context.ts:368-420 — 替换 findGroupInfo
async findGroupInfo(ctx: seal.MsgContext, groupName: string | number): Promise<GroupInfo> {
    groupName = String(groupName);
    if (!groupName) return null;

    // 纯数字 → 构造标准 QQ-Group 格式作为 fallback，但优先尝试匹配当前群
    if (groupName.length > 5 && !isNaN(parseInt(groupName))) {
        const gid = `QQ-Group:${groupName}`;
        // 如果恰好是当前群，用 ctx.group.groupId
        if (ctx.group.groupId === gid) {
            return { isPrivate: false, id: ctx.group.groupId, name: ctx.group.groupName };
        }
        // 否则用构造的 gid（标准格式）
        ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, '', gid));
        return { isPrivate: false, id: gid, name: ctx.group.groupName || '未知群聊' };
    }

    const match = groupName.match(/^<([^>]+?)>(?:[\(（]\d+[\)）])?$|(.+?)[\(（]\d+[\)）]$/);
    if (match) groupName = match[1] || match[2];

    if (groupName === ctx.group.groupName) return { isPrivate: false, id: ctx.group.groupId, name: ctx.group.groupName };

    // 在上下文中用户的记忆中查找群聊
    const messages = this.messages;
    const userSet = new Set<string>();
    for (let i = messages.length - 1; i >= 0; i--) {
        const uid = messages[i].uid;
        if (userSet.has(uid) || messages[i].role !== 'user') continue;
        const name = messages[i].name;
        if (name.startsWith('_')) continue;

        for (const m of AIManager.getAI(uid).memory.memoryList) {
            if (m.sessionInfo.isPrivate && m.sessionInfo.name === groupName) return { isPrivate: false, id: m.sessionInfo.id, name: m.sessionInfo.name };
            if (m.sessionInfo.isPrivate && m.sessionInfo.name.length > 4) {
                const distance = levenshteinDistance(groupName, m.sessionInfo.name);
                if (distance <= 2) return { isPrivate: false, id: m.sessionInfo.id, name: m.sessionInfo.name };
            }
        }

        userSet.add(uid);
    }

    // 在群聊列表中查找用户（API）
    if (netExists()) {
        const epId = ctx.endPoint.userId;
        const groupList = await getGroupList(epId);
        if (groupList && Array.isArray(groupList)) {
            const group = groupList.find(item => item.group_name === groupName);
            if (group && group.group_id) {
                const gid = `QQ-Group:${group.group_id}`;
                // 如果恰好是当前群，用 ctx.group.groupId
                if (ctx.group.groupId === gid) {
                    return { isPrivate: false, id: ctx.group.groupId, name: groupName };
                }
                ({ ctx } = getCtxAndMsg(ctx.endPoint.userId, '', gid));
                return { isPrivate: false, id: gid, name: ctx.group.groupName || groupName };
            }
        }
    }

    if (groupName.length > 4) {
        const distance = levenshteinDistance(groupName, ctx.group.groupName);
        if (distance <= 2) return { isPrivate: false, id: ctx.group.groupId, name: ctx.group.groupName };
    }

    logger.warning(`未找到群聊<${groupName}>`);
    return null;
}
```

> **说明**：改动很小。仅在两处增加了"如果恰好是当前群则用 `ctx.group.groupId`"的判断（line 373, line 409 路径）。这确保通过 AI API 查到的群，如果恰好就是当前正在聊的群，`gi.id` 与 `ctx.group.groupId` 一致。对于其他群，`QQ-Group:` 格式本身是稳定的标识符，`addMemory` 时用该格式存入，`buildMemoryPrompt` 时用 `ctx.group.groupId` 查询不匹配是**正确的行为**（因为不同群应该有不同 ID）。

- [ ] **Step 2: 构建验证**

```bash
npm run build
```

- [ ] **Step 3: 版本号 + 提交**

```bash
git add src/AI/context.ts src/config/config.ts header.txt
git commit -m "fix: normalize findGroupInfo id format — prefer ctx.group.groupId when current group matches"
```

---

## 最终验证

- [ ] **Step 1: 完整构建**

```bash
npm run build
```

- [ ] **Step 2: 确认无残留的旧 memory_type 引用**

```bash
rg "memory_type" src/tool/tool_memory.ts
```

预期：仅在 `del_memory` 工具中存在。`del_memory` 保留 `memory_type` 参数是合理的——删除需要明确指定删除哪个场景的记忆，且记忆 ID 本身提供验证（不存在越权问题：群聊中无法知道用户私人记忆的 ID）。

- [ ] **Step 3: 提交**

```bash
git add -A
git commit -m "chore: final verification of memory scope fixes"
```
