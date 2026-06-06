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
