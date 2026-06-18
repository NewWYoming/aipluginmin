# Repository Atlas: aiplugin4

> A SealDice JS plugin that makes the dice bot converse like a human. Single bundled JS output loaded by SealDice.

## System Entry Points

| Entry | Role |
|-------|------|
| `src/index.ts` | Plugin main — registers SealDice hooks, routes incoming messages to AI, manages AI lifecycle (disabledInPrivate guard, private instance eviction), polls checkActiveTimer in all hooks |
| `header.txt` | UserScript metadata prepended to bundled output |
| `tools/build.js` | esbuild build script — bundles, prepends header, auto-backs up old dist |
| `src/config/config.ts` | Global constants: VERSION, AUTHOR, NAME, CQ type allowlist, privilege levels |

## Directory Map

| Directory | Responsibility | Codemap |
|-----------|---------------|---------|
| `src/` | Plugin entry (hooks wiring, AI lifecycle, disabledInPrivate guard), logger, timer system, version update | [📄](src/codemap.md) |
| `src/AI/` | Core AI: chat orchestration, context/memory management, image pool, session management | [📄](src/AI/codemap.md) |
| `src/config/` | SealDice plugin config registration & typed runtime access via ConfigManager cache | [📄](src/config/codemap.md) |
| `src/service/` | LLM API communication layer: AIClient (HTTP), ToolCallLoop (tool orchestration), legacy utilities | [📄](src/service/codemap.md) |
| `src/service/providers/` | Provider pattern for LLM backends: DeepSeek V4 (thinking mode), OpenAI-compatible generic | [📄](src/service/providers/codemap.md) |
| `src/tool/` | AI function-calling tools: ~42 tools across COC/TRPG, memory, alias, image, messaging, utility domains | [📄](src/tool/codemap.md) |
| `src/cmd/` | Chat command dispatch system: `.ai`, `.img`, `.timer` etc. with privilege management | [📄](src/cmd/codemap.md) |
| `src/cmd/sub_cmd/` | Individual subcommand implementations (17 commands) | [📄](src/cmd/sub_cmd/codemap.md) |
| `src/utils/` | Shared utilities: string parsing, message formatting, OB11 bridge, SealDice helpers | [📄](src/utils/codemap.md) |

## Architecture Overview

```
AI lifecycle (all hooks):
  disabledInPrivate guard → early return / evict private instances
  checkActiveTimer() → daily impression cleanup + active-time scheduling

Message processing:
onNotCommandReceived → index.ts routes → AI.chat()
  → handleMessages() assembles system prompt + context + POV-scoped memories + impressions
  → ToolCallLoop (thinking-enabled) iterates tool calls via AIClient
  → Provider (DeepSeek V4 / OpenAI-compatible) handles API specifics
  → handleReply() parses response → replyToSender()
  → context.addMessage() persists to messages array, collects user observations (Tier 1)

Config system:
  ConfigManager (singleton) → domain config classes → SealDice ext.register*Config() → typed get() with 3s TTL cache
  TTS: ConfigManager.backend.tts{Enabled,Provider,ApiKey,Voice,Model,ExtraBody} → tool_voice.ts routing

Session model:
  AIManager.getAI(sid) → per-session AI instance (private=uid, group=gid)
  Each AI has: context, memory (POV-scoped with impressions + composite scoring), imageManager, imagePool, toolManager, setting
```

## Key Design Patterns

- **Provider Strategy**: `ChatProvider` base class → `DeepSeekV4Provider` / `OpenaiCompatibleProvider`
- **Session-per-ID**: Each user/group gets an independent AI with isolated context, memory, and image pool
- **ValidKeys revival**: Custom serde for persistent plugin state (JSON.parse reviver)
- **Tool registrant**: Each `tool_*.ts` self-registers into `ToolManager.toolMap`
- **Config namespace isolation**: Each config group uses separate `ext` namespace prefix
