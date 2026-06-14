# src/ — AI Plugin Core (aiplugin4)

## Responsibility

The `src/` tree is a SealDice JS plugin that gives the dice bot conversational AI capabilities. It intercepts all three SealDice message hooks to process messages, dispatch AI chat requests, and manage per-session (user/group) state.

### Entry points

| File | Role |
|------|------|
| `index.ts` | **Plugin entry.** `main()` registers configs, tools, commands, timers, and memory. Wires three SealDice hooks: `onNotCommandReceived`, `onCommandReceived`, `onMessageSend`, and `onPoke`. |
| `update.ts` | Changelog data (`updateInfo` map), consumed by the `.ai update` command. Not wired in `main()` — imported by commands. |

### Subdirectories (each has its own codemap.md)

| Directory | Role |
|-----------|------|
| `config/` | All plugin configuration keys registered via `seal.ext.register*Config`. Central coordinator is `ConfigManager`. Nine config groups: message, request, reply, received, tool, log, backend, image, memory. |
| `AI/` | Core AI session logic: `AI` class (per-session state + chat dispatch), `Context` (message history, observation collection for impressions), `MemoryManager` (POV-scoped memory, impression layer, composite scoring + LLM rerank), `ImageManager` / `ImagePool` (image handling). |
| `cmd/` | Chat command system: `root.ts` defines the `SubCmd` base class and `registerCmd()` which creates the `.ai` command and its ~20 subcommands (`standby`, `forget`, `prompt`, `timer`, `image`, `memory`, etc.). |
| `tool/` | AI function-calling toolkit. `ToolManager` in `tool.ts` defines the tool schema system and loops. ~42 tools across 21 files (`tool_roll_check`, `tool_web`, `tool_alias`, `tool_memory`, etc.). |
| `service/` | AI provider abstraction: `AIClient` (HTTP transport), `ToolCallLoop` (execution orchestrator), `providers/` (backend-specific adapters like OpenAI, Claude, etc.). |
| `utils/` | Shared utilities: string handling, SealDice context scaffolding (`utils_seal`), message processing (`utils_message`), OB11 API (`utils_ob11`), update checker (`utils_update`). |
| `logger.ts` | Singleton `Logger` instance. Logs with configurable verbosity (off / brief / detailed). Respects `logLevel` from config. |

## Design Patterns

1. **Singleton + Static Manager classes** — `ConfigManager`, `AIManager`, `ToolManager`, `TimerManager`, `PrivilegeManager`, `MemoryManager` all expose static methods. No instantiation; state lives in static fields.

2. **Per-session AI instance** — `AIManager.getAI(sid)` returns or creates an `AI` object keyed by session ID (user ID for private chats, group ID for group chats). Each `AI` owns its own `Context`, `Setting`, `ToolManager`, `MemoryManager`, and `ImagePool`.

3. **Registry pattern** — Config groups, tools, and commands all register themselves via a central registrar:
   - `ConfigManager.registerConfig()` calls each `*Config.register()`.
   - `ToolManager.registerTool()` calls each `register*()`.
   - `registerCmd()` in `cmd/root.ts` calls each `registerCmd*()`.

4. **Revival pattern** — `revive(TimerInfo, item)` deserializes plain JSON objects back into class instances with prototype methods. Used for persistence across restarts (timer queue, settings, memory).

5. **Cache-through pattern** — `ConfigManager.getCache()` wraps config getters with a 3-second TTL cache to avoid repeated `seal.ext.getConfig()` calls.

6. **Hook-based interception** — Three SealDice lifecycle hooks (`onNotCommandReceived`, `onCommandReceived`, `onMessageSend`) are the plugin's sole interaction points with the host runtime.

## Data / Control Flow

### Message Processing Flow

```
SealDice Event
    │
    ├── onNotCommandReceived ──→ filter (ignoreRegex, CQTypes)
    │                               │
    │                               ├── triggerRegex match → ai.chat("非指令")
    │                               ├── triggerConditionMap match → ai.chat("AI设定触发条件")
    │                               └── standby/prob/counter/timer → ai.chat("计数器/概率/计时器")
    │
    ├── onCommandReceived ──→ ToolManager.cmdArgs capture
    │                           │
    │                           └── allcmd && standby → ai.chat("指令消息")
    │
    ├── onMessageSend ──→ tool.listen.resolve (tool async listener)
    │                       │
    │                       └── allmsg && standby → ai.handleReceipt
    │
    └── onPoke ──→ rewrites as CQ:poke → routed to onNotCommandReceived
```

### AI Chat Flow (within `AI.chat()`)

```
AI.chat(ctx, msg, source)
    │
    ├── buildPrompt() → assembles system prompt + context messages
    ├── AIClient.request() → HTTP POST to AI backend (OpenAI/Claude/etc.)
    │       │
    │       └── ToolCallLoop (if function-calling enabled)
    │               ├── parse tool call from response
    │               ├── ToolManager.executeTool() → runs tool logic
    │               ├── append tool result to context
    │               └── re-request AI (cycle up to N times)
    │
    ├── handleReply() → processes response text (macro expansion, CQ codes)
    └── replyToSender() → sends final message via SealDice API
```

### Timer System Flow

```
TimerManager.init()
    │
    ├── getTimerQueue() → deserializes from SealDice storage
    └── executeTask() → setTimeout loop (every 5s)
            │
            └── task() → processes each TimerInfo:
                    ├── target type: compare Date.now() vs target
                    ├── interval type: compare set+interval, decrement count
                    └── activeTime type: check AI's active time segments
                    │
                    └── on trigger: ai.context.addSystemUserMessage() → ai.chat()
```

## Integration Points

| Integration | Mechanism | Files |
|-------------|-----------|-------|
| **SealDice runtime** | `seal.ext.new()`, `ext.onNotCommandReceived`, `ext.onCommandReceived`, `ext.onMessageSend`, `ext.onPoke`, `ext.registerStringConfig()`, etc. | `index.ts`, `config/*`, `cmd/*` |
| **AI backends** | HTTP requests via `AIClient` → provider-specific formatting in `service/providers/` | `service/AIClient.ts`, `service/providers/` |
| **SealDice storage** | `ext.storageSet()` / `ext.storageGet()` for timer queue persistence | `timer.ts` |
| **SealDice API** | `seal.format()`, `seal.replyToSender()`, `ctx.group`, `ctx.player`, `ctx.endPoint` | Throughout `utils/`, `cmd/`, `AI/` |
| **OneBot (OB11)** | `utils_ob11.ts` for HTTP-based QQ API calls (send messages, get group info, etc.) | `utils/utils_ob11.ts` |
| **Build system** | esbuild bundles all of `src/` into a single JS file; `csharp` and `puerts` marked external | `tools/build.js` (root), `tsconfig.json` |
