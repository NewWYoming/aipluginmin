# Codemap: `src/service/providers/`

## 1. Responsibility

This directory implements the **Provider abstraction layer** for AI API backends. It defines a uniform interface (`ChatProvider`) that the rest of the plugin uses to talk to any LLM API, without caring whether the backend is DeepSeek, OpenAI, or any OpenAI-compatible service.

Concrete responsibilities:

- Define shared request/response types (`ChatRequest`, `ChatResponse`, `OpenAIMessage`, `ToolCall`, etc.)
- Declare the abstract `ChatProvider` base class with polymorphic methods for building request bodies and parsing responses
- Implement concrete providers for each supported API backend
- Maintain a registry that maps provider name → provider instance

## 2. Design Patterns

| Pattern | Where | Why |
|---|---|---|
| **Strategy** | `ChatProvider` abstract class | Each provider implements its own `buildRequestBody` / `parseResponse` strategy; callers swap strategies by name without conditional logic |
| **Registry (Map)** | `index.ts` → `registry: Map<string, ChatProvider>` | Providers self-register on import; callers fetch by string name via `getProvider(name)` |
| **Template Method** | `buildRequestBody(config, messages, tools, tool_choice, thinkingOverride?)` | The method signature is fixed, but each subclass fills in vendor-specific fields (e.g., DeepSeek's `thinking` / `reasoning_effort`) |
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

- **DeepSeekV4Provider**: Injects `thinking` / `reasoning_effort` into the body; preserves `reasoning_content` on assistant messages (required for multi-turn thinking mode); suppresses `temperature`/`top_p` when thinking is enabled.
- **OpenaiCompatibleProvider**: Standard OpenAI-format body; no thinking support; always sends `temperature`/`top_p` if configured; ignores the `thinkingOverride` parameter.

## 4. Integration Points

### Depends on

| Dependency | Location |
|---|---|
| `Image` type | `src/AI/image.ts` (imported in `base.ts` for `ImageRequest`) |

### What depends on this directory

| Consumer | What it uses |
|---|---|
| `src/service/AIClient.ts` (or equivalent HTTP client) | Calls `getProvider()`, then `buildRequestBody()` / `parseResponse()` to perform actual API calls |
| `ToolCallLoop` (in `src/tool/` or `src/AI/`) | Passes `thinkingOverride` to `buildRequestBody()` to adjust per-call thinking behavior |
| Any module that constructs a `ChatRequest` or reads a `ChatResponse` | Imports the shared types via `index.ts` |

### Exports via `index.ts`

- **Constructor**: `getProvider(name: string): ChatProvider`
- **Re-exports**: `ChatProvider` (class), all shared types (`AIClientConfig`, `ChatRequest`, `ChatResponse`, `OpenAIMessage`, `ToolInfo`, `ToolCall`, `ImageRequest`, `ThinkingConfig`)

### Adding a new provider

1. Create `src/service/providers/my-provider.ts`
2. Extend `ChatProvider`, implement the three abstract members (`name`, `defaultModel`, `defaultUrl`, `supportsThinking`, `supportsReasoningEffort`, `buildRequestBody`, `parseResponse`)
3. Register in `index.ts` via `register(new MyProvider())`

No other file needs to change — the registry lookup is fully dynamic.
