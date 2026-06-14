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

### 2. Impression（印象层，新增）

```typescript
// 新增字段 (MemoryManager)
interface Impression {
  text: string;       // ≤100字，一句印象
  updatedAt: number;  // 秒级时间戳
}

class MemoryManager {
  // ... 现有字段保留 ...
  impressions: { [userId: string]: Impression };   // 新增
  // 删除 shortMemoryList（被印象层代替）
}
```

**生成时机**：每 20 轮用户发言触发一次 `updateImpressions()`，异步调用 LLM。

**生成 prompt（简单格式）**：
```
根据以下对话，为每个发言的用户生成一句简短印象（≤50字）。
只描述性格特点、行为习惯、与他人的关系。不要描述具体事件。

对话: ...

返回 JSON: {"impressions": {"用户ID": "印象文字", ...}}
```

**与当前 shortMemoryList 的差异**：格式更简单（`{uid: text}` map），严格校验 type+length。

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

## 数据迁移

### Phase 1（Bug 修复）：无迁移，纯代码改动。

### Phase 2（POV 作用域）

旧 Memory 对象无 `scope`/`witnesses`/`importance` 字段。
在 `reviveMemoryMap` 中自动推断：
- `scope` = `sessionInfo.isPrivate ? 'private' : 'group'`
- `witnesses` = `[]`（空白，不参与过滤）
- `importance` = `3`（默认一般）

### Phase 3（印象层）

新字段 `impressions`，旧数据无此字段 → 首次触发 `updateImpressions` 时自动生成。

`shortMemoryList` 删除 → 旧短期记忆数据不再使用。

### Phase 4（打分改进）

`search` 方法从单信号改为复合信号 → 无数据迁移，纯计算逻辑变化。

## 删除项

| 删除 | 原因 |
|------|------|
| `shortMemoryList` + `limitShortMemory` + `clearShortMemory` | 被印象层代替 |
| `updateShortMemory()` 复杂 JSON 解析 | 改为 `updateImpressions()` |
| `buildMemoryPrompt` 中遍历所有用户注入记忆 | POV 过滤禁止 |
| `updateMemoryWeight` 旧逻辑 → 新复合打分 | 不再依赖 weight 字段做核心排序 |
| 短期记忆相关配置 `shortMemoryLimit`、`shortMemorySummaryRound` | 被印象更新频率代替 |

## 自检清单

- [ ] 无 TBD/TODO，所有参数有默认值
- [ ] Bug 修复与功能改进分阶段，互不阻塞
- [ ] 旧记忆数据零丢失（自动推断 scope/importance 默认值）
- [ ] 群聊不再注入用户私人记忆（POV 过滤）
- [ ] 印象层始终注入但极小（≤300 tokens）
- [ ] 复合打分不需要向量数据库
- [ ] LLM 精排可选关闭（`memoryShowNumber` ≤ 5 时直接注入，不调精排）
