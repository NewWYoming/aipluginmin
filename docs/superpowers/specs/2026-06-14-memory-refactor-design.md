# 记忆系统重构 — 设计文档

## 目标

修复当前记忆系统的核心 bug，增加 POV 作用域隔离、自动印象层、复合相关性打分，解决"记忆淹没当前对话"和"私聊信息泄露到群聊"两个核心痛点。

## 当前问题

### Bug 级

| 问题 | 位置 | 影响 |
|------|------|------|
| `updateMemoryWeight` 的 `Math.max/Min` 用反 | memory.ts:451,454 | 权重锁定在 0 或 ≥10，无中间态 |
| `limitMemory()` 在 `memoryMap[id]=m` 之前执行 | memory.ts:229 | 新记忆还没存进去就开始淘汰 |
| 群聊遍历所有用户注入 N×5 条个人记忆 | memory.ts:554-567 | 5 人群 = 25 条记忆，淹没当前对话 |

### 架构级

| 问题 | 根因 |
|------|------|
| 无 POV 边界 | 私聊记忆在群聊中可见，跨群记忆不隔离 |
| 记忆相关性判断粗糙 | 纯 `keywords.includes()` 子串匹配，换个说法就失联 |
| 权重系统崩坏 | 除 bug 外，无新近度衰减、无重要性分级 |
| 记忆创建完全手动 | AI 必须主动调用 `add_memory` 工具 |
| 短期记忆 JSON 脆弱 | AI 返回格式错误 → 静默失败 |

## 架构

```
┌─ System Prompt ──────────────────────────────────┐
│ 角色设定                                            │
│                                                    │
│ 【Layer 1 — 印象层】始终注入，≤300 tokens              │
│   Alice: 程序员，说话爱用梗，喜欢逗你                  │
│   Bob: 沉默寡言，偶尔冒金句                          │
│                                                    │
│ 【Layer 2 — 长期记忆】POV过滤 + 复合打分 + LLM精排     │
│   如果记忆与角色设定冲突，忽略记忆。记忆如下:            │
│   记忆1: [...]    (scope=group, 只在本群可见)          │
│   记忆2: [...]    (scope=universal)                  │
│   (群聊中不注入 private，跨群不注入)                   │
│                                                    │
│ 知识库（如有）                                       │
│                                                    │
│ 【Budget】总记忆文字 ≤ 当前对话 40%                    │
│   超过时从 Layer 2 末尾截断                          │
├────────────────────────────────────────────────────┤
│ 示例对话（如有）                                     │
├────────────────────────────────────────────────────┤
│ 对话消息 (最近 maxRounds 轮)                         │
└────────────────────────────────────────────────────┘
```

## 组件

### 1. Memory 扩展

```typescript
// 新增字段 (memory.ts)
class Memory {
  // ... 现有字段保留 ...
  scope: 'private' | 'group' | 'universal';   // 新增：作用域
  witnesses: string[];                          // 新增：创建时在场的用户 ID
  importance: 1 | 3 | 5;                       // 新增：重要性等级
}
```

**作用域规则：**
- `private`：在私聊中创建 → 只在同用户私聊中注入
- `group`：在群聊中创建 → 只在本群中注入
- `universal`：跨场景记忆（角色设定、世界知识）→ 所有场景注入
- 旧数据迁移：`reviveMemoryMap` 时从 `sessionInfo.isPrivate` 推断

**重要性等级：**
| 等级 | 含义 | 分值 | 示例 |
|------|------|------|------|
| 5 | 核心事实 | 0.8 | 用户身份、重要偏好、明确说"记住"的 |
| 3 | 一般信息 | 0.5 | 值得记住但非关键 |
| 1 | 琐碎 | 0.2 | 聊到但不需要长期记的 |

### 2. Impression（印象层，三层增量架构）

**设计原则**：不每次重写，而是攒够观察证据后才更新。参考 MumuBot、MaiBot 等行业实践。

#### 数据结构

