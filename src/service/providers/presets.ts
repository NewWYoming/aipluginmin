import type { ChatCompletionsPreset } from './chat-completions';

/** Existing config IDs stay stable; compatible endpoints share one protocol. */
export const chatCompletionsPresets: readonly ChatCompletionsPreset[] = [
  {
    name: 'deepseek-v4',
    defaultModel: 'deepseek-v4-pro',
    defaultUrl: 'https://api.deepseek.com/chat/completions',
    supportsThinking: true,
    supportsReasoningEffort: true,
    preserveReasoningContent: true,
    prepareRequest(body, config, thinkingOverride) {
      const thinking = thinkingOverride || {
        enabled: config.thinkingEnabled,
        effort: config.reasoningEffort,
      };
      body.thinking = { type: thinking.enabled ? 'enabled' : 'disabled' };
      if (thinking.enabled) {
        body.reasoning_effort = thinking.effort;
        // Suppress sampling even when it arrived through extraBody.
        delete body.temperature;
        delete body.top_p;
        for (const message of body.messages) {
          if (message.role === 'assistant') {
            message.reasoning_content = message.reasoning_content || '';
          }
        }
      }
    },
  },
  {
    name: 'openai-compatible',
    defaultModel: '',
    defaultUrl: 'https://api.openai.com/v1/chat/completions',
  },
];
