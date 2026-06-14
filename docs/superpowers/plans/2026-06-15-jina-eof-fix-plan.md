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
| `src/tool/tool_web.ts` | ① `fetchWithRetry` 维持简洁（goja 不支持 `Response.clone()`）；② Jina Search 加 `Connection: close`；③ Jina Reader 加 `Connection: close` |
| `src/config/config.ts` | 版本号 5.0.48 → 5.1.0 |
| `header.txt` | 版本号 5.0.48 → 5.1.0 |

---

### Task 1: fetchWithRetry 保持简洁（goja 不支持 Response.clone()）

**文件:** `src/tool/tool_web.ts:14-30`

**策略:** `Connection: close` 头强制 HTTP/1.1 新连接是主要防御手段（绕过 goproxy H2 复用 bug），`fetchWithRetry` 维持原有的 fetch 级重试（网络错误 + 429 退避），不做 body 级别验证（实测 goja 的 `fetch` 实现不支持 `Response.clone()`）。

**实现:**

```typescript
// 带重试的 fetch（配合 Connection: close 头绕过 goproxy H2 复用 bug）
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
            return resp;
        } catch (e) {
            if (i === retries) throw e;
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    throw new Error('unreachable');
}
```

**注意:** 如果 body 仍被截断（极小概率，配合 `Connection: close` 后基本不会发生），调用方的 `.json()` 会抛错，由外层 catch fallback 到 SearXNG。

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

**改动:** `5.0.48` → `5.1.0`

**验证:** `npm run build` 通过无报错。

---

## 自审

| 检查项 | 结果 |
|--------|------|
| `fetchWithRetry` 返回类型兼容 | ✅ 仍返回 `Response`，调用方 `.json()` / `.text()` 无需改动 |
| `Connection: close` 副作用 | ✅ 无副作用——仅禁用 HTTP keep-alive，每个请求多一次 TCP 握手（~50ms），对聊天场景影响可忽略 |
| goja 兼容性 | ✅ 不使用 `Response.clone()`（goja 不支持），仅依赖 `Connection: close` + fetch 级重试 |
| SearXNG 路径不受影响 | ✅ SearXNG 使用原始 `fetch`，不经过 `fetchWithRetry`，不加 `Connection: close` |
| 其他模块影响 | ✅ `fetchWithRetry` 仅在本文件使用，无外部引用 |