```typescript
// MemoryManager 新增字段
interface UserObservation {
  rawMessages: string[];     // 原始发言缓存，上限 maxObservedMessages 条
  msgCount: number;          // 总发言数（累计，不清零）
  lastSpeak: number;         // 最后发言时间戳（秒）
}

interface Impression {
  text: string;              // ≤80字，空串视为"无印象"
  updatedAt: number;         // 秒级时间戳
}

class MemoryManager {
  // ... 现有字段保留 ...
  impressions: { [userId: string]: Impression };    // 新增：印象层
  observations: { [userId: string]: UserObservation }; // 新增：观察缓存
  // 删除 shortMemoryList（被印象层代替）
}
```

**印象规则**：
- 新用户默认无印象（`impressions[uid]` 不存在）
- 空印象（`text === ''` 或不存在）→ 不注入上下文
- 只有非空印象才注入

#### 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `maxObservedMessages` | 10 | 缓存上限，满了触发印象更新 |
| `impressionMaxAge` | 3 天 | 印象超过此天数未更新即触发刷新 |
| `impressionMaxLength` | 80 字 | 单条印象最大长度 |
| `cleanupInactiveDays` | 30 天 | 最后发言超过此天数 → 清理印象和观察数据 |

#### Tier 1 — 静默收集（每条消息，零 LLM 成本，不抢回复触发）

```
用户发言 → addMessage()
  → observations[uid].rawMessages.push(发言内容)
  → observations[uid].msgCount += 1
  → observations[uid].lastSpeak = now()

如果 rawMessages.length ≥ maxObservedMessages → 触发 Tier 2
```

#### Tier 2 — 攒够更新（阈值触发，1 次 LLM 调用）

```
触发条件（任一满足）:
  A. rawMessages.length ≥ maxObservedMessages（默认 10 条）
  B. 已有印象且 (now - impression.updatedAt) > impressionMaxAge（默认 3 天）

触发动作:
  1. 取出 rawMessages 和当前印象（可能为 null）
  2. 调用 LLM 更新印象:

     系统: 你正在根据最近的观察，更新对某个群友的简短印象。
     当前印象: {旧印象 text，首次为 "无"}
     最近观察:
       {rawMessages 逐条列出}
     
     请用 ≤80 字更新印象。只描述性格特点、说话风格、行为习惯。
     不要描述具体事件。如果初次观察，给出初次印象。
     返回 JSON: {"impression": "印象文字"}

  3. 存回 impressions[uid] = { text, updatedAt: now }
  4. 清空 rawMessages = []
```

**关键差异 vs 原方案**：
| 维度 | 原方案（每 20 轮批量重写） | 新方案（增量积累） |
|------|--------------------------|-------------------|
| 数据量 | 5-10 人 × 2-3 句 = 极稀 | 等攒够 10 句才处理 |
| LLM 成本 | 频繁（每 20 轮一次全量） | 稀疏（阈值触发，单用户） |
| 印象质量 | 浅层快照，下次可能丢失 | 基于累积观察提炼 |
| 与回复触发冲突 | 可能抢在聊天中间触发 | addMessage 中判断，不额外延迟 |
| 覆盖丢失 | 沉默 2 轮就丢了 | 持久保存，3 天内不退化 |

#### 印象注入（始终）

```
buildSystemMessage 时:
  遍历 context 中当前活跃的用户 → 取各用户的印象 → 过滤:
    - 印象为空（text === '' 或不存在）→ 跳过
    - 印象非空 → 拼接:
  "Alice: 程序员，说话爱用梗，喜欢逗你\nBob: 沉默寡言，偶尔冒金句"
  总长度 ≤ 300 tokens（≈ 8-10 条印象）
```

#### 印象清理（每天 0 点）

```
定时触发（借助 timer 系统或 AI.checkActiveTimer）:
  1. 已退群用户 → 删除印象 + observations
     (对比当前群成员列表，印象中存在但成员列表中不存在的 uid)
  2. 最后发言超过 cleanupInactiveDays（默认 30 天）→ 删除印象 + observations
```

