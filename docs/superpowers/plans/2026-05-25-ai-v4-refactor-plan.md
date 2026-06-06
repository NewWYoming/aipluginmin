# AI 调用层重构 — DeepSeek V4 适配 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构 AI HTTP 请求层，原生支持 DeepSeek V4 思考模式，Provider 可插拔，移除提示词工程和流式输出死代码。

**Architecture:** `src/service/` 替换 `src/service.ts`，新增 AIClient（HTTP 层）+ ToolCallLoop（工具循环）+ Provider 策略模式。`AI.chat()` 从厚重分支简化为编排层。

**Tech Stack:** TypeScript, esbuild, SeaDice runtime, DeepSeek V4 API (OpenAI-compatible)

**验证方式：** 每阶段完成后运行 `npm run build` 确认无 TypeScript/构建错误。本项目无测试框架。

---

## Phase 1: Provider 基础设施 + AIClient

### Task 1: 创建 Provider 抽象基类

**Files:**
- Create: `src/service/providers/base.ts`

- [ ] **Step 1: 创建 Provider 接口**

```typescript
// src/service/providers/base.ts
import { Image } from '../../AI/image';

// --- 请求/响应类型（AIClient 通用）---

export interface ChatRequest {
  messages: OpenAIMessage[];
  tools?: ToolInfo[];
  tool_choice?: string;
  // thinking 由 Provider 内部注入，调用方不感知
}

export interface OpenAIMessage {
  role: string;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;     // DeepSeek 独有，其他 provider 忽略
}

export interface ToolInfo {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: { [key: string]: any };
      required: string[];
    };
  };
}

export interface ToolCall {
  index: number;
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatResponse {
  content: string;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  finish_reason: string;
  model: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

export interface ImageRequest {
  messages: {
    role: string;
    content: { type: string; image_url?: { url: string }; text?: string }[];
  }[];
  model: string;
  max_tokens: number;
}

// --- AIClient 配置 ---

export interface ThinkingConfig {
  enabled: boolean;
  effort: string;   // 'minimal' | 'low' | 'high' | 'max'
}

export interface AIClientConfig {
  apiProvider: string;
  url: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  timeout: number;

  // 思考配置
  thinkingEnabled: boolean;
  reasoningEffort: string;
  toolThinkingEnabled: boolean;
  toolReasoningEffort: string;

  // 兼容
  temperature?: number;
  topP?: number;
  extraBody: Record<string, any>;
}

// --- Provider 抽象基类 ---

export abstract class ChatProvider {
  abstract name: string;
  abstract defaultModel: string;
  abstract defaultUrl: string;
  abstract supportsThinking: boolean;
  abstract supportsReasoningEffort: boolean;

  /** 构建完整请求体（含 provider 专有字段） */
  abstract buildRequestBody(
    config: AIClientConfig,
    messages: OpenAIMessage[],
    tools: ToolInfo[] | null,
    tool_choice: string | null,
    thinkingOverride?: ThinkingConfig,  // ToolCallLoop 可覆盖思考配置
  ): any;

  /** 解析 API 响应 */
  abstract parseResponse(data: any): ChatResponse;

  /** 额外 HTTP headers（如 OpenRouter 的 HTTP-Referer） */
  getExtraHeaders(_config: AIClientConfig): Record<string, string> {
    return {};
  }
}
```

- [ ] **Step 2: 运行构建验证**

```
npm run build
```
预期：通过（新文件未被引用，不影响）

- [ ] **Step 3: Git commit**

```
git add src/service/providers/base.ts
git commit -m "feat: add ChatProvider abstract base and request/response types"
```

---

### Task 2: 实现 openai-compatible Provider

**Files:**
- Create: `src/service/providers/openai-compatible.ts`

- [ ] **Step 1: 实现标准 OpenAI 兼容 Provider**

```typescript
// src/service/providers/openai-compatible.ts
import {
  ChatProvider, ChatResponse, AIClientConfig, OpenAIMessage,
  ToolInfo, ThinkingConfig,
} from './base';

export class OpenaiCompatibleProvider extends ChatProvider {
  name = 'openai-compatible';
  defaultModel = '';
  defaultUrl = 'https://api.openai.com/v1/chat/completions';
  supportsThinking = false;
  supportsReasoningEffort = false;

  buildRequestBody(
    config: AIClientConfig,
    messages: OpenAIMessage[],
    tools: ToolInfo[] | null,
    tool_choice: string | null,
    _thinkingOverride?: ThinkingConfig,
  ): any {
    const body: any = {
      model: config.model,
      messages: messages.map(m => {
        const msg: any = { role: m.role, content: m.content };
        if (m.tool_calls) msg.tool_calls = m.tool_calls;
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        return msg;
      }),
      max_tokens: config.maxTokens,
      stream: false,
      ...config.extraBody,     // 用户自定义字段
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = tool_choice || 'auto';
    }

    if (config.temperature !== undefined) body.temperature = config.temperature;
    if (config.topP !== undefined) body.top_p = config.topP;

    return body;
  }

  parseResponse(data: any): ChatResponse {
    const choice = data.choices?.[0];
    return {
      content: choice?.message?.content || '',
      tool_calls: choice?.message?.tool_calls || [],
      finish_reason: choice?.finish_reason || 'stop',
      model: data.model || '',
      usage: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }
}
```

