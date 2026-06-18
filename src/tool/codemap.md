# src/tool/ — Codemap

## 1. Responsibility

The `src/tool/` directory implements the **AI function-calling tools system** — a registry of capabilities that the AI model can invoke autonomously during conversation. Each tool wraps a specific operation (rolling dice, querying user info, sending messages, searching the web, etc.) as a typed function that the LLM discovers via its `tools` API parameter and triggers through `tool_calls` in its response.

This bridges the gap between natural-language AI output and concrete bot actions within the SealDice runtime.

---

## 2. File Inventory

| File | Tools Registered | Domain |
|---|---|---|---|
| `tool.ts` | (framework) | Core: `Tool` class + `ToolManager` registry |
| `sample.ts` | `sample` | Template / reference (not registered) |
| `tool_memory.ts` | `add_memory`, `del_memory`, `search_memory`, `clear_memory` | Memory CRUD |
| `tool_attr.ts` | `attr_show`, `attr_get`, `attr_set` | COC 7th attributes |
| `tool_roll_check.ts` | `roll_check`, `san_check` | COC 7th dice rolling |
| `tool_modu.ts` | `modu_roll`, `modu_search` | COC module/story |
| `tool_deck.ts` | `list_decks`, `draw_deck` | Card decks |
| `tool_jrrp.ts` | `jrrp` | Daily luck |
| `tool_image.ts` | `image_to_text`, `text_to_image`, `list_images`, `send_image` | Image processing — **deprecated**, `registerImage()` commented out in `tool.ts` |
| `tool_render.ts` | `render_markdown`, `render_html` | Content→image rendering |
| `tool_voice.ts` | `text_to_sound` | Voice / TTS (custom & API modes) |
| `tool_music.ts` | `music_play` | Music search & play |
| `tool_web.ts` | `web_search`, `web_read` | Web search (Jina primary + SearXNG fallback) & scraping (Jina Reader) |
| `tool_alias.ts` | `edit_alias` | User alias mapping (add/delete) |
| `tool_time.ts` | `get_time`, `set_timer`, `show_timer_list`, `cancel_timer` | Time & timers |
| `tool_ban.ts` | `ban`, `whole_ban`, `get_ban_list` | QQ group mute |
| `tool_rename.ts` | `rename` | Group nickname |
| `tool_group_sign.ts` | `group_sign` | Group check-in |
| `tool_person_info.ts` | `get_person_info` | User profile |
| `tool_qq_list.ts` | `get_list`, `get_group_member_list`, `search_chat`, `search_common_group` | QQ lists & search |
| `tool_message.ts` | `send_msg`, `get_msg`, `delete_msg`, `send_forward_msg` | Cross-session messaging |
| `tool_essence_msg.ts` | `set_essence_msg`, `get_essence_msg_list`, `delete_essence_msg` | Essence messages |
| `tool_context.ts` | `get_context` | Conversation context inspection |
| `tool_trigger.ts` | `set_trigger_condition` | Proactive trigger conditions |

Total: **~42 tools** across **22 files** (20 active tool files + tool.ts + sample.ts). `tool_record.ts` removed, `tool_image.ts` deprecated (file kept, registration commented out).

---

## 3. Design Patterns

### 3a. Registrant Pattern (explicit registration)

Each `tool_*.ts` file exports a single `register*()` function. `ToolManager.registerTool()` (in `tool.ts`) calls them all explicitly. No auto-discovery — the central registry is the single source of truth.

```
ToolManager.registerTool()
  ├─ registerMemory()    → tool_memory.ts
  ├─ registerDeck()      → tool_deck.ts
  ├─ registerJrrp()      → tool_jrrp.ts
  ├─ registerModu()      → tool_modu.ts
  ├─ registerRollCheck() → tool_roll_check.ts
  ├─ registerAlias()     → tool_alias.ts
  ├─ registerRename()    → tool_rename.ts
  ├─ registerAttr()      → tool_attr.ts
  ├─ registerBan()       → tool_ban.ts
  ├─ registerTTS()       → tool_voice.ts
  ├─ registerTime()      → tool_time.ts
  ├─ registerWeb()       → tool_web.ts
  ├─ registerGroupSign() → tool_group_sign.ts
  ├─ registerGetPersonInfo() → tool_person_info.ts
  ├─ registerMessage()   → tool_message.ts
  ├─ registerEssenceMsg()→ tool_essence_msg.ts
  ├─ registerContext()   → tool_context.ts
  ├─ registerQQList()    → tool_qq_list.ts
  ├─ registerSetTrigger()→ tool_trigger.ts
  ├─ registerMusicPlay() → tool_music.ts
  └─ registerRender()    → tool_render.ts
      // registerImage() commented out
```

### 3b. Class-per-Tool with Static Registry

Every tool is a `Tool` instance whose constructor auto-registers into `ToolManager.toolMap[name]`. No separate registry step needed after `new Tool(info)`.

