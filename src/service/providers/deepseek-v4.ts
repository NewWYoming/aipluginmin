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
        // DeepSeek thinking 模式下必须回传 reasoning_content
        if (thinking.enabled && m.role === 'assistant') {
          msg.reasoning_content = m.reasoning_content || '';
        } else if (m.reasoning_content) {
          msg.reasoning_content = m.reasoning_content;
        }
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
