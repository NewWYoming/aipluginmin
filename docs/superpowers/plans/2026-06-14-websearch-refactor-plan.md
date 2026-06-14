# Websearch 重构：Jina + SearXNG + Jina Reader — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 改造 `web_search` 和 `web_read` 工具：搜索优先用 Jina API（支持中文），无 key 时回退 SearXNG；页面读取统一用 Jina Reader（零成本起步）。增加配置、缓存、重试。

**Architecture:** `web_search` 双后端路由：有 Jina key → `GET https://s.jina.ai/{q}`；无 key → 现有 SearXNG 逻辑不变。`web_read` 全部走 `GET https://r.jina.ai/{url}`，有 key 提速。新增内存缓存（Map + TTL），search 15min / page 24h。新增 `Jina API Key` 字符配置。

**Tech Stack:** TypeScript, SeaDice JS plugin, Jina AI APIs

---

### Task 0: 版本号更新

每次提交 src/ 下的代码后，必须：
1. `src/config/config.ts` `VERSION` patch +1
2. `header.txt` `@version` patch +1
3. 使用 `edit` 工具，禁用 PowerShell `Set-Content`

---

## Task 1: 新增 Jina API Key 配置 + 更新 webReadUrl 默认值

**Files:**
- Modify: `src/config/config_backend.ts`

### Step 1: 添加 Jina API Key 注册

在 `register()` 方法的现有配置之后追加：

```typescript
        seal.ext.registerStringConfig(BackendConfig.ext, "Jina API Key", "", "Jina AI 搜索和网页读取的 API Key。留空时搜索使用 SearXNG，网页读取使用 Jina Reader 20 RPM 免费额度");
```

### Step 2: 在 get() 返回值中添加

```typescript
            jinaApiKey: seal.ext.getStringConfig(BackendConfig.ext, "Jina API Key"),
```

### Step 3: 修改 webReadUrl 默认值（在 register 中）

将现有行：
```typescript
        seal.ext.registerStringConfig(BackendConfig.ext, "网页读取", "https://webread.fishwhite.top", "可自行搭建");
```
改为：
```typescript
        seal.ext.registerStringConfig(BackendConfig.ext, "网页读取", "https://r.jina.ai", "Jina Reader (免费20RPM)，可自行搭建");
```

> 注意：`registerStringConfig` 的默认值只对新安装生效。已有用户不会覆盖。

### Step 4: 构建验证

```bash
npm run build
```

### Step 5: 版本号 + 提交

```bash
git add src/config/config_backend.ts src/config/config.ts header.txt
git commit -m "feat: add Jina API Key config, switch default webReadUrl to Jina Reader"
```

---

## Task 2: 重写 web_search — Jina 优先，SearXNG 兜底

**Files:**
- Modify: `src/tool/tool_web.ts:6-84` (工具 schema 和 solve)
- Modify: `src/service/legacy.ts`（如有 fetchData 依赖则添加 fetch）

### Step 1: 读取当前 web_search 完整代码

Read `src/tool/tool_web.ts` lines 1-84.

### Step 2: 重写 web_search solve 为前端路由

在现有 `web_search` 的 `solve` 方法中，在获取 `q` 参数后，**从 `const { q, page, categories, time_range } = args;` 之后**，插入 Jina 路由判断：

```typescript
    toolWebSearch.solve = async (ctx, msg, ai, args) => {
        const { q, page, categories, time_range } = args;
        const { jinaApiKey } = ConfigManager.backend;

        // Jina 搜索：有 API Key 时优先使用
        if (jinaApiKey && q) {
            try {
                const jinaUrl = `https://s.jina.ai/${encodeURIComponent(q)}`;
                const headers: Record<string, string> = {
                    'Authorization': `Bearer ${jinaApiKey}`,
                    'Accept': 'application/json'
                };
                // 可选参数
                if (page && page > 1) headers['X-Page'] = String(page);
                
                logger.info(`使用Jina搜索: ${jinaUrl}`);
                const resp = await fetchWithRetry(jinaUrl, { headers });
                if (!resp.ok) throw new Error(`Jina HTTP ${resp.status}`);
                const data = await resp.json();
                
                // Jina 返回格式: { data: [{ title, url, content, description }] }
                const results = data?.data || [];
                if (results.length === 0) return { content: `未搜索到结果`, images: [] };
                
                const formatted = results.map((r: any, i: number) =>
                    `${i + 1}. ${r.title}\n   链接: ${r.url}\n   ${r.description || r.content?.slice(0, 300) || ''}`
                ).join('\n');
                
                return { content: `搜索结果(${results.length}条):\n${formatted}`, images: [] };
            } catch (e) {
                logger.error('Jina搜索失败，回退到SearXNG: ' + (e?.message || e));
                // 继续往下走 SearXNG 逻辑
            }
        }

        // 回退：SearXNG（现有逻辑，保持不变）
        // ... 原有的 SearXNG 搜索代码 ...