```
class Tool {
  info: ToolInfo;
  cmdInfo: CmdInfo;       // Seal extension command info (ext, name, fixedArgs)
  type: string;            // Chat scene restriction: "private" | "group" | "all"
  tool_choice: string;     // Call-chain control: "none" | "auto" | "required"
  solve: (ctx, msg, ai, args) => Promise<{ content, images }>;

  constructor(info) {
    this.info = info;
    this.cmdInfo = { ext: '', name: '', fixedArgs: [] };
    this.type = "all";
    this.tool_choice = 'auto';
    this.solve = defaultStub;
    ToolManager.toolMap[info.function.name] = this;  // auto-register
  }
}
```

- **`type`** — restricts which chat scene (`private` / `group`) can invoke the tool. `"all"` means no restriction. Checked in `handleToolCall()` before execution.
- **`tool_choice`** — returned from `solve()` to signal whether the LLM should continue calling more tools: `"none"` (stop), `"auto"` (model decides), `"required"` (must call more tools).
- **`cmdInfo`** — bridge to SealDice extension commands. When set (non-empty `ext`), `handleToolCall()` lazy-initialises `ToolManager.cmdArgs` for delegation via `extensionSolve()`.

### 3c. Strategy Pattern via `solve` Override

Each tool sets `tool.solve` to an async function with a fixed signature:

```typescript
(ctx: seal.MsgContext, msg: seal.Message, ai: AI, args: { [key: string]: any })
  => Promise<{ content: string, images: Image[] }>
```

The `solve` function is swapped after construction — the Tool class provides a no-op default, and each registration function replaces it with the actual implementation.

### 3d. OpenAPI-Style Tool Schema

Tool definitions follow the OpenAI function-calling schema format (`ToolInfo` → `ToolInfoObject` → `ToolInfoItem` union types), making the tool list directly serializable as the `tools` parameter in LLM API calls.

### 3e. Extension Delegation (CmdInfo bridge)

Tools that wrap existing SealDice extension commands set `tool.cmdInfo` (ext name, command name, fixed args) and call `ToolManager.extensionSolve()` to delegate to the native command handler. This reuses existing dice bot functionality without duplicating logic.

Tools using this pattern: `attr_show`, `attr_get`, `attr_set`, `jrrp`, `roll_check`, `san_check`, `modu_roll`, `modu_search`.

The `CmdInfo` interface and `Tool.cmdInfo` field enable this: each tool's registration sets `tool.cmdInfo = { ext, name, fixedArgs }`, and `handleToolCall()` lazy-initialises `ToolManager.cmdArgs` with a null-guard (`this.cmdArgs = this.cmdArgs || {} as seal.CmdArgs`).

---

## 4. Data / Control Flow

```
User Message
  │
  ▼
AI.chat()                                  ← src/AI/
  │
  ├─ ai.tool.getToolsInfo(type)            ← returns ToolInfo[] for enabled scene
  │     filters by toolStatus + tool.type (+ chat scene via `type` field)
  │     returns null when no tools enabled
  │
  ├─ LLM responds with tool_calls[]
  │
  ▼
ToolManager.handleToolCalls(ctx, msg, ai, tool_calls)
  │
  ├─ Enforces maxCallCount cap (splices excess)
  ├─ Iterates each ToolCall, aggregates tool_choice:
  │   "required" → required; "auto" → auto; "none" → default
  │
  ▼
ToolManager.handleToolCall(ctx, msg, ai, tool_call)
  │
  ├─ blocks toolsNotAllow[]                    ← hard block from config
  ├─ checks toolMap registration               ← must exist
  ├─ lazy-inits cmdArgs if tool.cmdInfo.ext    ← null guard fix
  ├─ checks tool.type vs msg.messageType       ← scene restriction
  ├─ JSON.parse + fixJsonString fallback       ← malformed LLM output
  ├─ validates required parameters
  ├─ Calls tool.solve(ctx, msg, ai, parsedArgs)
  │     │
  │     ├─ May call ToolManager.extensionSolve()  → delegates to seal.ext cmd
  │     │     └─ Listens for cmd output via ai.tool.listen promise (10s timeout)
  │     │
  │     └─ Returns { content, images }
  │
  ├─ ai.context.addToolMessage(id, content, images)   ← feeds result back to LLM
  │
  └─ Returns tool.tool_choice ('none' | 'auto' | 'required')
       → determines whether LLM should continue calling more tools
```

### Key State

- **`ToolManager.toolMap`** — static, all registered tools by name (populated at import time via `Tool` constructor)
- **`ToolManager.toolStatus`** — per-instance, which tools are enabled/disabled; initialised from `toolsNotAllow` + `toolsDefaultClosed` config
- **`ToolManager.listen`** — per-instance, promise-based listener for extension command output (10s timeout)
- **`ToolManager.cmdArgs`** — static, shared `CmdArgs` instance reused by all `extensionSolve()` calls. **Lazy-init with null guard**: `this.cmdArgs = this.cmdArgs || {} as seal.CmdArgs` (in `handleToolCall()` and `extensionSolve()`); typed as `seal.CmdArgs | null`, defaults to `null`
- **`reviveToolStatus()`** — reconciles `toolStatus` after config change: preserves existing states, re-applies `toolsNotAllow`/`toolsDefaultClosed` for new tools, and marks config-blocked tools as disabled. Called when config reloads without re-creating the `ToolManager` instance

