# src/service/ — Codemap

## 1. Responsibility

The `service/` layer owns **LLM API communication** and the **tool-call iteration loop**. It sits between the AI core (`src/AI/`) and the provider abstraction (`src/service/providers/`), translating internal data into HTTP requests and responses while handling error recovery, logging, and timeouts.

- `AIClient.ts` — typed HTTP client for non-streaming chat completions; wraps provider-specific request building and response parsing.
- `ToolCallLoop.ts` — orchestrates the iterative chat → tool-call → execute → append → loop cycle until a natural reply is produced or limits are hit.
- `legacy.ts` — deprecated request functions (`sendITTRequest`, `getEmbedding`, `get_chart_url`) awaiting migration into the AIClient pattern. `get_chart_url` POSTs usage data to a backend chart service and returns the image URL. (TTS voice synthesis is in `src/tool/tool_voice.ts`, not here.)

## 2. Design Patterns

| Pattern | Where | How |
|---|---|---|
| **Strategy** | `AIClient` ↔ `ChatProvider` | AIClient delegates `buildRequestBody()` and `parseResponse()` to a provider implementation selected at construction via `getProvider(config.apiProvider)`. **DeepSeekV4Provider** adds thinking/reasoning_effort fields and preserves `reasoning_content` round-trip. **OpenaiCompatibleProvider** is a generic fallback — passes `extraBody` through without provider-specific logic. |
| **Adapter** | `AIClient` | Unifies different provider wire formats behind a single `chat()` interface. Adds cross-cutting concerns: contextual logging (first request vs. delta), error wrapping, timeout enforcement, usage tracking. |
| **Loop / Orchestrator** | `ToolCallLoop` | Manages a stateful while-loop: chat → inspect tool_calls → execute via `ToolManager` → append results to messages → repeat. Exposes an `AbortSignal` hook for cancellation. |
| **Legacy shim** | `legacy.ts` | Standalone functions that directly construct bodies and call `fetch()`. No provider abstraction. Targeted for replacement by AIClient. |

## 3. Data / Control Flow

```
Caller (AI module / commands)
       │
       ▼
ToolCallLoop.run(ctx, msg, ai, messages, tools)
       │
       │  loop:
       │    AIClient.chat(messages, tools, tool_choice, thinking)
       │      ├─ provider.buildRequestBody(config, messages, tools, ...)
       │      ├─ fetchChat(url, apiKey, body)          ← HTTP POST
       │      ├─ provider.parseResponse(rawResponse)
       │      └─ returns ChatResponse { content, tool_calls, finish_reason, ... }
       │
       │    if tool_calls empty → return { content }
       │
       │    ai.context.addToolCallsMessage(tool_calls)
       │    ToolManager.handleToolCalls(ctx, msg, ai, tool_calls)
       │    sync tool results from ai.context.messages → api messages[]
       │
       │  after loop:
       │    final one-shot AIClient.chat(messages, none) for fallback reply
       │    return { content, images, tool_calls_occurred }
       ▼
   response to caller
```

**Key details:**
- AIClient keeps a `lastLogLen` counter to log only delta messages on subsequent requests (avoids flooding logs with the full context on every tool-call iteration).
- ToolCallLoop enforces `ConfigManager.tool.maxCallCount` as both a per-turn tool limit and a total loop cap.
- When `this.signal.aborted` is set (via `AbortSignal`), the loop short-circuits and returns empty content.

## 4. Integration Points

| Consumer / Dependency | Interaction |
|---|---|
| **`src/service/providers/`** | `AIClient` imports `getProvider`, `ChatProvider`, and type definitions. Provider modules selected at runtime by `apiProvider` string. `providers/deepseek-v4.ts` supports thinking/reasoning_effort; `providers/openai-compatible.ts` is the generic catch-all. `providers/base.ts` defines the `ChatProvider` abstract class, `ChatResponse`, and supporting types. |
| **`src/AI/AI.ts` — `AIManager`** | `AIClient.chat()` and legacy `sendITTRequest`/`getEmbedding` call `AIManager.updateUsage(model, usage)` to track token consumption. |
| **`src/AI/AI.ts` — `AI` class** | `ToolCallLoop` receives an `AI` instance and calls `ai.context.addToolCallsMessage()` / `ai.context.addToolMessage()` to keep the in-memory context in sync with the API message array. |
| **`src/tool/tool.ts` — `ToolManager`** | `ToolCallLoop.run()` calls `ToolManager.handleToolCalls()` to execute each tool and collect results. |
| **`src/config/configManager.ts` — `ConfigManager`** | Provides `tool.maxCallCount`, `request.timeout`, `image.*`, `memory.*`, `backend.*` config values used by all three files. |
| **`src/logger`** | All three files log requests, responses, errors, and warnings via the shared logger. |
| **`src/utils/utils.ts` — `withTimeout`** | `AIClient.chat()` and legacy functions wrap `fetch()` with `withTimeout` for request-level timeout control. |
