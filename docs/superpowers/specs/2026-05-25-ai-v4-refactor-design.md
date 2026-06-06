# AI 调用层激进重构 — 适配 DeepSeek V4

## 背景

aiplugin4 当前的 AI 请求层存在以下结构性问题：

1. **针对旧 API 设计**：默认 URL `/v1/chat/completions`，默认模型 `deepseek-chat`（将于 2026/07/24 废弃）
2. **不支持思考模式**：DeepSeek V4 的 `thinking` + `reasoning_effort` + `reasoning_content` 完全不支持
3. **请求体构建脆弱**：`parseBody()` 将配置模板字符串逐条 JSON.parse 拼接
4. **提示词工程死代码**：为旧模型（deepseek-reasoner/kimi）的无 function calling 模式设计，V4 不再需要
5. **流式输出依赖外部后端代理**：`startStream/pollStream/endStream` 只用于提示词工程下的 function call 标签拦截，失去存在价值
6. **工具调用循环散落在 AI.ts**：无独立抽象，无法按阶段控制思考模式

## 目标

- 原生支持 DeepSeek V4（pro / flash），同时兼容百炼、OpenRouter 等 OpenAI 兼容 API
- 工具调用阶段轻/无思考，回复阶段深度思考，降低延迟与成本
- Provider 可插拔架构，未来新增 API 只需实现接口
- 去除流式输出和提示词工程死代码
- 向下兼容旧配置 key，旧用户无需重新配
- 支持 `.ai shut` 中断工具调用循环

## 方案选择

| 方案 | 概述 | 结论 |
|------|------|------|
| A | 干净分层：AIClient + ToolCallLoop + 独立 AIClientConfig | 架构最清晰但过度设计 |
| B | 最小外科手术：保留现有结构，局部增量 | 技术债累积 |
| **C** | **API 层重写 + ToolCallLoop + 业务层尽量不动** | ✅ **选中** |

## 架构

### 当前架构（问题）

```
用户消息 → index.ts (onNotCommandReceived)
  → AI.chat()
    ├─ parseBody() 模板字符串拼请求体           ← 脆弱，不支持嵌套 JSON
    ├─ sendChatRequest() → fetchData()         ← 单次 HTTP，无 tool loop 抽象
    ├─ 检测 tool_calls / <function> 标签        ← 提示词工程和原生 function call 混在一起
    ├─ 递归 chat('函数回调触发')                 ← 递归实现 tool loop，散落在 AI.ts
    ├─ 流式分支 chatStream()                     ← 仅用于提示词工程标签拦截
    │   └─ startStream → pollStream → endStream  ← 依赖外部后端代理
    └─ handleReply() → replyToSender()
```

核心问题：
1. **AI.chat() 350 行单一方法**，集中了：请求构建、流式/非流式分支、工具调用递归、anti-repeat 重试、回复发送
2. **parseBody 不支持 `thinking: { type: "enabled" }`** 这种嵌套 JSON
3. **工具调用递归无法区分阶段**：整个递归链用同一个 reasoning_effort
4. **提示词工程死代码**（handlePromptToolCall/getToolsPrompt/chatStream 标签拦截）散落三处
5. **旧 service.ts 670 行**混入 HTTP 请求、流式代理、嵌入向量、图表绘制等无关职责

### 新架构