- [ ] **Step 2: 运行构建验证**

```
npm run build
```
预期：通过

- [ ] **Step 3: Git commit**

```
git add src/service/providers/openai-compatible.ts
git commit -m "feat: add openai-compatible provider"
```

---

### Task 3: 实现 deepseek-v4 Provider

**Files:**
- Create: `src/service/providers/deepseek-v4.ts`

- [ ] **Step 1: 实现 DeepSeek V4 Provider（含 thinking/reasoning_content）**

```typescript
// src/service/providers/deepseek-v4.ts
import {
  ChatProvider, ChatResponse, AIClientConfig, OpenAIMessage,
  ToolInfo, ThinkingConfig,
} from './base';

export class DeepSeekV4Provider extends ChatProvider {
  name = 'deepseek-v4';
  defaultModel = 'deepseek-v4-pro';
  defaultUrl = 'https://api.deepseek.com/chat/completions';
  supportsThinking = true;
  supportsReasoningEffort = true;

  buildRequestBody(
    config: AIClientConfig,
    messages: OpenAIMessage[],
    tools: ToolInfo[] | null,
    tool_choice: string | null,
    thinkingOverride?: ThinkingConfig,
  ): any {
    const thinking = thinkingOverride || {
      enabled: config.thinkingEnabled,
      effort: config.reasoningEffort,
    };

    const body: any = {
      model: config.model || this.defaultModel,
      messages: messages.map(m => {
        const msg: any = { role: m.role, content: m.content };
        if (m.tool_calls) msg.tool_calls = m.tool_calls;
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        // DeepSeek: 必须回传 reasoning_content（工具调用回合）
        if (m.reasoning_content) msg.reasoning_content = m.reasoning_content;
        return msg;
      }),
      max_tokens: config.maxTokens,
      stream: false,
      ...config.extraBody,
    };

    if (thinking.enabled) {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = thinking.effort;
      // thinking 模式下 temperature/top_p 无效，不发送
    } else {
      body.thinking = { type: 'disabled' };
      if (config.temperature !== undefined) body.temperature = config.temperature;
      if (config.topP !== undefined) body.top_p = config.topP;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = tool_choice || 'auto';
    }

    return body;
  }

  parseResponse(data: any): ChatResponse {
    const choice = data.choices?.[0];
    return {
      content: choice?.message?.content || '',
      reasoning_content: choice?.message?.reasoning_content || '',
      tool_calls: choice?.message?.tool_calls || [],
      finish_reason: choice?.finish_reason || 'stop',
      model: data.model || '',
      usage: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }
}
```

- [ ] **Step 2: 运行构建验证**

```
npm run build
```
预期：通过

- [ ] **Step 3: Git commit**

```
git add src/service/providers/deepseek-v4.ts
git commit -m "feat: add deepseek-v4 provider with thinking mode support"
```

---

### Task 4: 创建 Provider 注册表 + 工厂

**Files:**
- Create: `src/service/providers/index.ts`

- [ ] **Step 1: 注册所有 Provider，提供工厂函数**

```typescript
// src/service/providers/index.ts
import { ChatProvider } from './base';
import { DeepSeekV4Provider } from './deepseek-v4';
import { OpenaiCompatibleProvider } from './openai-compatible';

const registry: Map<string, ChatProvider> = new Map();

function register(provider: ChatProvider) {
  registry.set(provider.name, provider);
}

// 内置注册
register(new DeepSeekV4Provider());
register(new OpenaiCompatibleProvider());

export function getProvider(name: string): ChatProvider {
  const p = registry.get(name);
  if (!p) throw new Error(`未知 Provider: ${name}`);
  return p;
}

export { ChatProvider } from './base';
export type { AIClientConfig, ChatRequest, ChatResponse, OpenAIMessage, ToolInfo, ToolCall, ImageRequest, ThinkingConfig } from './base';
```

- [ ] **Step 2: 运行构建验证**

```
npm run build
```
预期：通过

- [ ] **Step 3: Git commit**

```
git add src/service/providers/index.ts
git commit -m "feat: add provider registry and factory"
```

---

### Task 5: 创建 AIClient

**Files:**
- Create: `src/service/AIClient.ts`

- [ ] **Step 1: 实现统一 HTTP 请求客户端的 chat/embedding/imageToText 方法**

