// src/service/providers/index.ts
import { ChatProvider } from './base';
import { ChatCompletionsProvider } from './chat-completions';
import { chatCompletionsPresets } from './presets';

const registry: Map<string, ChatProvider> = new Map();

function register(provider: ChatProvider) {
  registry.set(provider.name, provider);
}

// 内置注册
for (const preset of chatCompletionsPresets) {
  register(new ChatCompletionsProvider(preset));
}

export function getProvider(name: string): ChatProvider {
  const p = registry.get(name);
  if (!p) throw new Error(`未知 Provider: ${name}`);
  return p;
}

export { ChatProvider } from './base';
export type {
  AIClientConfig, ChatRequest, ChatResponse, OpenAIMessage,
  ToolInfo, ToolCall, ImageRequest, ThinkingConfig,
} from './base';
