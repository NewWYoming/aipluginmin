// src/service/AIClient.ts
import { getProvider, ChatProvider, AIClientConfig, ChatRequest, ChatResponse, OpenAIMessage, ToolInfo, ImageRequest, ThinkingConfig } from './providers';
import { AIManager } from '../AI/AI';
import { logger } from '../logger';
import { withTimeout } from '../utils/utils';

export class AIClient {
  private config: AIClientConfig;
  private provider: ChatProvider;
  private lastLogLen = 0;

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

  /** 底层 HTTP POST */
  private async fetchChat(url: string, apiKey: string, body: any): Promise<any> {
    // 打印上下文：首次全量，后续只打本次新增的消息
    if (body.messages) {
      const msgs: any[] = body.messages;
      const newFrom = this.lastLogLen;
      if (newFrom === 0 || msgs.length <= newFrom) {
        // First request or no new messages: log full context (filter system)
        const s = JSON.stringify(msgs, (_key: string, value: any) => {
          if (_key === '' && Array.isArray(value)) return value.filter((item: any) => item.role !== 'system');
          return value;
        });
        logger.info(`请求发送前的上下文:\n`, s);
      } else {
        // Subsequent requests (tool call iteration): log only new messages
        const delta = msgs.slice(newFrom);
        logger.info(`请求发送前的上下文(新增${delta.length}条):\n`, JSON.stringify(delta));
      }
      this.lastLogLen = msgs.length;
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
