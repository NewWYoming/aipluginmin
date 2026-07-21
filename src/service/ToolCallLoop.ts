// src/service/ToolCallLoop.ts
import { AIClient } from './AIClient';
import { AIClientConfig, ChatResponse, OpenAIMessage, ThinkingConfig } from './providers';
import { AI } from '../AI/AI';
import { ToolManager } from '../tool/tool';
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

      // DeepSeek supports thinking + tool calls simultaneously
      const thinking: ThinkingConfig = {
        enabled: this.config.thinkingEnabled,
        effort: this.config.reasoningEffort,
      };

      // 每次带上当前 tools + 上限控制 tool_choice
      const tool_choice = this.callCount >= this.maxCallCount ? 'none' : 'auto';
      const toolInfos = tools && tools.length > 0 ? tools : null;

      const response = await this.client.chat(messages, toolInfos, tool_choice, thinking);

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
      }

      // 将 assistant message（含 reasoning_content + tool_calls）追加到 context 和 API messages
      ai.context.addToolCallsMessage(response.tool_calls, response.reasoning_content);

      const assistantMsg: OpenAIMessage = {
        role: 'assistant',
        content: response.content || '',
        tool_calls: response.tool_calls,
      };
      if (response.reasoning_content) {
        assistantMsg.reasoning_content = response.reasoning_content;
      }
      messages.push(assistantMsg);

      // 收集当前 tool_call_id 集合，用于定位执行后的 tool 消息
      const handledIds = new Set<string>();
      for (const tc of response.tool_calls) handledIds.add(tc.id);

      // 执行工具调用（内部通过 ai.context.addToolMessage 写入 context）
      const nextToolChoice = await ToolManager.handleToolCalls(
        ctx, msg, ai, response.tool_calls,
      );

      // 从 context 中读出刚刚写入的 tool 结果，按顺序追加到 API messages
      const ctxMsgs = ai.context.messages;
      for (let i = ctxMsgs.length - 1; i >= 0; i--) {
        const m = ctxMsgs[i];
        if (m.role === 'tool' && handledIds.has(m.tool_call_id || '')) {
          messages.push({
            role: 'tool',
            content: m.msgArray.map(mi => mi.content).join(''),
            tool_call_id: m.tool_call_id,
          });
          handledIds.delete(m.tool_call_id); // 避免重复加
        }
      }

      if (nextToolChoice === 'none' || this.callCount >= this.maxCallCount) break;
    }

    // 上限触发后的最终回复
    const finalResponse = await this.client.chat(messages, null, 'none');
    return { content: finalResponse.content, images: [], tool_calls_occurred };
  }
}