```typescript
// src/service/AIClient.ts
import { getProvider, ChatProvider, AIClientConfig, ChatRequest, ChatResponse, OpenAIMessage, ToolInfo, ImageRequest, ThinkingConfig } from './providers';
import { AIManager } from '../AI/AI';
import { logger } from '../logger';
import { withTimeout } from '../utils/utils';

export class AIClient {
  private config: AIClientConfig;
  private provider: ChatProvider;

  constructor(config: AIClientConfig) {
    this.config = config;
    this.provider = getProvider(config.apiProvider);
  }

  getConfig(): AIClientConfig { return this.config; }
  getProvider(): ChatProvider { return this.provider; }

  /** 非流式对话请求 */
  async chat(
    messages: OpenAIMessage[],
    tools: ToolInfo[] | null,
    tool_choice: string | null,
    thinkingOverride?: ThinkingConfig,
  ): Promise<ChatResponse> {
    const { url, apiKey, timeout } = this.config;
    const body = this.provider.buildRequestBody(
      this.config, messages, tools, tool_choice, thinkingOverride,
    );

    const time = Date.now();

    try {
      const data = await withTimeout(() => this.fetchChat(url, apiKey, body), timeout);

      if (data.choices && data.choices.length > 0) {
        AIManager.updateUsage(data.model, data.usage);

        const response = this.provider.parseResponse(data);
        logger.info(
          `响应内容:`, response.content,
          '\nlatency:', Date.now() - time, 'ms',
          '\nfinish_reason:', response.finish_reason,
        );
        if (response.reasoning_content) {
          logger.info(`思维链内容:`, response.reasoning_content);
        }
        return response;
      }

      throw new Error(`服务器响应中没有choices或choices为空\n响应体:${JSON.stringify(data, null, 2)}`);
    } catch (e) {
      logger.error(`chat请求出错:`, e.message);
      return {
        content: '', tool_calls: [], finish_reason: 'error',
        model: '', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    }
  }

  /** 嵌入向量 */
  async embedding(
    url: string, apiKey: string, input: string,
    bodyTemplate: string[], timeout: number,
  ): Promise<number[]> {
    // 保持与现有 getEmbedding 兼容 —— 暂时保留旧逻辑管道
    // 后续可迁移为 AIClient.embedding() 统一管理
    return [];
  }

  /** 图片识别 */
  async imageToText(
    url: string, apiKey: string,
    messages: any[], bodyTemplate: string[], timeout: number,
  ): Promise<string> {
    // 暂时保留旧逻辑管道，后续统一
    return '';
  }

  /** 底层 HTTP POST */
  private async fetchChat(url: string, apiKey: string, body: any): Promise<any> {
    // 打印上下文（过滤 system）
    if (body.messages) {
      const s = JSON.stringify(body.messages, (_key, value) => {
        if (_key === '' && Array.isArray(value)) {
          return value.filter((item: any) => item.role !== 'system');
        }
        return value;
      });
      logger.info(`请求发送前的上下文:\n`, s);
    }

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...this.provider.getExtraHeaders(this.config),
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`请求失败! 状态码: ${response.status}\n响应体:${text}`);
    }
    if (!text) throw new Error('响应体为空');

    try {
      const data = JSON.parse(text);
      if (data.error) throw new Error(`请求失败! 错误信息: ${data.error.message}`);
      return data;
    } catch (e) {
      throw new Error(`解析响应体时出错:${e.message}\n响应体:${text}`);
    }
  }
}
```

- [ ] **Step 2: 运行构建验证**

```
npm run build
```
预期：通过

- [ ] **Step 3: Git commit**

```
git add src/service/AIClient.ts
git commit -m "feat: add AIClient with chat/embedding/imageToText"
```

---

### Task 6: 创建 ToolCallLoop

**Files:**
- Create: `src/service/ToolCallLoop.ts`

- [ ] **Step 1: 实现工具调用循环抽象（含分阶段思考 + AbortSignal）**

```typescript
// src/service/ToolCallLoop.ts
import { AIClient } from './AIClient';
import { AIClientConfig, ChatResponse, OpenAIMessage, ThinkingConfig } from './providers';
import { AI } from '../AI/AI';
import { ToolManager, ToolCall } from '../tool/tool';
import { ConfigManager } from '../config/configManager';
import { Image } from '../AI/image';
import { logger } from '../logger';

export class ToolCallLoop {
  private client: AIClient;
  private config: AIClientConfig;
  private maxCallCount: number;
  private callCount: number;
  private signal?: AbortSignal;

  constructor(client: AIClient, config: AIClientConfig, signal?: AbortSignal) {
    this.client = client;
    this.config = config;
    this.maxCallCount = ConfigManager.tool.maxCallCount;
    this.callCount = 0;
    this.signal = signal;
  }

  /** 执行工具调用循环，返回最终回复 */
  async run(
    ctx: seal.MsgContext,
    msg: seal.Message,
    ai: AI,
    messages: OpenAIMessage[],
    tools: any[],
  ): Promise<{ content: string; images: Image[]; tool_calls_occurred: boolean }> {
    let tool_calls_occurred = false;

    while (true) {
      if (this.signal?.aborted) {
        logger.info('ToolCallLoop 被取消');
        return { content: '', images: [], tool_calls_occurred };
      }

      // 工具阶段：轻思考
      const toolThinking: ThinkingConfig = {
        enabled: this.config.toolThinkingEnabled,
        effort: this.config.toolReasoningEffort,
      };

      // 每次带上当前 tools + 上限控制 tool_choice
      const tool_choice = this.callCount >= this.maxCallCount ? 'none' : 'auto';
      const toolInfos = tools && tools.length > 0 ? tools : null;

      const response = await this.client.chat(messages, toolInfos, tool_choice, toolThinking);

      if (this.signal?.aborted) {
        logger.info('ToolCallLoop 在回复后被取消');
        return { content: '', images: [], tool_calls_occurred };
      }

      // 无工具调用，返回最终 content
      if (!response.tool_calls || response.tool_calls.length === 0) {
        logger.info('对话结束');
        return { content: response.content, images: [], tool_calls_occurred };
      }

      tool_calls_occurred = true;
      this.callCount += response.tool_calls.length;

      // 上限保护
      if (this.callCount >= this.maxCallCount) {
        logger.warning('连续调用函数次数达到上限');
        if (response.content) {
          return { content: response.content, images: [], tool_calls_occurred };
        }
      }

      // 将 assistant message（含 reasoning_content + tool_calls）追加
      const assistantMsg: OpenAIMessage = {
        role: 'assistant',
        content: response.content || '',
        tool_calls: response.tool_calls,
      };
      if (response.reasoning_content) {
        assistantMsg.reasoning_content = response.reasoning_content;
      }
      messages.push(assistantMsg);

      // 执行工具调用
      const nextToolChoice = await ToolManager.handleToolCalls(
        ctx, msg, ai, response.tool_calls,
      );

      // 将 tool 结果追加到 messages
      const recentMsgs = ai.context.messages.slice(-response.tool_calls.length);
      for (let i = 0; i < recentMsgs.length; i++) {
        const m = recentMsgs[i];
        if (m.role === 'tool') {
          messages.push({
            role: 'tool',
            content: m.msgArray.map(mi => mi.content).join(''),
            tool_call_id: m.tool_call_id || '',
          });
        }
      }

      if (nextToolChoice === 'none' || this.callCount >= this.maxCallCount) break;
    }

    // 上限触发后的最终回复
    const finalResponse = await this.client.chat(messages, null, 'none');
    return { content: finalResponse.content, images: [], tool_calls_occurred };
  }
}
```