仅群聊 AI 实例执行清理——私聊 AI 实例跳过（私聊只有两个参与者，清理无意义）。

### 3. 相关性打分（改进 MemoryManager.search）

**第一层：复合预筛**（微秒级，零 LLM 调用）

```
keyword_jaccard = |query词 ∩ memory关键词| / |query词 ∪ memory关键词|
recency = exp(-ln(2) × 天数 / 14)     ← 14 天半衰期
importance = {1→0.2, 3→0.5, 5→0.8}   ← 写入时的等级

base_score = 0.50 × keyword_jaccard + 0.30 × recency + 0.20 × importance
```

**第二层：LLM 精排**（1 次 API 调用）

```
取 base_score top 20 → LLM 一次返回关联度评分 0-5 → 综合:
final_score = 0.7 × LLM 评分 + 0.3 × base_score

取 top memoryShowNumber 条注入
低于阈值 0.2 的不注入（防止噪声）
```

**对比旧系统**：

| 维度 | 旧 | 新 |
|------|-----|-----|
| 关键词匹配 | `s.includes(kw)` 子串 | Jaccard 重叠 |
| 新近度 | 无 | exp 指数衰减 |
| 重要性 | 无 | 1/3/5 三级 |
| 精排 | 无 | LLM 重排 top 20 |
| 关键词提权 | `weight += 10`（暴力提权） | 纳入 Jaccard 分数中，不再变更 weight |

### 4. POV 过滤（新增）

```typescript
// memory.ts 新增方法
getPOVFilteredMemories(text, ui, gi, currentScope, currentSessionId) {
  return this.memoryList.filter(m => {
    if (m.scope === 'universal') return true;
    if (m.scope === currentScope && m.sessionInfo.id === currentSessionId) return true;
    if (m.scope === 'private' && m.sessionInfo.id === currentSessionId) return true;
    return false;
  });
}
```

**注入规则：**
| 当前场景 | 可见 scope | 不可见 |
|---------|-----------|--------|
| 私聊 with Alice | Alice 的 private + universal | 其他人的 private、任何 group |
| 群聊 A | A 的 group + universal | 任何 private、群 B 的 group |

**删除**：`buildMemoryPrompt` 中遍历 `context.userInfoList` 注入所有用户私人记忆的代码段（memory.ts:553-567）。

### 5. Token 预算控制

```
记忆注入总字数 ≤ 当前对话字数的 40%

超过时:
  1. 印象层始终保留（极小，≤300 tokens）
  2. 从 Layer 2 末尾截断（低分记忆先被裁）
  3. 追加 "(记忆已截断)" 标记
```

### 6. Bug 修复（独立于新功能）

| 修复 | 改动 |
|------|------|
| `Math.max(10, w+i)` → `Math.min(10, w+i)` | memory.ts:451 |
| `Math.min(0, w-d)` → `Math.max(0, w-d)` | memory.ts:454 |
| `limitMemory` 移到 `memoryMap[id]=m` 之后 | memory.ts:229-230 |
| 记忆展示模板变量名不匹配：`{{{用户列表}}}` → `{{{相关用户}}}`，`{{{群聊列表}}}` → `{{{相关群聊}}}` | config_memory.ts:57 |

## 数据迁移

### Phase 1（Bug 修复）：无迁移，纯代码改动。

### Phase 2（POV 作用域）

旧 Memory 对象无 `scope`/`witnesses`/`importance` 字段。
在 `reviveMemoryMap` 中自动推断：
- `scope` = `sessionInfo.isPrivate ? 'private' : 'group'`
- `witnesses` = `[]`（空白，不参与过滤）
- `importance` = `3`（默认一般）

### Phase 3（印象层）

新字段 `impressions` 和 `observations`，旧数据无此字段 → 首次用户发言时自动初始化空 `observations`，攒够 `maxObservedMessages` 条后触发首次印象生成。

`shortMemoryList` 删除 → 旧短期记忆数据不再使用。

