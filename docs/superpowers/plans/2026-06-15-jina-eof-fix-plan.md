# Jina API "unexpected EOF" 修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Jina Search / Jina Reader API 在海豹骰 goja 运行时的 "unexpected EOF" 错误（根因：goproxy HTTP/2 与 Cloudflare CDN 不兼容）

**Architecture:** 两个改动：① 为 Jina API 请求添加 `Connection: close` 头强制 HTTP/1.1 新连接（绕过 goproxy H2 复用 bug）；② 增强 `fetchWithRetry` 使其在被截断的响应体（`resp.json()` / `resp.text()` 抛出 EOF）时也能重试

**Tech Stack:** TypeScript → JS (esbuild), SeaDice goja runtime

---

## 问题分析

当前 `fetchWithRetry`（`src/tool/tool_web.ts:14-30`）的重试逻辑：

```typescript
async function fetchWithRetry(url, options, retries = 2) {
    for (let i = 0; i <= retries; i++) {
        try {
            const resp = await fetch(url, options);  // ← 这里抛错会重试 ✓
            if (resp.status === 429 && i < retries) { /* 退避重试 */ }
            return resp;  // ← 返回未消费的 Response
        } catch (e) {
            if (i === retries) throw e;
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}
```

**盲区：** 调用方（第 91-95 行、第 204 行）对返回的 `resp` 调用 `.json()` / `.text()`。若 goproxy H2 连接在传输中途断开，`fetch()` 本身可能成功返回（TCP 握手完成），但 `resp.json()` 消费不完整响应体时会抛 `unexpected EOF`。这个错误发生在 `fetchWithRetry` 外部，不会被重试。

## 改动概览

| 文件 | 改动 |
|------|------|
| `src/tool/tool_web.ts` | ① `fetchWithRetry` 内部消费响应体验证完整性；② Jina Search 加 `Connection: close`；③ Jina Reader 加 `Connection: close` |
| `src/config/config.ts` | 版本号 5.0.48 → 5.0.49 |
| `header.txt` | 版本号 5.0.48 → 5.0.49 |

---

### Task 1: 增强 fetchWithRetry —— 响应体消费也纳入重试范围

**文件:** `src/tool/tool_web.ts:14-30`

**策略:** 在 `fetchWithRetry` 成功获得 Response 后，立即 `clone()` 并尝试消费响应体（`.text()`）。如果消费失败，视为网络错误，进入重试。返回已消费文本 + 原始 Response 对象（供调用方使用）。

**实现:**

保持 `fetchWithRetry` 签名不变（返回 `Promise<Response>`），内部完成响应体验证：

```typescript
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
```

**注意:** `resp.clone().text()` 消费了克隆体，原始的 `resp` 的 body 仍然未读，调用方可以正常 `.json()` / `.text()`。由于我们已经验证过一次了，调用方消费时几乎不会失败（但如果失败，由调用方自己的 catch 处理）。

---

### Task 2: Jina Search 加 Connection: close 头

**文件:** `src/tool/tool_web.ts:78-83`

**改动:** 在 Jina Search 的 headers 中添加 `Connection: close`，强制每次请求走新的 TCP 连接，绕过 goproxy H2 连接复用 bug。

```typescript
const headers: Record<string, string> = {
    'Authorization': `Bearer ${jinaApiKey}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Connection': 'close',
};
```

---

### Task 3: Jina Reader 加 Connection: close 头

**文件:** `src/tool/tool_web.ts:194-198`

**改动:** 同样为 `web_read` 的 Jina Reader 请求加 `Connection: close`。`r.jinaai.cn` 也是 Cloudflare CDN，存在相同风险。

```typescript
const headers: Record<string, string> = {
    'Accept': 'text/markdown',
    'Connection': 'close',
};
```

---

### Task 4: 版本号 + 构建验证

**文件:** `src/config/config.ts`, `header.txt`

**改动:** `5.0.48` → `5.0.49`

**验证:** `npm run build` 通过无报错。

---

## 自审

| 检查项 | 结果 |
|--------|------|
| `fetchWithRetry` 返回类型兼容 | ✅ 仍返回 `Response`，调用方 `.json()` / `.text()` 无需改动 |
| `clone().text()` 开销 | ✅ 每请求多读一次响应体（内存），但两次读取同一份底层数据，成本可忽略 |
| `Connection: close` 副作用 | ✅ 无副作用——仅禁用 HTTP keep-alive，每个请求多一次 TCP 握手（~50ms），对聊天场景影响可忽略 |
| SearXNG 路径不受影响 | ✅ SearXNG 使用原始 `fetch`，不经过 `fetchWithRetry`，不加 `Connection: close` |
| 其他模块影响 | ✅ `fetchWithRetry` 仅在本文件使用，无外部引用 |
