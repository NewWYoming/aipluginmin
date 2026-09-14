# Codemap: `src/service/providers/`

## 1. Responsibility

This directory implements the **Provider abstraction layer** for AI API backends. It defines a uniform interface (`ChatProvider`) that the rest of the plugin uses to talk to any LLM API, without caring whether the backend is DeepSeek, OpenAI, or any OpenAI-compatible service.

Concrete responsibilities:

- Define shared request/response types (`ChatRequest`, `ChatResponse`, `OpenAIMessage`, `ToolCall`, etc.)
- Declare the abstract `ChatProvider` base class with polymorphic methods for building request bodies and parsing responses
- Implement each wire protocol once; describe compatible vendors through presets
- Maintain a registry that maps provider name → provider instance

## 2. Design Patterns

| Pattern | Where | Why |
|---|---|---|
| **Strategy** | `ChatProvider` abstract class | Each protocol implements `buildRequestBody` / `parseResponse`; compatible vendor IDs share a protocol instance class |
| **Registry (Map)** | `index.ts` → `registry: Map<string, ChatProvider>` | Providers self-register on import; callers fetch by string name via `getProvider(name)` |
| **Template Method** | `buildRequestBody(config, messages, tools, tool_choice, thinkingOverride?)` | `ChatCompletionsProvider` owns common serialization/validation; a preset hook supplies wire extensions such as DeepSeek thinking |
| **Static Factory** | `getProvider(name)` | Simple factory — looks up a pre-registered singleton by name, throws on unknown names |
| **Data Transfer Object (DTO)** | `ChatRequest`, `ChatResponse`, `AIClientConfig`, etc. | Plain interfaces that cross the provider boundary; no business logic attached |

## 3. Data / Control Flow

```
AIClient (caller)
    │
    ▼
getProvider("deepseek-v4" | "openai-compatible")
    │
    ▼
provider.buildRequestBody(config, messages, tools, tool_choice, thinkingOverride?)
    │  └─ returns raw JSON body (vendor-specific fields)
    ▼
[HTTP POST to vendor URL]
    │
    ▼
provider.parseResponse(raw API response)
    │  └─ returns normalized ChatResponse
    ▼
Caller uses ChatResponse.content, .tool_calls, .reasoning_content, .usage
```

Key details per provider:

- **`deepseek-v4` preset**: Injects `thinking` / `reasoning_effort` into the body; preserves `reasoning_content` on assistant messages (required for multi-turn thinking mode); suppresses `temperature`/`top_p` when thinking is enabled.
- **`openai-compatible` preset**: Standard OpenAI-format body; no thinking support; always sends `temperature`/`top_p` if configured; ignores the `thinkingOverride` parameter.

## 4. Integration Points

### Depends on

Only local protocol types and presets; no SealDice or AI-module runtime imports.

### What depends on this directory

| Consumer | What it uses |
|---|---|
| `src/service/AIClient.ts` (or equivalent HTTP client) | Calls `getProvider()`, then `buildRequestBody()` / `parseResponse()` to perform actual API calls |
| `ToolCallLoop` (`src/service/ToolCallLoop.ts`) | Passes `thinkingOverride` to `buildRequestBody()` to adjust per-call thinking behavior |
| Any module that constructs a `ChatRequest` or reads a `ChatResponse` | Imports the shared types via `index.ts` |

### Exports via `index.ts`

- **Constructor**: `getProvider(name: string): ChatProvider`
- **Re-exports**: `ChatProvider` (class), all shared types (`AIClientConfig`, `ChatRequest`, `ChatResponse`, `OpenAIMessage`, `ToolInfo`, `ToolCall`, `ImageRequest`, `ThinkingConfig`)

### Files and invariants

- `base.ts`: protocol contract and normalized DTOs. Invalid wire responses throw.
- `chat-completions.ts`: shared message/tool serialization, envelope validation,
  and usage normalization, preserving vendor token details.
- `presets.ts`: stable vendor IDs, defaults, and the DeepSeek thinking extension.
- `index.ts`: instantiate presets using the shared protocol and keep the registry.

`extraBody` can supply vendor parameters but cannot override `messages`, `stream`,
`tools`, or `tool_choice`. Requests remain non-streaming. No configured tools means
omit both tool fields; configured tools with choice `none` retain that explicit
choice. DeepSeek thinking suppresses sampling fields even from `extraBody`.

### Adding an endpoint or protocol

For an ordinary Chat Completions-compatible endpoint, select `openai-compatible`
and configure its URL/model/key/extra body; **no new source file is needed**.
A built-in named preset belongs in `presets.ts` (and the configuration selector,
if exposing another UI option), not in a duplicated request/response class.

A different wire protocol needs a separate `ChatProvider` implementation with its
own authentication, serialization, validation and tool-conversation tests. This
change does **not** implement Responses or Anthropic Messages; it only removes the
client's hard-coded `choices` check and consolidates the existing protocol.

### Verification

`npm test` runs behavior tests under `tests/service/` using Node 18+ and a
development-only TypeScript compiler. The client tests stub host logging, usage
storage, timeout wrapping and HTTP; they do not test SealDice or live APIs.