### Phase 4（打分改进）

`search` 方法从单信号改为复合信号 → 无数据迁移，纯计算逻辑变化。

## 删除项

### 代码删除

| 删除 | 位置 | 原因 |
|------|------|------|
| `shortMemoryList` + `limitShortMemory()` + `clearShortMemory()` + `updateShortMemory()` | memory.ts:148-155, 266-393 | 被观察缓存 + 印象层代替 |
| `useShortMemory` 字段 | memory.ts, validKeys+构造 | 不再需要开关 |
| `Context.summaryCounter` 字段 + validKeys | context.ts:33,43 | 仅用于短期记忆轮数计数 |
| `context.ts:147-155` 短期记忆触发块 | context.ts | 被印象层阈值触发代替 |
| `buildMemoryPrompt` 中遍历所有用户注入记忆 (553-567行) | memory.ts | POV 过滤禁止 |
| `updateMemoryWeight` 旧逻辑 | memory.ts:443-456 | 修复 bug 后保留。weight 仍用于 `limitMemory()`(decay × weight)，但 `search()` 改用复合打分。`context.ts:159` 调用 `updateRelatedMemoryWeight` 保留。 |
| `.ai memo short` 命令树 | cmd/sub_cmd/memory.ts:217-264 | 引用已删除功能 |
| `buildSystemMessage` 中 `{{#if 开启短期记忆}}` 模板段 | utils_message.ts:39-44, config_message.ts:60-64 | 印象层代替 |
| `sandableImagesPrompt` 模板变量（如果仍残留） | utils_message.ts | 图片重构时已清理，确认 |

### 配置删除

| 配置 key | 位置 | 原因 |
|----------|------|------|
| `是否启用短期记忆` (`isShortMemory`) | config_memory.ts | 不再需要 |
| `短期记忆上限` (`shortMemoryLimit`) | config_memory.ts | 被 `maxObservedMessages` 代替 |
| `短期记忆总结轮数` (`shortMemorySummaryRound`) | config_memory.ts | 被印象阈值触发代替 |
| `记忆总结 url地址` + `记忆总结 API Key` + `记忆总结 body` + `记忆总结 prompt模板` | config_memory.ts | 仅用于 `updateShortMemory()`，一同删除 |

## 新增配置

| 配置 key | 类型 | 默认值 | 说明 |
|----------|------|--------|------|
| `观察缓存上限` | IntConfig | 10 | 等于 `maxObservedMessages` |
| `印象最长天数` | IntConfig | 3 | 等于 `impressionMaxAge` |
| `印象最大字数` | IntConfig | 80 | 等于 `impressionMaxLength` |
| `清理沉默天数` | IntConfig | 30 | 等于 `cleanupInactiveDays` |

## 跨模块变更清单

### 必须同步修改的文件（除 memory.ts 外）

| 文件 | 变更 |
|------|------|
| `src/AI/context.ts` | 删除 `summaryCounter` validKeys+字段；删除 `updateShortMemory` 调用；替换为印象层 Tier 1 收集逻辑；`updateRelatedMemoryWeight` 保留但简化（仅做关键词匹配提权，不再主导排序） |
| `src/AI/AI.ts` | 删除 `reply()` 中随机发图引用（如未清理）；印象清理通过 `checkActiveTimer` 或新 timer 触发 |
| `src/utils/utils_message.ts` | 删除短期记忆相关模板变量 (`isShortMemory`, `shortMemoryList`)；新增印象层模板变量 (`impressions`) |
| `src/config/config_message.ts` | 删除 `{{#if 开启短期记忆}}` 模板段；新增印象层模板段（在长期记忆之前） |
| `src/config/config_memory.ts` | 删除 6 个短期记忆相关 config key；新增 4 个印象层 config key；更新 `get()` 返回值 |
| `src/cmd/sub_cmd/memory.ts` | 删除 `case 'short':` 和 `case 'sum':` 块；更新 help 文本 |
| `src/tool/tool_memory.ts` | `add_memory` 参数新增可选 `importance` (1/3/5) 和 `scope`（自动从 `memory_type` 推导）；`del_memory` 不变 |

