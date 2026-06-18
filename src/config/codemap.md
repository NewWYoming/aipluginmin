# Codemap — `src/config/`

## 1. Responsibility

Configuration registration and management for the `aiplugin4` SealDice plugin. This module:

- **Registers** all user-facing configuration keys with the SealDice host via `seal.ext.register*Config()` (string, int, bool, float, option, template).
- **Reads** runtime configuration values on demand (with a short-lived cache).
- **Transforms** raw SealDice config values into typed, usable runtime objects: `RegExp`, `HandlebarsTemplateDelegate`, path maps, and structured request-body objects.
- **Exposes** all configuration as static getters on `ConfigManager`, consumed by every other module (`src/AI/`, `src/cmd/`, `src/tool/`, `src/utils/`).

---

## 2. Design Patterns

### Static Config Class per Domain

Each feature area has a dedicated file with a class that follows a uniform interface:

| File | Class | SealDice Extension Name | Purpose |
|---|---|---|---|---|
| `config_log.ts` | `LogConfig` | `aiplugin4` | Log verbosity |
| `config_request.ts` | `RequestConfig` | `aiplugin4` | API provider, URL, key, model, thinking, body, memory model |
| `config_message.ts` | `MessageConfig` | `aiplugin4_1:对话` | Role switching (roleSettingNames/roleSettingTemplate), system prompt template (incl. impression layer), history, timezone offset |
| `config_tool.ts` | `ToolConfig` | `aiplugin4_2:函数调用` | Function-calling (toolsDefaultClosed, maxCallCount), voice, decks |
| `config_received.ts` | `ReceivedConfig` | `aiplugin4_3:消息接收与触发` | Trigger conditions, ignore patterns, rate limits |
| `config_reply.ts` | `ReplyConfig` | `aiplugin4_4:回复` | Reply filtering, anti-repeat, regex processing |
| `config_image.ts` | `ImageConfig` | `aiplugin4_5:图片` | Image recognition, storage, sending |
| `config_backend.ts` | `BackendConfig` | `aiplugin4_6:后端` | External service URLs (stream, search, render, Jina API Key), TTS provider routing (DashScope/CosyVoice) |
| `config_memory.ts` | `MemoryConfig` | `aiplugin4_7:记忆` | Long-term memory (memoryLimit, memoryShowNumber, memoryShowTemplate), knowledge base, impressions (impressionMaxLength, cleanupInactiveDays), task reminder polish (任务提醒润色提示); vector/embedding config removed |
| `sample.ts` | `SampleConfig` | `aiplugin4_0:示例` | Reference example (disabled in production) |

Each class has:
- `static ext: seal.ExtInfo` — reference to the SealDice extension for this config group.
- `static register()` — registers all config keys with SealDice.
- `static get()` — reads and returns a typed config object.

### Orchestrator (`ConfigManager`)

`ConfigManager` in `configManager.ts` is the central hub:

- **Registration orchestration** — `registerConfig()` calls every domain's `register()` method in sequence.
- **Static typed accessors** — e.g. `ConfigManager.request`, `ConfigManager.memory`. Each getter calls the domain's `get()` and caches for 3 seconds.
- **Utility methods** — shared transformations used by domain `get()` implementations:
  - `getRegexConfig()` — joins template lines into a combined `RegExp`.
  - `getRegexesConfig()` — returns array of `RegExp`, one per template line.
  - `getHandlebarsTemplateConfig()` — compiles first template line into a Handlebars delegate.
  - `getHandlebarsTemplatesConfig()` — compiles all template lines into delegates.
  - `getPathMapConfig()` — parses file paths into `{ id: path }` maps.

### Extension Namespacing per Domain

Each config group registers under a different SealDice extension name (e.g. `aiplugin4_1:对话`, `aiplugin4_2:函数调用`), isolating config keys between domains in the SealDice host.

### Cache Layer

`ConfigManager.cache` is an in-memory object with 3-second TTL. Every static getter (`ConfigManager.log`, `.request`, etc.) checks cache before calling `get()`.

### Backward-Compatible Config Parsing

