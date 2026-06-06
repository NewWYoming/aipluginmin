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
