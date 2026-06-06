// src/service/legacy.ts
// 旧函数暂存，后续逐步迁移到 AIClient
import { AIManager } from '../AI/AI';
import { ConfigManager } from '../config/configManager';
import { logger } from '../logger';
import { withTimeout } from '../utils/utils';

const vectorCache: { text: string, vector: number[] } = { text: '', vector: [] };

export async function fetchData(url: string, apiKey: string, bodyObject: any): Promise<any> {
    // 打印请求发送前的上下文
    if (bodyObject.hasOwnProperty('messages')) {
        const s = JSON.stringify(bodyObject.messages, (key, value) => {
            if (key === "" && Array.isArray(value)) {
                return value.filter(item => item.role !== "system");
            }
            return value;
        });
        logger.info(`请求发送前的上下文:\n`, s);
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Accept": "application/json"
        },
        body: JSON.stringify(bodyObject)
    });

    // logger.info("响应体", JSON.stringify(response, null, 2));

    const text = await response.text();
    if (!response.ok) {
        throw new Error(`请求失败! 状态码: ${response.status}\n响应体:${text}`);
    }
    if (!text) {
        throw new Error("响应体为空");
    }

    try {
        const data = JSON.parse(text);
        if (data.error) {
            throw new Error(`请求失败! 错误信息: ${data.error.message}`);
        }
        return data;
    } catch (e) {
        throw new Error(`解析响应体时出错:${e.message}\n响应体:${text}`);
    }
}

export async function sendITTRequest(messages: {
    role: string,
    content: {
        type: string,
        image_url?: { url: string }
        text?: string
    }[]
}[]): Promise<string> {
    const { timeout } = ConfigManager.request;
    const { url, apiKey, bodyTemplate } = ConfigManager.image;

    try {
        const bodyObject: any = {};
        for (const s of bodyTemplate) {
          if (!s.trim()) continue;
          try {
            const obj = JSON.parse(`{${s}}`);
            Object.assign(bodyObject, obj);
          } catch (err) {
            throw new Error(`解析body的【${s}】时出现错误:${err}`);
          }
        }
        if (!bodyObject.hasOwnProperty('messages')) {
          bodyObject.messages = messages;
        }
        if (!bodyObject.hasOwnProperty('model')) {
          throw new Error('body中没有model');
        }
        const time = Date.now();

        const data = await withTimeout(() => fetchData(url, apiKey, bodyObject), timeout);

        if (data.choices && data.choices.length > 0) {
            AIManager.updateUsage(data.model, data.usage);

            const message = data.choices[0].message;
            const content = message.content || '';

            logger.info(`响应内容:`, content, '\nlatency', Date.now() - time, 'ms');

            return content;
        } else {
            throw new Error(`服务器响应中没有choices或choices为空\n响应体:${JSON.stringify(data, null, 2)}`);
        }
    } catch (e) {
        logger.error("在sendITTRequest中请求出错:", e.message);
        return '';
    }
}

export async function getEmbedding(text: string): Promise<number[]> {
    if (!text) {
        logger.warning(`getEmbedding: 文本为空`);
        return [];
    }

    const { timeout } = ConfigManager.request;
    const { embeddingDimension, embeddingUrl, embeddingApiKey, embeddingBodyTemplate } = ConfigManager.memory;

    if (vectorCache.text === text && vectorCache.vector.length === embeddingDimension) {
        const v = vectorCache.vector;
        return v;
    }

    try {
        const bodyObject: any = {};
        for (const s of embeddingBodyTemplate) {
          if (!s.trim()) continue;
          try {
            const obj = JSON.parse(`{${s}}`);
            Object.assign(bodyObject, obj);
          } catch (err) {
            throw new Error(`解析body的【${s}】时出现错误:${err}`);
          }
        }
        if (!bodyObject.hasOwnProperty('input')) {
          bodyObject.input = text;
        }
        if (!bodyObject.hasOwnProperty('dimensions')) {
          bodyObject.dimensions = embeddingDimension;
        }
        const time = Date.now();

        const data = await withTimeout(() => fetchData(embeddingUrl, embeddingApiKey, bodyObject), timeout);

        if (data.data && data.data.length > 0) {
            AIManager.updateUsage(data.model, data.usage);

            const embedding = data.data[0].embedding;

            logger.info(`文本:`, text, `\n响应embedding长度:`, embedding.length, '\nlatency:', Date.now() - time, 'ms');
            vectorCache.text = text;
            vectorCache.vector = embedding;

            return embedding;
        } else {
            throw new Error(`服务器响应中没有data或data为空\n响应体:${JSON.stringify(data, null, 2)}`);
        }
    } catch (e) {
        logger.error("在getEmbedding中出错:", e.message);
        return [];
    }
}

export async function get_chart_url(chart_type: string, usage_data: {
    [key: string]: {
        prompt_tokens: number;
        completion_tokens: number;
    }
}) {
    const { usageChartUrl } = ConfigManager.backend;
    try {
        const response = await fetch(`${usageChartUrl}/chart`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                chart_type: chart_type,
                data: usage_data
            })
        })

        const text = await response.text();
        if (!response.ok) {
            throw new Error(`请求失败! 状态码: ${response.status}\n响应体: ${text}`);
        }
        if (!text) {
            throw new Error("响应体为空");
        }

        try {
            const data = JSON.parse(text);
            if (data.error) {
                throw new Error(`请求失败! 错误信息: ${data.error.message}`);
            }
            return data.image_url;
        } catch (e) {
            throw new Error(`解析响应体时出错:${e}\n响应体:${text}`);
        }
    } catch (e) {
        logger.error("在get_chart_url中请求出错:", e.message);
        return '';
    }
}