```

**注意**：原有的 SearXNG 搜索逻辑（lines ~25-83）完全保留，放在 Jina 块之后。Jina 失败时自然 fall through 到 SearXNG。

### Step 3: 构建验证

```bash
npm run build
```

### Step 4: 版本号 + 提交

```bash
git add src/tool/tool_web.ts src/config/config.ts header.txt
git commit -m "feat: web_search dual-backend — Jina (with key) / SearXNG fallback"
```

---

## Task 3: 重写 web_read — 统一 Jina Reader

**Files:**
- Modify: `src/tool/tool_web.ts:86-140` (web_read solve)

### Step 1: 读取当前 web_read 完整代码

Read `src/tool/tool_web.ts` lines 86-140.

### Step 2: 重写 web_read solve

将整个 `toolWebRead.solve` 替换为：

```typescript
    toolWebRead.solve = async (ctx, msg, ai, args) => {
        const { url } = args;
        const { jinaApiKey } = ConfigManager.backend;

        // 缓存检查
        const cached = pageCache.get(url);
        if (cached && (Date.now() - cached.ts) < PAGE_CACHE_TTL) {
            return { content: cached.content, images: [] };
        }

        try {
            const jinaUrl = `https://r.jina.ai/${encodeURIComponent(url)}`;
            const headers: Record<string, string> = {
                'Accept': 'text/markdown'
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

            // 缓存
            pageCache.set(url, { content, ts: Date.now() });
            // 限制缓存大小
            if (pageCache.size > 200) {
                const oldest = [...pageCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0][0];
                pageCache.delete(oldest);
            }

            return { content: `网页内容:\n${content.slice(0, 8000)}`, images: [] };
        } catch (e) {
            logger.error('网页读取失败: ' + (e?.message || e));
            return { content: `读取网页失败: ${e?.message || e}`, images: [] };
        }
    }
```

### Step 3: 添加缓存和重试工具函数

在 `src/tool/tool_web.ts` 文件顶部（import 之后），添加：

```typescript
// 页面缓存 (URL → content + timestamp)
const pageCache = new Map<string, { content: string; ts: number }>();
const PAGE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24小时

// 带重试的 fetch
async function fetchWithRetry(url: string, options: RequestInit = {}, retries = 2): Promise<Response> {
    for (let i = 0; i <= retries; i++) {
        try {
            const resp = await fetch(url, options);
            if (resp.status === 429 && i < retries) {
                const delay = Math.pow(2, i + 1) * 1000;
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            return resp;
        } catch (e) {
            if (i === retries) throw e;
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    throw new Error('unreachable');
}
```

### Step 4: 构建验证

```bash
npm run build
```

### Step 5: 版本号 + 提交

```bash
git add src/tool/tool_web.ts src/config/config.ts header.txt
git commit -m "feat: rewrite web_read with Jina Reader + page caching + retry"
```

---

## Task 4: 添加搜索缓存

**Files:**
- Modify: `src/tool/tool_web.ts`

### Step 1: 在 web_search 的 Jina 和 SearXNG 两个分支前都加缓存检查

在 `web_search` solve 方法的参数解构后，搜索结果请求前，添加：

```typescript
        // 搜索缓存检查
        const cacheKey = `${q}|${categories || ''}|${time_range || ''}`;
        const cachedSearch = searchCache.get(cacheKey);
        if (cachedSearch && (Date.now() - cachedSearch.ts) < SEARCH_CACHE_TTL) {
            return { content: cachedSearch.content, images: [] };
        }
```

在两个搜索分支（Jina 和 SearXNG）的成功返回前，添加缓存写入：

```typescript
        // 缓存搜索结果
        const searchResult = { content: `搜索结果(...`, images: [] };
        searchCache.set(cacheKey, { content: searchResult.content, ts: Date.now() });
```

### Step 2: 在文件顶部添加 search 缓存结构

```typescript
const searchCache = new Map<string, { content: string; ts: number }>();
const SEARCH_CACHE_TTL = 15 * 60 * 1000; // 15分钟
```

### Step 3: 构建验证 + 提交

```bash
npm run build
git add src/tool/tool_web.ts src/config/config.ts header.txt
git commit -m "feat: add search result caching (15min TTL)"
```

---

## 最终验证

- [ ] **完整构建**

```bash
npm run build
```

- [ ] **提交**

```bash
git add -A
git commit -m "chore: final verification of websearch refactor"
```