- [ ] **Step 2: 运行构建验证**

```
npm run build
```
预期：通过

- [ ] **Step 3: Git commit**

```
git add src/service/ToolCallLoop.ts
git commit -m "feat: add ToolCallLoop with staged thinking and AbortSignal"
```

---

## Phase 2: Config 迁移

### Task 7: 重写 config_request.ts — 结构化配置

**Files:**
- Modify: `src/config/config_request.ts`

- [ ] **Step 1: 替换为结构化配置（model / thinking / extraBody）**

```typescript
// src/config/config_request.ts
import { ConfigManager } from './configManager';

export class RequestConfig {
  static ext: seal.ExtInfo;

  static register() {
    RequestConfig.ext = ConfigManager.getExt('aiplugin4');

    seal.ext.registerStringConfig(RequestConfig.ext, 'API Key', '你的API Key', '');
    seal.ext.registerStringConfig(RequestConfig.ext, '请求url地址', 'https://api.deepseek.com/chat/completions', '默认已填 DeepSeek V4，切换其他 API 提供方时修改此项');

    seal.ext.registerOptionConfig(RequestConfig.ext, 'API 提供方', 'deepseek-v4', [
      'deepseek-v4',
      'openai-compatible',
    ], '选择 API 提供商');

    seal.ext.registerStringConfig(RequestConfig.ext, '模型名称', 'deepseek-v4-pro', 'deepseek-v4-pro / deepseek-v4-flash 或自定义');
    seal.ext.registerIntConfig(RequestConfig.ext, '最大输出 Token', 1024, 'max_tokens');
    seal.ext.registerIntConfig(RequestConfig.ext, '请求超时时限/ms', 180000, '');

    // 思考模式
    seal.ext.registerBoolConfig(RequestConfig.ext, '启用思考模式', true, 'DeepSeek V4 思考开关');
    seal.ext.registerOptionConfig(RequestConfig.ext, '回复推理强度', 'high', [
      'high', 'max',
    ], '最终回复时的推理深度');

    seal.ext.registerBoolConfig(RequestConfig.ext, '工具阶段启用思考', false, '工具调用时是否思考（关闭可加速工具选择）');
    seal.ext.registerOptionConfig(RequestConfig.ext, '工具阶段推理强度', 'minimal', [
      'minimal', 'low',
    ], '工具调用时的推理深度');

    // 非思考模式参数
    seal.ext.registerFloatConfig(RequestConfig.ext, 'Temperature', 1.0, '仅在非思考模式有效');
    seal.ext.registerFloatConfig(RequestConfig.ext, 'Top P', 1.0, '仅在非思考模式有效');

    // 兼容字段
    seal.ext.registerTemplateConfig(RequestConfig.ext, '额外请求体字段', [
      '',
    ], '追加到请求体的 JSON 字符串，格式如 "enable_search":true，一行一个');
  }

  static get() {
    const extraBody: Record<string, any> = {};
    const extraTemplate = seal.ext.getTemplateConfig(RequestConfig.ext, '额外请求体字段');
    for (const s of extraTemplate) {
      if (!s.trim()) continue;
      try {
        const obj = JSON.parse(`{${s}}`);
        Object.assign(extraBody, obj);
      } catch { /* 忽略解析失败的行 */ }
    }

    return {
      apiProvider: seal.ext.getOptionConfig(RequestConfig.ext, 'API 提供方'),
      url: seal.ext.getStringConfig(RequestConfig.ext, '请求url地址'),
      apiKey: seal.ext.getStringConfig(RequestConfig.ext, 'API Key'),
      model: seal.ext.getStringConfig(RequestConfig.ext, '模型名称'),
      maxTokens: seal.ext.getIntConfig(RequestConfig.ext, '最大输出 Token'),
      timeout: seal.ext.getIntConfig(RequestConfig.ext, '请求超时时限/ms'),
      thinkingEnabled: seal.ext.getBoolConfig(RequestConfig.ext, '启用思考模式'),
      reasoningEffort: seal.ext.getOptionConfig(RequestConfig.ext, '回复推理强度'),
      toolThinkingEnabled: seal.ext.getBoolConfig(RequestConfig.ext, '工具阶段启用思考'),
      toolReasoningEffort: seal.ext.getOptionConfig(RequestConfig.ext, '工具阶段推理强度'),
      temperature: seal.ext.getFloatConfig(RequestConfig.ext, 'Temperature'),
      topP: seal.ext.getFloatConfig(RequestConfig.ext, 'Top P'),
      extraBody,
    };
  }
}
```