`RequestConfig.get()` parses the legacy `body` template lines (which contained raw JSON fragments like `"model":"deepseek-v4-pro"`) and extracts `model`, `maxTokens`, `temperature`, `topP`, and unknown extras into `extraBody`. New V5 config fields (`apiProvider`, `thinkingEnabled`, `memoryModel`) coexist alongside.

---

## 3. Data / Control Flow

```
Plugin startup (src/index.ts → main())
  └─ ConfigManager.registerConfig()
       ├─ LogConfig.register()          → reuses "aiplugin4" ext, registers 1 option
       ├─ RequestConfig.register()      → reuses "aiplugin4" ext, registers 10 keys (added memoryModel, tool thinking/reasoning config)
       ├─ MessageConfig.register()      → creates "aiplugin4_1:对话" ext, registers 12 keys (roleSettingNames/roleSettingTemplate for role switching, utcOffset)
       ├─ ToolConfig.register()          → creates "aiplugin4_2:函数调用" ext, registers 7 keys (maxCallCount, toolsDefaultClosed)
       ├─ ReceivedConfig.register()      → creates "aiplugin4_3:消息接收与触发" ext, registers ~8 keys
       ├─ ReplyConfig.register()         → creates "aiplugin4_4:回复" ext, registers ~6 keys
       ├─ ImageConfig.register()         → creates "aiplugin4_5:图片" ext, registers ~9 keys
       ├─ BackendConfig.register()       → creates "aiplugin4_6:后端" ext, registers 12 keys (added Jina API Key + TTS config: ttsModel, ttsProvider, ttsVoice, ttsApiKey, ttsEnabled, ttsExtraBody)
       ├─ MemoryConfig.register()        → creates "aiplugin4_7:记忆" ext, registers 13 keys (memoryLimit, memoryShowNumber, memoryShowTemplate, memorySingleShowTemplate, knowledgeMemoryShowNumber, impressionMaxLength, cleanupInactiveDays, 任务提醒润色提示; 5 vector keys removed)
       └─ SampleConfig.register()        → creates "aiplugin4_0:示例" ext, registers 1 key

Runtime access (any module):
  └─ ConfigManager.request (example)
       └─ cache hit? → return cached
       └─ cache miss → RequestConfig.get()
            ├─ seal.ext.getOptionConfig(...)
            ├─ seal.ext.getStringConfig(...)
            ├─ seal.ext.getTemplateConfig(...) → parsed into RegExp / Handlebars / object
            └─ seal.ext.getIntConfig(...)
            └─ result cached for 3 seconds
```

### `config.ts` — Constants

This file is not a config class. It exports plain constants used throughout the plugin:
- `VERSION`, `AUTHOR`, `NAME` — plugin metadata.
- `CQTYPESALLOW` — allowed CQ message types.
- `PRIVILEGELEVELMAP` — role-to-permission-level mapping.
- `HELPMAP` — help text definitions for commands.
- `aliasMap` — command alias lookup (e.g. `"img" → "image"`).
- `faceMap` — QQ face ID to Chinese name mapping.

---

## 4. Integration Points

| Integration | Details |
|---|---|
| **SealDice Extension API** | `seal.ext.register*Config()`, `seal.ext.get*Config()`, `seal.ext.find()`, `seal.ext.new()` — the sole mechanism for persisting user settings in the SealDice host. |
| **Handlebars** | Imported in `configManager.ts`. Used to compile user-customizable templates for system prompts, memory display, tool prompts, etc. into `HandlebarsTemplateDelegate`. |
| **Plugin modules** | `src/AI/`, `src/cmd/`, `src/tool/` import `ConfigManager` and access config via static getters (e.g. `ConfigManager.request.url`, `ConfigManager.memory.isMemory`). |
| **`config.ts` constants** | Imported directly by modules that need `VERSION`, `aliasMap`, `faceMap`, `PRIVILEGELEVELMAP`, `HELPMAP`. |
| **Logger** | `ConfigManager` imports `logger` from `src/logger.ts` for error reporting during regex/path parsing. |