### validKeys 更新

| 类 | 新增 | 删除 |
|-----|------|------|
| `Memory` | `'scope'`, `'witnesses'`, `'importance'` | — |
| `MemoryManager` | `'impressions'`, `'observations'` | `'useShortMemory'`, `'shortMemoryList'` |
| `Context` | — | `'summaryCounter'` |

### 模板变量变更

| 变量 | 旧来源 | 新处理 |
|------|--------|--------|
| `开启短期记忆` | `isShortMemory` config | **删除** |
| `短期记忆信息` | `shortMemoryList.join()` | **删除** |
| `可发送图片不为空` | `sandableImagesPrompt` | （图片重构时已清理，确认） |
| `印象层` | 无 | **新增**：`impressions` map → 拼接文本 |

### add_memory 工具 API 变更

```typescript
// tool_memory.ts — add_memory 参数扩展
parameters: {
  type: 'object',
  properties: {
    text: { type: 'string', description: '记忆内容' },
    memory_type: { type: 'string', enum: ['private', 'group'] },
    keywords: { type: 'array', items: { type: 'string' } },
    importance: { type: 'number', enum: [1, 3, 5], description: '重要性: 5=核心, 3=一般, 1=琐碎', default: 3 },
    // scope 自动从 memory_type 推导: private→'private', group→'group'
  }
}
```

### LLM 精排集成方式

`search()` 保持同步（不做异步 LLM 调用）。精排作为 `search()` 的**后处理步骤**，在 `buildMemoryPrompt` 中调用：

```
search() → 返回 preScore top 20 → buildMemoryPrompt 中调用 async llmRerank()
  → 返回 final top-K → 注入
```

若 `memoryShowNumber` ≤ 5 → 跳过 LLM 精排，直接注入（省 API 调用）。

### 印象清理定时器

借助现有 `TimerManager` 或 `AI.checkActiveTimer`：

```
每天 0 点:
  群聊 AI 实例:
    1. 获取当前群成员列表（SeaDice API）
    2. impressions 中 uid 不在成员列表 → 删除印象 + observations
    3. observations[uid].lastSpeak 超过 cleanupInactiveDays → 删除印象 + observations
  私聊 AI 实例: 跳过
```

## 数据迁移补充

### 旧数据丢弃

以下字段从 `validKeys` 移除后，再次 `storageSet` 时将不再序列化，旧数据隐形丢弃：
- `MemoryManager.useShortMemory` + `MemoryManager.shortMemoryList`
- `Context.summaryCounter`

这些数据本身不参与未来逻辑，丢弃是安全的、预期的。

### KnowledgeMemoryManager

知识库记忆的 scope 统一设置为 `'universal'`（跨场景可见），不受 POV 过滤限制。`knowledgeMM.search()` 无需修改。

## 自检清单

- [ ] 无 TBD/TODO，所有参数有默认值
- [ ] Bug 修复与功能改进分阶段，互不阻塞
- [ ] 旧记忆数据零丢失（自动推断 scope/importance 默认值）
- [ ] 旧短期记忆/impression 数据丢弃是预期的（validKeys 移除）
- [ ] 群聊不再注入用户私人记忆（POV 过滤）
- [ ] 新用户默认无印象，空印象不注入上下文
- [ ] 每天 0 点清理长期沉默用户和已退群用户的印象数据
- [ ] 复合打分不需要向量数据库
- [ ] LLM 精排可选关闭（`memoryShowNumber` ≤ 5 时直接注入，不调精排）
- [ ] 所有跨模块引用已更新（context.ts, utils_message.ts, config_message.ts, config_memory.ts, cmd/sub_cmd/memory.ts, tool_memory.ts）
- [ ] 所有 validKeys 已更新（Memory, MemoryManager, Context）
- [ ] 系统消息模板已添加印象层、删除短期记忆段