- [ ] **Step 2: 运行构建验证**

```
npm run build`
```
预期：编译通过（旧的 `bodyTemplate` 引用尚未移除，暂时不报错）

- [ ] **Step 3: Git commit**

```
git add src/config/config_request.ts
git commit -m "refactor: restructure config_request to structured API config with thinking controls"
```

---

### Task 8: 更新 ConfigManager 缓存 key（兼容过渡）

**Files:**
- Modify: `src/config/configManager.ts` — 不需要改动，`request` 缓存 key 不变，`RequestConfig.get()` 的返回 shape 变了但 ConfigManager 通过 `getCache` 泛型自动适配。

- [ ] **Step 1: 运行构建验证**

```
npm run build
```
预期：通过（ConfigManager 本身无变更）

---

## Phase 3: 集成 — 更新 AI.ts / tool.ts / context.ts

### Task 9: 更新 context.ts — Message 增加 reasoning_content 字段

**Files:**
- Modify: `src/AI/context.ts:17-27`

- [ ] **Step 1: Message 接口增加 reasoning_content**

在 `src/AI/context.ts` 第 17 行的 `Message` 接口中加字段：

```typescript
export interface Message {
    role: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    reasoning_content?: string;      // <--- 新增

    uid: string;
    name: string;
    images: Image[];
    msgArray: MessageInfo[];
}
```

- [ ] **Step 2: reviveMessages 补全 reasoning_content 恢复**

```typescript
// 在 reviveMessages() 中增加
message.reasoning_content = message.reasoning_content || '';
```

- [ ] **Step 3: 运行构建验证**

```
npm run build
```
预期：通过

- [ ] **Step 4: Git commit**

```
git add src/AI/context.ts
git commit -m "feat: add reasoning_content field to context Message interface"
```

---

### Task 10: 移除 tool.ts 中的提示词工程

**Files:**
- Modify: `src/tool/tool.ts`

- [ ] **Step 1: 删除 handlePromptToolCall 方法（第 399-490 行）**

删除 `ToolManager.handlePromptToolCall` 整个静态方法。

- [ ] **Step 2: 删除 getToolsPrompt 方法（第 537-554 行）**

删除 `ToolManager.getToolsPrompt` 整个方法。

- [ ] **Step 3: 重构 tool_message.ts — send_msg 工具不再使用 handlePromptToolCall**

在 `src/tool/tool_message.ts` 第 101 行附近，`send_msg` 工具接收 `function` 参数来跨会话调用工具。改为直接构造 ToolCall 对象调用 `handleToolCall`：

```typescript
// tool_message.ts — send_msg.solve 内，替换第 101 行
if (tool_call) {
  // 将 prompt engineering 格式转为 ToolCall 格式
  try {
    const tc = typeof tool_call === 'string' ? JSON.parse(tool_call) : tool_call;
    const fakeToolCall: ToolCall = {
      index: 0,
      id: 'send_msg_' + Date.now(),
      type: 'function',
      function: {
        name: tc.name,
        arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
      },
    };
    await ToolManager.handleToolCall(ctx, msg, ai, fakeToolCall);
  } catch (e) {
    await ai.context.addSystemUserMessage('调用函数返回', `send_msg 工具调用失败: ${e.message}`, []);
  }
}
```

需要确保 `ToolCall` 类型在 `tool_message.ts` 中可用。`tool_message.ts` 第 6 行已 import `{ Tool, ToolManager } from "./tool"`，追加 import `ToolCall`：

```typescript
import { Tool, ToolCall, ToolManager } from "./tool";
```

- [ ] **Step 4: 运行构建验证**

```
npm run build
```
预期：通过（可能提示 `getToolsPrompt` 的引用错误，需同步修复 `utils_message.ts`）

- [ ] **Step 5: Git commit**

```
git add src/tool/tool.ts src/tool/tool_message.ts
git commit -m "refactor: remove prompt engineering support, convert send_msg to native tool calls"
```

---

### Task 11: 更新 utils_message.ts — 移除 parseBody 和提示词工程引用

**Files:**
- Modify: `src/utils/utils_message.ts`

- [ ] **Step 1: 移除 parseBody 函数（第 221-262 行）和 parseEmbeddingBody**

删除 `parseBody` 和 `parseEmbeddingBody` 导出函数。

- [ ] **Step 2: 移除 buildSystemMessage 中的提示词工程引用**

在 `buildSystemMessage` 中删除：

```typescript
// 删除这两行
import { ToolInfo } from "../tool/tool";  // 仅 parseBody 用到