```
用户消息 → index.ts (onNotCommandReceived)
  → AI.chat()                                    ← ~80 行，纯编排
    │
    ├─ handleMessages(ctx, ai)                   ← 构建上下文 (保留)
    │
    ├─ new AIClient(config)                      ← 创建 HTTP 客户端
    │   └─ provider = getProvider('deepseek-v4') ← 工厂选择
    │
    ├─ 有工具: new ToolCallLoop(client, config).run(messages, tools)
    │   │
    │   │  ┌────────────────────── 循环 ──────────────────────┐
    │   │  │                                                 │
    │   │  │  client.chat(messages, tools, 'auto',           │
    │   │  │    { enabled: false })    ← 工具阶段不思考       │
    │   │  │       ↓                                         │
    │   │  │  response.tool_calls?                           │
    │   │  │    YES → addToolCallsMessage → 执行工具           │
    │   │  │        → addToolMessage + reasoning_content 回传 │
    │   │  │        → continue                               │
    │   │  │    NO  → break                                  │
    │   │  │                                                 │
    │   │  └──────────────── 上限保护 (maxCallCount) ────────┘
    │   │
    │   └─ client.chat(messages, null, 'none',
    │        { enabled: true, effort: 'high' })  ← 最终回复深度思考
    │
    ├─ 无工具: client.chat(messages, null, 'none') ← 直接对话
    │
    └─ handleReply() → replyToSender()                ← 发送回复 (保留)
```

关键改进：
- **AI.chat() 从 350 行缩减到 ~80 行**，只做编排不做细节
- **ToolCallLoop** 独立管理工具循环，自动切换思考模式
- **AIClient** 单一 HTTP 职责，可被 ToolCallLoop、embedding、ITT 复用
- **Provider** 策略模式，body 构建/response 解析完全隔离

### 组件职责

```
                     ┌──────────────┐
                     │   AI.chat()  │  编排层：构建上下文 → 分发 → 回复
                     └──────┬───────┘
                            │
              ┌─────────────┼─────────────┐
              │             │             │
     ┌────────▼──────┐ ┌───▼────────┐ ┌──▼───────────┐
     │  ToolCallLoop │ │  AIClient  │ │ handleReply() │
     │  工具调用循环   │ │  HTTP 请求 │ │  回复发送     │
     └───────┬───────┘ └─────┬──────┘ └──────────────┘
             │               │
             │        ┌──────▼──────┐
             │        │  Provider   │  请求体构建 / 响应解析
             │        └──────┬──────┘
             │               │
             │    ┌──────────┼──────────┐
             │    │          │          │
             │  ┌─▼────────┐ ┌▼──────────────┐
             │  │deepseek  │ │openai-compat   │
             │  │ -v4.ts   │ │ ible.ts        │
             │  └──────────┘ └────────────────┘
             │
      ┌──────▼──────┐
      │ ToolManager │  工具注册 / handleToolCall / handleToolCalls
      └──────┬──────┘
             │
      ┌──────┴──────┐
      │ tool_*.ts   │  各工具实现 (保留不变)
      └─────────────┘
```

### Provider 注册表

| Provider | 差异点 | 
|----------|--------|
| `deepseek-v4` | thinking/reasoning_effort/reasoning_content 回传，默认模型 v4-pro，默认 URL api.deepseek.com |
| `openai-compatible` | 标准 OpenAI 行为，零魔改，不限模型名，默认 URL api.openai.com |
| 未来 `bailian` | `enable_search` 等百炼专有 body 字段 |
| 未来 `openrouter` | 自定义 headers（HTTP-Referer/X-Title）+ 专有 body 字段 |

### 配置兼容策略

旧配置 key 名全部保留，V5 新增 key 以新名称注册：

| 旧 key（保留） | 默认值 | 用途 |
|------|------|------|
| `url地址` | `https://api.deepseek.com/chat/completions` | API 地址（默认值从 v1 路径升级） |
| `API Key` | `你的API Key` | 不变 |
| `body` (template) | 含 model/max_tokens/temperature 等 | 兼容旧用户，`get()` 自动解析为结构化字段 |
| `请求超时时限/ms` | 180000 | 不变 |

| 新 key（V5 新增） | 默认值 | 用途 |
|------|------|------|
| `API 提供方` | deepseek-v4 | 选择策略（deepseek-v4 / openai-compatible） |
| `启用思考模式` | true | 最终回复是否深度思考 |
| `回复推理强度` | high | low / medium / high / max |
| `工具阶段启用思考` | false | 工具选择时是否思考（默认关闭加速） |
| `工具阶段推理强度` | minimal | minimal / low / medium |

