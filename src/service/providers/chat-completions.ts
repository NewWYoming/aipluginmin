import { ChatProvider } from './base';
import type {
  AIClientConfig, ChatResponse, OpenAIMessage, ThinkingConfig, ToolInfo,
} from './base';

export interface ChatCompletionsBody {
  [key: string]: any;
  messages: OpenAIMessage[];
}

/** Defaults and wire extensions, not a separate implementation per vendor. */
export interface ChatCompletionsPreset {
  name: string;
  defaultModel: string;
  defaultUrl: string;
  supportsThinking?: boolean;
  supportsReasoningEffort?: boolean;
  preserveReasoningContent?: boolean;
  prepareRequest?: (
    body: ChatCompletionsBody,
    config: AIClientConfig,
    thinkingOverride?: ThinkingConfig,
  ) => void;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tokenCount(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value : fallback;
}

export class ChatCompletionsProvider extends ChatProvider {
  name: string;
  defaultModel: string;
  defaultUrl: string;
  supportsThinking: boolean;
  supportsReasoningEffort: boolean;

  constructor(private readonly preset: ChatCompletionsPreset) {
    super();
    this.name = preset.name;
    this.defaultModel = preset.defaultModel;
    this.defaultUrl = preset.defaultUrl;
    this.supportsThinking = preset.supportsThinking ?? false;
    this.supportsReasoningEffort = preset.supportsReasoningEffort ?? false;
  }

  buildRequestBody(
    config: AIClientConfig,
    messages: OpenAIMessage[],
    tools: ToolInfo[] | null,
    tool_choice: string | null,
    thinkingOverride?: ThinkingConfig,
  ): ChatCompletionsBody {
    const body: ChatCompletionsBody = {
      model: config.model || this.defaultModel,
      max_tokens: config.maxTokens,
      ...config.extraBody,
      // The loop owns conversation state, not an operator's extraBody template.
      messages: messages.map(m => {
        const message: OpenAIMessage = { role: m.role, content: m.content };
        if (m.tool_calls) message.tool_calls = m.tool_calls;
        if (m.tool_call_id) message.tool_call_id = m.tool_call_id;
        if (this.preset.preserveReasoningContent && m.reasoning_content) {
          message.reasoning_content = m.reasoning_content;
        }
        return message;
      }),
    };
    if (config.temperature !== undefined) body.temperature = config.temperature;
    if (config.topP !== undefined) body.top_p = config.topP;
    this.preset.prepareRequest?.(body, config, thinkingOverride);

    // These invariants apply to every preset, including the final no-tools turn.
    body.stream = false;
    delete body.tools;
    delete body.tool_choice;
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = tool_choice || 'auto';
    }
    return body;
  }

  parseResponse(data: unknown): ChatResponse {
    if (!isRecord(data) || !Array.isArray(data.choices) || data.choices.length === 0) {
      throw new Error('无效的 Chat Completions 响应：choices 缺失或为空');
    }
    const choice = data.choices[0];
    if (!isRecord(choice) || !isRecord(choice.message)) {
      throw new Error('无效的 Chat Completions 响应：缺少 assistant message');
    }
    const message = choice.message;
    if (message.content != null && typeof message.content !== 'string') {
      throw new Error('无效的 Chat Completions 响应：content 必须为文本或 null');
    }
    if (message.tool_calls != null && !Array.isArray(message.tool_calls)) {
      throw new Error('无效的 Chat Completions 响应：tool_calls 必须为数组');
    }

    const usage = isRecord(data.usage) ? data.usage : {};
    const promptTokens = tokenCount(usage.prompt_tokens);
    const completionTokens = tokenCount(usage.completion_tokens);
    const response: ChatResponse = {
      content: message.content ?? '',
      tool_calls: message.tool_calls ?? [],
      finish_reason: typeof choice.finish_reason === 'string' && choice.finish_reason
        ? choice.finish_reason : 'stop',
      model: typeof data.model === 'string' ? data.model : '',
      usage: {
        ...usage, // Retain vendor cache counters and token-detail extensions.
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: tokenCount(usage.total_tokens, promptTokens + completionTokens),
      },
    };
    if (this.preset.preserveReasoningContent) {
      response.reasoning_content = typeof message.reasoning_content === 'string'
        ? message.reasoning_content : '';
    }
    return response;
  }
}