// buildSystemMessage 中删除 toolsPrompt 和 usePromptEngineering 引用
// 第 10 行: 移除 usePromptEngineering 解构
// 第 47 行: 删除 toolsPrompt 声明
// 第 70-71 行: 删除 "开启工具函数提示词" 和 "函数列表" 模板变量
```

`buildSystemMessage` 中新的解构：

```typescript
const { isTool } = ConfigManager.tool;  // 移除 usePromptEngineering
```

- [ ] **Step 3: 更新 handleMessages 中 tool_calls 处理**

`handleMessages` 中 filter tool_calls 和拼接 messages 的逻辑保留不变（那是消息上下文构建，不是 API 层）。

- [ ] **Step 4: 移除 memory.ts 中对 parseBody 的依赖**

`src/AI/memory.ts` 第 7 行 import 了 `parseBody`，第 342 行使用了它。改为直接构建 body object：

```typescript
// memory.ts 第 342 行附近，替换:
const bodyObject = parseBody(memoryBodyTemplate, messages, [], "none");

// 改为:
const bodyObject: any = {};
for (const s of memoryBodyTemplate) {
  if (!s.trim()) continue;
  try {
    const obj = JSON.parse(`{${s}}`);
    Object.assign(bodyObject, obj);
  } catch {}
}
bodyObject.messages = messages;
bodyObject.tool_choice = 'none';
if (!bodyObject.model) throw new Error('body中没有model');
```

- [ ] **Step 5: 运行构建验证**

```
npm run build
```
预期：可能有 parseBody 引用报错，一一修复。

- [ ] **Step 6: Git commit**

```
git add src/utils/utils_message.ts src/AI/memory.ts
git commit -m "refactor: remove parseBody, strip prompt engineering from utils_message"
```

---

### Task 12: 重写 AI.ts — 砍掉流式，接入 AIClient + ToolCallLoop

**Files:**
- Modify: `src/AI/AI.ts`

- [ ] **Step 1: 更新 import**

```typescript
// 移除:
import { endStream, pollStream, sendChatRequest, startStream } from "../service";
import { handleMessages, parseBody } from "../utils/utils_message";

