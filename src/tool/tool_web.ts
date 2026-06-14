import { logger } from "../logger";
import { ConfigManager } from "../config/configManager";
import { Tool } from "./tool";

// 搜索缓存 (query → content)
const searchCache = new Map<string, { content: string; ts: number }>();
const SEARCH_CACHE_TTL = 15 * 60 * 1000; // 15分钟

// 页面缓存 (URL → content)
const pageCache = new Map<string, { content: string; ts: number }>();
const PAGE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24小时

// 带重试的 fetch —— 包含响应体完整性验证
async function fetchWithRetry(url: string, options: RequestInit = {}, retries = 2): Promise<Response> {
    for (let i = 0; i <= retries; i++) {
        try {
            const resp = await fetch(url, options);
            // 429: 速率限制退避重试
            if (resp.status === 429 && i < retries) {
                const delay = Math.pow(2, i + 1) * 1000;
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            // 验证响应体可完整读取（捕获 goproxy H2 EOF）
            // clone 保留原始 Response 供调用方使用
            try {
                await resp.clone().text();
            } catch (bodyErr: any) {
                // 响应体读取失败大概率是网络层问题（EOF/RST），重试即可
                if (i < retries) {
                    logger.warn(`fetch 响应体读取失败，重试 ${i + 1}/${retries}: ${bodyErr?.message || bodyErr}`);
                    await new Promise(r => setTimeout(r, 500 + i * 500));
                    continue;
                }
                throw bodyErr;
            }
            return resp;
        } catch (e) {
            if (i === retries) throw e;
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    throw new Error('unreachable');
}

export function registerWeb() {
    const toolSearch = new Tool({
        type: "function",
        function: {
            name: "web_search",
            description: `使用搜索引擎搜索`,
            parameters: {
                type: "object",
                properties: {
                    q: {
                        type: "string",
                        description: "搜索内容"
                    },
                    page: {
                        type: "integer",
                        description: "页码"
                    },
                    categories: {
                        type: "string",
                        description: "搜索分类",
                        enum: ["general", "images", "videos", "news", "map", "music", "it", "science", "files", "social_media"]
                    },
                    time_range: {
                        type: "string",
                        description: "时间范围",
                        enum: ["day", "week", "month", "year"]
                    }
                },
                required: ["q"]
            }
        }
    });
    toolSearch.solve = async (_, __, ___, args) => {
        const { q, page, categories, time_range = '' } = args;

        // Jina Search: 有 API Key 时优先使用
        const { jinaApiKey } = ConfigManager.backend;
        if (jinaApiKey && q) {
            try {
                // 搜索缓存
                const cacheKey = `jina:${q}|${categories || ''}|${time_range || ''}`;
                const cached = searchCache.get(cacheKey);
                if (cached && (Date.now() - cached.ts) < SEARCH_CACHE_TTL) {
                    return { content: cached.content, images: [] };
                }

                const jinaUrl = 'https://s.jinaai.cn/';
                const headers: Record<string, string> = {
                    'Authorization': `Bearer ${jinaApiKey}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Connection': 'close',
                };

                logger.info(`使用Jina搜索: ${q}`);
                const resp = await fetchWithRetry(jinaUrl, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ q })
                });
                if (!resp.ok) {
                    const errBody = await resp.text().catch(() => '');
                    throw new Error(`Jina HTTP ${resp.status}: ${errBody.slice(0, 200)}`);
                }
                const data = await resp.json();

                const results = data?.data || [];
                if (results.length === 0) return { content: `未搜索到结果`, images: [] };

                const formatted = results.map((r: any, i: number) =>
                    `${i + 1}. ${r.title || ''}\n   链接: ${r.url || ''}\n   ${r.description || r.content?.slice(0, 300) || ''}`
                ).join('\n');

                const result = { content: `搜索结果(${results.length}条):\n${formatted}`, images: [] };
                // 缓存结果
                searchCache.set(cacheKey, { content: result.content, ts: Date.now() });
                return result;
            } catch (e: any) {
                logger.error('Jina搜索失败，回退到SearXNG: ' + (e?.message || e));
                // fall through to SearXNG below
            }
        }

        const { webSearchUrl } = ConfigManager.backend;

        let part = 1;
        let pageno = '';
        if (page) {
            part = parseInt(page) % 2;
            pageno = page ? Math.ceil(parseInt(page) / 2).toString() : '';
        }

        const url = `${webSearchUrl}/search?q=${q}&format=json${pageno ? `&pageno=${pageno}` : ''}${categories ? `&categories=${categories}` : ''}${time_range ? `&time_range=${time_range}` : ''}`;
        try {
            logger.info(`使用搜索引擎搜索:${url}`);

            const response = await fetch(url, {
                method: "GET",
                headers: {
                    "Content-Type": "application/json"
                }
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(`请求失败:${JSON.stringify(data)}}`);
            }

            const number_of_results = data.number_of_results;
            const results_length = data.results.length;
            const results = part == 1 ? data.results.slice(0, Math.ceil(results_length / 2)) : data.results.slice(Math.ceil(results_length / 2));
            if (number_of_results == 0 || results.length == 0) {
                return { content: `没有搜索到结果`, images: [] };
            }

            const s = `搜索结果长度:${number_of_results}\n` + results.map((result: any, index: number) => {
                return `${index + 1}. 标题:${result.title}
- 内容:${result.content}
- 链接:${result.url}
- 相关性:${result.score}`;
            }).join('\n');

            const result = { content: s, images: [] };
            // 缓存搜索结果
            const searxngCacheKey = `searxng:${q}|${categories || ''}|${time_range || ''}|${page || ''}`;
            searchCache.set(searxngCacheKey, { content: result.content, ts: Date.now() });
            return result;
        } catch (error) {
            logger.error("在web_search中请求出错：", error);
            return { content: `使用搜索引擎搜索失败:${error}`, images: [] };
        }
    }

    const tool = new Tool({
        type: "function",
        function: {
            name: "web_read",
            description: `读取网页内容`,
            parameters: {
                type: "object",
                properties: {
                    url: {
                        type: "string",
                        description: "需要读取内容的网页链接"
                    }
                },
                required: ["url"]
            }
        }
    });
    tool.solve = async (ctx, msg, ai, args) => {
        const { url } = args;
        const { jinaApiKey } = ConfigManager.backend;

        // 页面缓存检查
        const cached = pageCache.get(url);
        if (cached && (Date.now() - cached.ts) < PAGE_CACHE_TTL) {
            return { content: cached.content, images: [] };
        }

        try {
            const jinaUrl = `https://r.jinaai.cn/${encodeURIComponent(url)}`;
            const headers: Record<string, string> = {
                'Accept': 'text/markdown',
                'Connection': 'close',
            };
            if (jinaApiKey) {
                headers['Authorization'] = `Bearer ${jinaApiKey}`;
            }

            logger.info(`读取网页内容(Jina): ${url}`);
            const resp = await fetchWithRetry(jinaUrl, { headers });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const content = await resp.text();

            if (!content || content.trim().length === 0) {
                return { content: `未能从网页中提取到有效内容`, images: [] };
            }

            const result = { content: `网页内容:\n${content.slice(0, 8000)}`, images: [] };
            // 缓存
            pageCache.set(url, { content: result.content, ts: Date.now() });
            if (pageCache.size > 200) {
                const oldest = [...pageCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0][0];
                pageCache.delete(oldest);
            }

            return result;
        } catch (e: any) {
            logger.error('网页读取失败: ' + (e?.message || e));
            return { content: `读取网页失败: ${e?.message || e}`, images: [] };
        }
    }
}