### 一次完整请求的生命周期

```
1.  用户发消息 → ext.onNotCommandReceived(ctx, msg)
2.  AIManager.getAI(sid) → 获取/恢复 AI 实例
3.  ai.checkActiveTimer() → 活跃时间检查
4.  触发条件满足 → ai.chat(ctx, msg, '非指令')
5.    ├─ 令牌桶检查 (bucketLimit / fillInterval)
6.    ├─ toolsNotAllow 过滤
7.    ├─ resetState() → 清空计数器/上限
8.    ├─ new AIClient(config) → 构建客户端 + 选择 provider
9.    ├─ handleMessages() → 构建 messages 数组
10.   │  ├─ buildSystemMessage() → system prompt (角色/记忆/函数)
11.   │  ├─ buildSamplesMessages() → 示例对话
12.   │  ├─ buildContextMessages() → 上下文 + system 插入
13.   │  └─ 合并/过滤 tool_calls → 输出 OpenAI 格式
14.   ├─ ToolCallLoop.run(messages, tools)
15.   │  ├─ provider.buildRequestBody(messages, tools, auto, {enabled:false})
16.   │  │   → DeepSeek: { thinking: {type:"disabled"}, ... }
17.   │  │   → OpenAI: 直接构建 body, 无 thinking 字段
18.   │  ├─ client.fetchChat() → fetch() + 错误处理 + 日志
19.   │  ├─ provider.parseResponse() → ChatResponse
20.   │  │   → DeepSeek: 提取 reasoning_content
21.   │  │   → OpenAI: 标准 OpenAI choice 解析
22.   │  ├─ tool_calls? YES:
23.   │  │   → addToolCallsMessage() → context 写入
24.   │  │   → ToolManager.handleToolCalls() → 逐条执行
25.   │  │   → addToolMessage() → context 写入
26.   │  │   → 从 context 回读 tool 结果 → 追加到 API messages
27.   │  │   → continue (上限检查)
28.   │  ├─ tool_calls? NO: break
29.   ├─ provider.buildRequestBody(messages, null, none, {enabled:true, effort:high})
30.   │   → DeepSeek: { thinking: {type:"enabled"}, reasoning_effort:"high" }
31.   ├─ client.chat() → 最终回复
32.   ├─ handleReply() → 文本处理 (引用/图片/CQ码)
33.   └─ replyToSender() → 发送给用户
34.  AIManager.saveAI(sid) → 持久化
```

### 分阶段思考配置

```typescript
// 新增到 config_request.ts
{
  apiProvider: "deepseek-v4" | "openai-compatible";
  model: "deepseek-v4-pro" | "deepseek-v4-flash" | 自定义;
  
  // 思考阶段控制
  thinkingEnabled: boolean;               // 是否启用思考模式
  reasoningEffort: "low" | "medium" | "high" | "max"; // 最终回复思考强度
  
  // 工具阶段思考（可选关闭以加速工具选择）
  toolThinkingEnabled: boolean;           // 默认 false
  toolReasoningEffort: "minimal" | "low" | "medium"; // 默认 "minimal"
  
  // 基础参数
  maxTokens: number;                      // 原 body 模板中的 max_tokens
  temperature?: number;                   // 非思考模式下有效
  topP?: number;
  
  // 兼容性
  extraBody: Record<string, any>;         // 追加 provider 专有字段
}
```

## 关键设计决策

### 1. reasoning_content 管理策略

DeepSeek 文档明确：工具调用回合的 reasoning_content 必须在后续所有请求中回传，否则 API 返回 400。

- **ToolCallLoop 负责回传**：每次 tool_calls 响应后，将 assistant message（含 reasoning_content）追加到 messages 数组
- **Context.Message 增加字段**：`reasoning_content?: string`
- **非 DeepSeek provider 忽略**：openai-compatible provider 不回传 reasoning_content