// 新增:
import { AIClient } from "../service/AIClient";
import { ToolCallLoop } from "../service/ToolCallLoop";
import { handleMessages } from "../utils/utils_message";
import { OpenAIMessage } from "../service/providers";
```

- [ ] **Step 2: 删除 AI 类的 stream 属性和相关初始化**

从 `AI` 类中删除：
- `stream` 属性声明（第 64-68 行）
- 构造函数中的 `this.stream = { ... }`（第 82-86 行）

- [ ] **Step 3: 重写 chat() 方法（替换第 122-238 行）**

```typescript
async chat(ctx: seal.MsgContext, msg: seal.Message, reason: string = ''): Promise<void> {
  logger.info('触发回复:', reason || '未知原因');

  if (reason !== '函数回调触发') {
    const { bucketLimit, fillInterval } = ConfigManager.received;
    if (Date.now() - this.bucket.lastTime > fillInterval * 1000) {
      const fillCount = (Date.now() - this.bucket.lastTime) / (fillInterval * 1000);
      this.bucket.count = Math.min(this.bucket.count + fillCount, bucketLimit);
      this.bucket.lastTime = Date.now();
    }
    if (this.bucket.count <= 0) {
      logger.warning('触发次数不足，无法回复');
      return;
    }
  }

  const { toolsNotAllow } = ConfigManager.tool;
  toolsNotAllow.forEach(key => {
    if (this.tool.toolStatus.hasOwnProperty(key)) {
      this.tool.toolStatus[key] = false;
    }
  });

  this.resetState();

  const { isTool } = ConfigManager.tool;
  const requestConfig = ConfigManager.request;

  // 构建 AIClient
  const client = new AIClient({
    apiProvider: requestConfig.apiProvider,
    url: requestConfig.url,
    apiKey: requestConfig.apiKey,
    model: requestConfig.model,
    maxTokens: requestConfig.maxTokens,
    timeout: requestConfig.timeout,
    thinkingEnabled: requestConfig.thinkingEnabled,
    reasoningEffort: requestConfig.reasoningEffort,
    toolThinkingEnabled: requestConfig.toolThinkingEnabled,
    toolReasoningEffort: requestConfig.toolReasoningEffort,
    temperature: requestConfig.temperature,
    topP: requestConfig.topP,
    extraBody: requestConfig.extraBody,
  });

  // 构建消息
  const messages = await handleMessages(ctx, this) as OpenAIMessage[];
  const tools = isTool ? this.tool.getToolsInfo(msg.messageType) : null;

  if (isTool && tools) {
    // 工具调用 → ToolCallLoop（轻思考）
    const loop = new ToolCallLoop(client, requestConfig);
    const result = await loop.run(ctx, msg, this, messages, tools);

    if (result.content) {
      // 最终回复：深度思考
      const finalResponse = await client.chat(messages, null, 'none', {
        enabled: requestConfig.thinkingEnabled,
        effort: requestConfig.reasoningEffort,
      });
      const replyText = finalResponse.content || result.content;
      const { contextArray, replyArray, images } = await handleReply(ctx, msg, this, replyText);
      await this.reply(ctx, msg, contextArray, replyArray, images);
    }
  } else {
    // 无工具 → 直接请求
    const response = await client.chat(messages, null, 'none');
    const { contextArray, replyArray, images } = await handleReply(ctx, msg, this, response.content);
    await this.reply(ctx, msg, contextArray, replyArray, images);
  }

  AIManager.saveAI(this.id);
}
```

- [ ] **Step 4: 删除 chatStream() 方法（第 240-335 行）和 stopCurrentChatStream()（第 337-353 行）**

- [ ] **Step 5: 删除 resetState() 中 toolCallCount 之外的 stream cleanup（保留 `clearTimeout` 等）**

```typescript
resetState() {
  clearTimeout(this.context.timer);
  this.context.timer = null;
  this.context.counter = 0;
  this.bucket.count--;
  this.tool.toolCallCount = 0;
}
```

- [ ] **Step 6: 运行构建验证**

```
npm run build
```
预期：可能有类型不兼容，需逐步修复。

- [ ] **Step 7: Git commit**

```
git add src/AI/AI.ts
git commit -m "refactor: rewrite AI.chat with AIClient+ToolCallLoop, remove streaming"
```

---

### Task 13: 更新 shut.ts — 改为 AbortSignal 取消工具循环

**Files:**
- Modify: `src/cmd/sub_cmd/shut.ts`

- [ ] **Step 1: 移除 stream 依赖**

```typescript
// src/cmd/sub_cmd/shut.ts
import { U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root";

export function registerCmdShut() {
    const cmd = new SubCmd('shut');
    cmd.desc = '打断当前对话';
    cmd.help = '';
    cmd.priv = { priv: U };
    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, ret } = scc;

        // 新方案：取消 ToolCallLoop（通过 AbortController）
        // 当前循环通过 signal.aborted 检测
        // ai 上可挂一个 abortController 供 shut 使用
        // 暂时简化为提示，后续 AI.ts 中挂载 AbortController
        seal.replyToSender(ctx, msg, '当前非流式模式，对话将自然结束');

        return ret;
    }
}
```

注：完整的 AbortSignal 取消机制需要在 `AI` 类上维护 `abortController`。（后续渐进增强，第一版提示即可）

- [ ] **Step 2: 运行构建验证**

```
npm run build
```
预期：通过

- [ ] **Step 3: Git commit**

```
git add src/cmd/sub_cmd/shut.ts
git commit -m "refactor: simplify shut command for non-streaming mode"
```

---

## Phase 4: 清理 — 删除 service.ts + 过时引用

### Task 14: 删除 src/service.ts

**Files:**
- Delete: `src/service.ts`

- [ ] **Step 1: 确认无模块引用 service.ts**

运行 `grep` 确认：
```
grep -r "from.*service" src/
```
预期：memory.ts 和 image.ts 仍有引用，需要先修复。

- [ ] **Step 2: 更新 memory.ts 和 image.ts 的 import**

`src/AI/memory.ts` 第 6 行：`import { fetchData, getEmbedding } from "../service";`
→ `fetchData` 已移至 AIClient 内部，`getEmbedding` 需保留在 service/ 中或重构。

`src/AI/image.ts` 第 2 行：`import { sendITTRequest } from "../service";`
→ `sendITTRequest` 需保留。

策略：第一版将 `getEmbedding` 和 `sendITTRequest` 和 `get_chart_url` 移至 `src/service/` 下作为独立工具函数，AIClient 不直接持有它们（嵌入和识图独立于对话）。

创建 `src/service/legacy.ts` 存放 `fetchData`、`getEmbedding`、`sendITTRequest`、`get_chart_url`：

```typescript
// src/service/legacy.ts
// 暂存的旧函数，后续逐步迁移到 AIClient
import { AIManager } from '../AI/AI';
import { logger } from '../logger';
import { withTimeout } from '../utils/utils';
import { ConfigManager } from '../config/configManager';

export { fetchData };

