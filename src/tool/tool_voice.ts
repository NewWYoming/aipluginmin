import { logger } from "../logger";
import { ConfigManager } from "../config/configManager";
import { Tool } from "./tool";

export function registerTTS() {
    const { ttsEnabled, ttsApiKey } = ConfigManager.backend;
    if (!ttsEnabled || !ttsApiKey) {
        if (ttsEnabled && !ttsApiKey) {
            logger.warning('TTS 已启用但未配置 API Key，text_to_sound 未注册');
        }
        return;
    }

    const tool = new Tool({
        type: 'function',
        function: {
            name: 'text_to_sound',
            description: '将文字合成为语音发送。调用此工具前应先用文字回复用户，再调用此工具将相同文本合成语音。',
            parameters: {
                type: 'object',
                properties: {
                    text: {
                        type: 'string',
                        description: '要合成的文本（应与刚发送的文字回复相同）'
                    }
                },
                required: ['text']
            }
        }
    });

    tool.solve = async (ctx, msg, _, args) => {
        const { text } = args;

        if (!text || !text.trim()) {
            return { content: '文本为空，无法合成语音', images: [] };
        }

        const { ttsApiKey, ttsVoice, ttsExtraBody, ttsModel } = ConfigManager.backend;

        try {
            const model = ttsModel || 'qwen3-tts-flash';
            const isCosyVoice = model.startsWith('cosyvoice');
            const endpoint = isCosyVoice
                ? 'services/audio/tts/SpeechSynthesizer'
                : 'services/aigc/multimodal-generation/generation';
            const url = `https://dashscope.aliyuncs.com/api/v1/${endpoint}`;
            const input: any = { text, voice: ttsVoice };
            if (ttsExtraBody && typeof ttsExtraBody === 'string' && ttsExtraBody.trim()) {
                try {
                    Object.assign(input, JSON.parse(ttsExtraBody));
                } catch {
                    logger.warning('TTS 额外参数 JSON 解析失败，已忽略');
                }
            }
            const body = { model, input };

            logger.info(`TTS 请求: model=${model}, voice=${ttsVoice}, text=${text.slice(0, 30)}`);

            // 内联重试（body 消费在循环内，防止 goproxy H2 EOF）
            let data: any;
            for (let attempt = 0; attempt <= 2; attempt++) {
                try {
                    const resp = await fetch(url, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${ttsApiKey}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(body),
                    });
                    if (!resp.ok) {
                        const errText = await resp.text().catch(() => '');
                        throw new Error(`TTS HTTP ${resp.status}: ${errText.slice(0, 200)}`);
                    }
                    data = await resp.json();
                    break;
                } catch (e: any) {
                    if (attempt === 2) throw e;
                    logger.warning(`TTS 请求失败，重试 ${attempt + 1}/2: ${e?.message || e}`);
                    await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                }
            }

            const audioUrl = data?.output?.audio?.url;
            if (!audioUrl) throw new Error('TTS 响应中无音频 URL');

            seal.replyToSender(ctx, msg, `[CQ:record,file=${audioUrl},cache=0]`);
            logger.info(`TTS 发送成功: ${text.slice(0, 20)}`);
            return { content: `语音发送成功`, images: [] };

        } catch (e: any) {
            logger.error('TTS 失败: ' + (e?.message || e));
            return { content: `语音合成失败: ${e?.message || e}`, images: [] };
        }
    };
}