### 2. 流式输出移除

- 当前流式唯一的实际用途：提示词工程模式下实时拦截 `<function>` 标签
- 原生 function calling 不需要流式
- QQ 机器人一次性发送完整消息，流式无体验提升
- 删除：`chatStream/stopCurrentChatStream/startStream/pollStream/endStream`、`AI.stream` 属性、`streamUrl` 配置项
- `.ai shut` 改为：通过 AbortSignal 取消 ToolCallLoop

### 3. 提示词工程移除

- V4 全系 + 当前主流模型均支持原生 function calling
- 删除：`handlePromptToolCall`、`usePromptEngineering` 配置项、`toolsPromptTemplate`
- `.ai tool` 试用指令不受影响（走 Tool.solve 直接调用）

### 4. body 模板兼容保留

- 旧 `parseBody()` 将 `["model:xxx", "max_tokens:1024"]` 模板字符串拼成 JSON，不支持嵌套对象
- 新方案：**保留 `body` 配置 key 和模板格式**，`get()` 内部自动解析 model/maxTokens/temperature/topP
- body 中未知字段原样保留到 `extraBody`，追加到请求体
- 旧用户无需修改 body 配置即可无缝升级

### 5. 缓存友好

DeepSeek 硬磁盘缓存匹配消息内容前缀（token 0 起），不匹配 HTTP 参数。
- 分阶段切换 thinking 不影响缓存命中率
- system prompt + 共享历史始终缓存命中
- 工具调用循环中每个子请求的共享前缀逐渐变长，成本递减

## 配置项迁移

旧配置 key 名全部保留，V5 新增 key 以新名称注册。`get()` 内部自动解析旧 `body` 模板提取 model/maxTokens/temperature 等字段。

| 旧配置 key | 状态 | V5 新增 key |
|------|------|------|
| `url地址` | ✅ 保留（默认值升级到 V4 URL） | — |
| `API Key` | ✅ 保留 | — |
| `body` (template) | ✅ 保留（`get()` 解析为结构化字段） | — |
| `请求超时时限/ms` | ✅ 保留 | — |
| — | 新增 | `API 提供方`（deepseek-v4 / openai-compatible） |
| — | 新增 | `启用思考模式`（bool, 默认 true） |
| — | 新增 | `回复推理强度`（low/medium/high/max） |
| — | 新增 | `工具阶段启用思考`（bool, 默认 false） |
| — | 新增 | `工具阶段推理强度`（minimal/low/medium） |

## 风险

| 风险 | 缓解 |
|------|------|
| 大规模重构引入 bug | 保留 AI.ts handleReceipt + handleReply + AIManager 不变；ToolCallLoop 有上限保护；非 DeepSeek provider 行为零变化 |
| runtime tool call 循环 bug | 已通过实际部署调试修复（addToolCallsMessage 遗漏 + tool 消息回读逻辑）；后续增补测试 |
| reasoning_content 回传遗漏 | ToolCallLoop 统一管理，单点职责；DeepSeek provider 在 buildRequestBody 中自动回传 |
| 旧存储数据兼容 | AIManager.getAI 的 revive 逻辑不变；新增字段有默认值；旧 body 模板 key 保留 |
| 旧用户迁移成本 | 旧配置 key 全部保留；V5 新增 key 使用默认值；body 模板透明兼容 |

## 不涉及

- 记忆系统核心逻辑（memory.ts — 仅 import 路径更新）
- 图片管理核心逻辑（image.ts — 仅 import 路径更新）
- 命令系统核心逻辑（cmd/ — 仅 shut.ts 适配新流程，token.ts import 路径更新）
- 各工具实现（tool/tool_*.ts — 仅 tool_message.ts send_msg 改原生 tool call）
- 上下文构建（handleMessages/buildContent — 仅移除提示词工程引用）
- 权限系统（privilege.ts）