export async function sendITTRequest(messages: any[]): Promise<string> {

export async function sendITTRequest(messages: any[]): Promise<string> {
  const { timeout } = ConfigManager.request;
  const { url, apiKey, bodyTemplate } = ConfigManager.image;

  const bodyObject: any = {};
  for (const s of bodyTemplate) {
    if (!s.trim()) continue;
    try {
      const obj = JSON.parse(`{${s}}`);
      Object.assign(bodyObject, obj);
    } catch {}
  }
  bodyObject.messages = messages;
  if (!bodyObject.model) return '';

  try {
    const data = await withTimeout(() => fetchData(url, apiKey, bodyObject), timeout);
    if (data.choices?.[0]) {
      AIManager.updateUsage(data.model, data.usage);
      return data.choices[0].message.content || '';
    }
    return '';
  } catch (e) {
    logger.error('ITT请求出错:', e.message);
    return '';
  }
}

const vectorCache: { text: string; vector: number[] } = { text: '', vector: [] };

export async function getEmbedding(text: string, embeddingDimension: number, embeddingUrl: string, embeddingApiKey: string, embeddingBodyTemplate: string[]): Promise<number[]> {
  if (!text || !embeddingUrl) return [];
  const { timeout } = ConfigManager.request;

  if (vectorCache.text === text && vectorCache.vector.length === embeddingDimension) {
    return vectorCache.vector;
  }

  const bodyObject: any = {};
  for (const s of embeddingBodyTemplate) {
    if (!s.trim()) continue;
    try { const obj = JSON.parse(`{${s}}`); Object.assign(bodyObject, obj); } catch {}
  }
  bodyObject.input = text;
  if (!bodyObject.hasOwnProperty('dimensions')) bodyObject.dimensions = embeddingDimension;

  try {
    const data = await withTimeout(() => fetchData(embeddingUrl, embeddingApiKey, bodyObject), timeout);
    if (data.data?.[0]) {
      AIManager.updateUsage(data.model, data.usage);
      const embedding = data.data[0].embedding;
      vectorCache.text = text;
      vectorCache.vector = embedding;
      return embedding;
    }
    return [];
  } catch (e) { logger.error('getEmbedding出错:', e.message); return []; }
}

export async function getChartUrl(chartType: string, usageData: any, usageChartUrl: string): Promise<string> {
  try {
    const response = await fetch(`${usageChartUrl}/chart`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ chart_type: chartType, data: usageData }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`状态码: ${response.status}`);
    const data = JSON.parse(text);
    if (data.error) throw new Error(data.error.message);
    return data.image_url;
  } catch (e) { logger.error('getChartUrl出错:', e.message); return ''; }
}

async function fetchData(url: string, apiKey: string, bodyObject: any): Promise<any> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(bodyObject),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`状态码: ${response.status}\n响应体:${text}`);
  const data = JSON.parse(text);
  if (data.error) throw new Error(data.error.message);
  return data;
}
```

- [ ] **Step 3: 更新 memory.ts 和 image.ts 的 import 源**

`src/AI/memory.ts`:
```typescript
// 替换第 6 行: import { fetchData, getEmbedding } from "../service";
import { getEmbedding } from "../service/legacy";
import { fetchData } from "../service/legacy";
```
`src/AI/image.ts`:
```typescript
// 替换第 2 行: import { sendITTRequest } from "../service";
import { sendITTRequest } from "../service/legacy";
```
同时更新 `memory.ts` 中调用处，`getEmbedding` 函数签名变了，需传入额外参数：
```typescript
// 原: getEmbedding(text)
// 改为:
const { embeddingDimension, embeddingUrl, embeddingApiKey, embeddingBodyTemplate } = ConfigManager.memory;
const vector = await getEmbedding(text, embeddingDimension, embeddingUrl, embeddingApiKey, embeddingBodyTemplate);
```

- [ ] **Step 4: 删除 src/service.ts**

- [ ] **Step 5: 运行构建验证**

```
npm run build
```
预期：通过

- [ ] **Step 6: Git commit**

```
git add src/service/legacy.ts src/AI/memory.ts src/AI/image.ts
git add src/service.ts  # tracked 变为 deleted
git commit -m "refactor: migrate service functions to src/service/legacy.ts, delete old service.ts"
```

---

### Task 15: 最终构建验证 + 清理

**Files:** 散落各处

- [ ] **Step 1: 全量 build**

```
npm run build
```

- [ ] **Step 2: 修复所有残留 TypeScript 错误**

检查点：
- `parseBody` 引用是否全部移除
- `usePromptEngineering` / `toolsPromptTemplate` 引用是否全部移除
- `chatStream` / `stopCurrentChatStream` / `startStream` / `pollStream` / `endStream` 引用是否全部移除
- `handlePromptToolCall` / `getToolsPrompt` 引用是否全部移除
- `AI.stream` 属性引用是否全部移除
- import 路径 `../service` 是否全部改为 `../service/AIClient` 或 `../service/legacy`

- [ ] **Step 3: 确认 prod build 产物正确**

```
npm run build
cat dist/aiplugin4.js | head -20   # 确认 header 嵌入
```

- [ ] **Step 4: Git commit**

```
git add -A
git commit -m "refactor: final cleanup, verify full build passes"
```

---

## 完成验证清单

- [ ] `npm run build` 零错误
- [ ] `dist/aiplugin4.js` 产物存在且包含 header
- [ ] 所有新增 provider 注册正确
- [ ] Config 注册项无遗漏
- [ ] 无 `parseBody` / `handlePromptToolCall` / `usePromptEngineering` / `chatStream` 残留引用
- [ ] 无 `from "../service"` 残留引用（已迁移到 `../service/legacy` 或 `../service/AIClient`）