---

## 5. Integration Points

| Integration | Direction | Details |
|---|---|---|---|
| **`src/AI/AI.ts`** — `AIManager`, `AI` class | Imported by tools | `ai.context`, `ai.memory`, `ai.imagePool`, `ai.id`, `ai.tool` (the `ToolManager` instance) |
| **`src/AI/image.ts`** — `Image` class | Imported by tools | Returned in `solve` results; used for rendering, message sending |
| **`src/AI/memory.ts`** — `knowledgeMM`, `searchOptions` | Imported by `tool_memory.ts` | Knowledge-base memory operations |
| **`src/config/configManager.ts`** — `ConfigManager` | Imported by most tools | `ConfigManager.tool.*` (decks, bans, default-closed, maxCallCount, record paths, character), `ConfigManager.backend.*` (web URLs, render URL, TTS config, music API), `ConfigManager.message.*` (showNumber, isPrefix) |
| **`src/utils/utils_seal.ts`** — `getCtxAndMsg` | Imported by several tools | Constructs temporary `MsgContext` for cross-session operations |
| **`src/utils/utils_ob11.ts`** — OB11 network helpers | Imported by admin & group tools | `netExists`, `getGroupMemberInfo`, `setGroupBan`, `sendGroupSign`, `getFriendList`, etc. |
| **`src/utils/utils_string.ts`** — `fixJsonString`, `parseSpecialTokens`, `fmtDate` | Imported by tool.ts + tool_message.ts, tool_render.ts plus tool_essence_msg.ts, tool_ban.ts, tool_time.ts | JSON repair for malformed LLM output; content parsing; timezone-aware timestamp formatting |
| **`src/utils/utils.ts`** — `generateId`, `replyToSender`, `transformMsgId` | Imported by tool_image.ts, tool_message.ts, tool_essence_msg.ts, tool_render.ts | ID generation, message sending, ID format conversion |
| **`src/utils/utils_message.ts`** — `buildContent`, `handleReply`, `getRoleSetting` | Imported by tool_context.ts, tool_memory.ts, tool_message.ts | Message building helpers |
| **`src/timer.ts`** — `TimerManager` | Imported by `tool_time.ts` | Timer CRUD operations |
| **`src/logger.ts`** — logger | Imported by many tools | Structured logging (`.warning()` method used instead of deprecated `.warn()`) |
| **SealDice Runtime** — `seal.ext`, `seal.deck`, `seal.vars`, `seal.replyToSender`, `seal.setPlayerGroupCard`, `seal.format`, `seal.base64ToImage` | Used via global scope | Native dice bot extension system, deck drawing, variable CRUD, message sending |
| **OB11 / OneBot v11** — via `utils_ob11.ts` | Indirect via util functions | HTTP-based QQ bot protocol for group management, messaging, TTS, group sign-in |
| **External APIs** — Jina Search (POST s.jinaai.cn), Jina Reader (r.jinaai.cn), SearXNG (fallback), render endpoint, music search APIs, DashScope TTS API | Direct fetch calls with retry/caching in tool_web.ts, tool_render.ts, tool_music.ts, tool_voice.ts | Backend services configured via `ConfigManager.backend` (jinaApiKey, webSearchUrl, webReadUrl, ttsApiKey, ttsModel) |

---

## 6. Tool Categories by Dependency Type

| Category | Tools | Dependency |
|---|---|---|---|
| **Standalone** (no ext/network) | `get_time`, `list_decks`/`draw_deck`, `search_memory`, `add_memory`, `del_memory`, `clear_memory`, `get_context`, `edit_alias` | AI instance only |
| **Extension-delegated** (via `extensionSolve`) | `attr_show`, `attr_get`, `attr_set`, `jrrp`, `roll_check`, `san_check`, `modu_roll`, `modu_search` | SealDice extension commands |
| **OB11 network** (group admin) | `ban`, `whole_ban`, `get_ban_list`, `rename`, `group_sign`, `get_person_info`, `get_list`, `get_group_member_list`, `search_chat`, `search_common_group`, `get_msg`, `delete_msg`, `send_forward_msg`, `set_essence_msg`, `get_essence_msg_list`, `delete_essence_msg` | `utils_ob11.ts` |
| **External HTTP** | `web_search`, `web_read`, `music_play`, `render_markdown`, `render_html`, `text_to_sound` (API mode) | Backend services (Jina API / SearXNG / render / music API / DashScope TTS) |
| **Plugin-dependent** | `text_to_sound` (custom voice mode) | `AITTS` plugin + ffmpeg |
| **Cross-session** (switches AI context) | `send_msg`, `get_context`, `add_memory`, `del_memory`, `search_memory`, `clear_memory` | Uses `AIManager.getAI()` + `getCtxAndMsg()` |
| **Deprecated / Unregistered** | `image_to_text`, `text_to_image`, `list_images`, `send_image` | `tool_image.ts` file kept, registration commented out |
