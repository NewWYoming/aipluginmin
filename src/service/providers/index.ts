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
export type {
  AIClientConfig, ChatRequest, ChatResponse, OpenAIMessage,
  ToolInfo, ToolCall, ImageRequest, ThinkingConfig,
} from './base';
