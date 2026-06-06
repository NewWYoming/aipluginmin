// src/config/config_request.ts
import { ConfigManager } from './configManager';

export class RequestConfig {
  static ext: seal.ExtInfo;

  static register() {
    RequestConfig.ext = ConfigManager.getExt('aiplugin4');

    // === 旧配置项，key 名保持不变向下兼容 ===
    seal.ext.registerStringConfig(RequestConfig.ext, 'url地址', 'https://api.deepseek.com/chat/completions', '');
    seal.ext.registerStringConfig(RequestConfig.ext, 'API Key', '你的API Key', '');
    seal.ext.registerTemplateConfig(RequestConfig.ext, 'body', [
      `"model":"deepseek-v4-pro"`,
      `"max_tokens":1024`,
      `"stop":null`,
      `"stream":false`,
      `"frequency_penalty":0`,
      `"presence_penalty":0`,
      `"temperature":1`,
      `"top_p":1`,
    ], 'messages,tools,tool_choice不存在时，将会自动替换。具体参数请参考你所使用模型的接口文档');
    seal.ext.registerIntConfig(RequestConfig.ext, '请求超时时限/ms', 180000, '');

    // === V5 新增配置项 ===
    seal.ext.registerOptionConfig(RequestConfig.ext, 'API 提供方', 'deepseek-v4', [
      'deepseek-v4',
      'openai-compatible',
    ], '选择 API 提供商');

    seal.ext.registerBoolConfig(RequestConfig.ext, '启用思考模式', true, 'DeepSeek V4 思考开关（非 thinking 提供商自动忽略）');
    seal.ext.registerOptionConfig(RequestConfig.ext, '回复推理强度', 'high', [
      'low', 'medium', 'high', 'max',
    ], '最终回复时的推理深度');

    seal.ext.registerBoolConfig(RequestConfig.ext, '工具阶段启用思考', false, '工具调用时是否思考（关闭可加速工具选择）');
    seal.ext.registerOptionConfig(RequestConfig.ext, '工具阶段推理强度', 'minimal', [
      'minimal', 'low', 'medium',
    ], '工具调用时的推理深度');
  }

  static get() {
    // 解析旧 body 模板，兼容原有配置
    const bodyTemplate = seal.ext.getTemplateConfig(RequestConfig.ext, 'body');
    let model = 'deepseek-v4-pro';
    let maxTokens = 1024;
    let temperature: number | undefined = 1;
    let topP: number | undefined = 1;
    const extraBody: Record<string, any> = {};

    for (const s of bodyTemplate) {
      if (!s.trim()) continue;
      try {
        const obj = JSON.parse(`{${s}}`);
        const key = Object.keys(obj)[0];
        const val = obj[key];
        if (key === 'model') model = val;
        else if (key === 'max_tokens') maxTokens = val === null ? 1024 : val;
        else if (key === 'temperature') temperature = val === null ? undefined : val;
        else if (key === 'top_p') topP = val === null ? undefined : val;
        else if (
          key !== 'stream' &&
          key !== 'frequency_penalty' &&
          key !== 'presence_penalty' &&
          key !== 'stop' &&
          key !== 'messages' &&
          key !== 'tools' &&
          key !== 'tool_choice'
        ) {
          // 其余未知字段原样保留到 extraBody
          extraBody[key] = val;
        }
      } catch {
        /* 忽略解析失败的行 */
      }
    }

    return {
      apiProvider: seal.ext.getOptionConfig(RequestConfig.ext, 'API 提供方'),
      url: seal.ext.getStringConfig(RequestConfig.ext, 'url地址'),
      apiKey: seal.ext.getStringConfig(RequestConfig.ext, 'API Key'),
      model,
      maxTokens,
      timeout: seal.ext.getIntConfig(RequestConfig.ext, '请求超时时限/ms'),
      thinkingEnabled: seal.ext.getBoolConfig(RequestConfig.ext, '启用思考模式'),
      reasoningEffort: seal.ext.getOptionConfig(RequestConfig.ext, '回复推理强度'),
      toolThinkingEnabled: seal.ext.getBoolConfig(RequestConfig.ext, '工具阶段启用思考'),
      toolReasoningEffort: seal.ext.getOptionConfig(RequestConfig.ext, '工具阶段推理强度'),
      temperature,
      topP,
      extraBody,
    };
  }
}
