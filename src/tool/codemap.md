# src/tool/ — Codemap

## 1. Responsibility

The `src/tool/` directory implements the **AI function-calling tools system** — a registry of capabilities that the AI model can invoke autonomously during conversation. Each tool wraps a specific operation (rolling dice, querying user info, sending messages, searching the web, etc.) as a typed function that the LLM discovers via its `tools` API parameter and triggers through `tool_calls` in its response.

This bridges the gap between natural-language AI output and concrete bot actions within the SeaDice runtime.

---

## 2. File Inventory

| File | Tools Registered | Domain |
|---|---|---|
| `tool.ts` | (framework) | Core: `Tool` class + `ToolManager` registry |
| `sample.ts` | `sample` | Template / reference |
| `tool_memory.ts` | `add_memory`, `del_memory`, `search_memory`, `clear_memory` | Memory CRUD |
| `tool_attr.ts` | `attr_show`, `attr_get`, `attr_set` | COC 7th attributes |
| `tool_roll_check.ts` | `roll_check`, `san_check` | COC 7th dice rolling |
| `tool_modu.ts` | `modu_roll`, `modu_search` | COC module/story |
| `tool_deck.ts` | `list_decks`, `draw_deck` | Card decks |
| `tool_jrrp.ts` | `jrrp` | Daily luck |
| `tool_image.ts` | `image_to_text`, `text_to_image`, `list_images`, `send_image` | Image processing |
| `tool_render.ts` | `render_markdown`, `render_html` | Content→image rendering |
| `tool_voice.ts` | `record`, `text_to_sound` | Voice / TTS |
| `tool_music.ts` | `music_play` | Music search & play |
| `tool_web.ts` | `web_search`, `web_read` | Web search & scraping |
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

Total: **~41 tools** across **22 files** (20 tool files + tool.ts + sample.ts).

---

## 3. Design Patterns

### 3a. Registrant Pattern (explicit registration)

Each `tool_*.ts` file exports a single `register*()` function. `ToolManager.registerTool()` (in `tool.ts`) calls them all explicitly. No auto-discovery — the central registry is the single source of truth.

```
ToolManager.registerTool()
  ├─ registerMemory()    → tool_memory.ts
  ├─ registerDeck()      → tool_deck.ts
  ├─ registerJrrp()      → tool_jrrp.ts
  ├─ ... (20 more)
  └─ registerRender()    → tool_render.ts
```

### 3b. Class-per-Tool with Static Registry

Every tool is a `Tool` instance whose constructor auto-registers into `ToolManager.toolMap[name]`. No separate registry step needed after `new Tool(info)`.

```
class Tool {
  constructor(info) {
    this.info = info;
    this.solve = defaultStub;
    ToolManager.toolMap[info.function.name] = this;  // auto-register
  }
}
```

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

Tools that wrap existing SeaDice extension commands set `tool.cmdInfo` (ext name, command name, fixed args) and call `ToolManager.extensionSolve()` to delegate to the native command handler. This reuses existing dice bot functionality without duplicating logic.

Tools using this pattern: `attr_*`, `jrrp`, `roll_check`, `san_check`, `modu_*`.

---

## 4. Data / Control Flow

```
User Message
  │
  ▼
AI.chat()                                  ← src/AI/
  │
  ├─ ai.tool.getToolsInfo(type)            ← returns ToolInfo[] for enabled scene
  │     filters by toolStatus + tool.type
  │
  ├─ LLM responds with tool_calls[]
  │
  ▼
ToolManager.handleToolCalls(ctx, msg, ai, tool_calls)
  │
  ├─ Enforces maxCallCount cap
  ├─ Iterates each ToolCall:
  │
  ▼
ToolManager.handleToolCall(ctx, msg, ai, tool_call)
  │
  ├─ Validates: name allowed? registered? scene match? JSON parse?
  ├─ Calls tool.solve(ctx, msg, ai, parsedArgs)
  │     │
  │     ├─ May call ToolManager.extensionSolve()  → delegates to seal.ext cmd
  │     │     └─ Listens for cmd output via ai.tool.listen promise
  │     │
  │     └─ Returns { content, images }
  │
  ├─ ai.context.addToolMessage(id, content, images)   ← feeds result back to LLM
  │
  └─ Returns tool_choice ('none' | 'auto' | 'required')
       → determines whether LLM should continue calling more tools
```

### Key State

- **`ToolManager.toolMap`** — static, all registered tools by name (populated at import time)
- **`ToolManager.toolStatus`** — per-instance, which tools are enabled/disabled
- **`ToolManager.listen`** — per-instance, promise-based listener for extension command output (10s timeout)
- **`ToolManager.cmdArgs`** — static, shared `CmdArgs` instance reused by all extensionSolve calls (requires `.r` init)

---

## 5. Integration Points

| Integration | Direction | Details |
|---|---|---|
| **`src/AI/AI.ts`** — `AIManager`, `AI` class | Imported by tools | `ai.context`, `ai.memory`, `ai.imagePool`, `ai.id`, `ai.tool` (the `ToolManager` instance) |
| **`src/AI/image.ts`** — `Image` class | Imported by tools | Returned in `solve` results; used for image-to-text, TTI, render, message sending |
| **`src/AI/memory.ts`** — `knowledgeMM`, `searchOptions` | Imported by `tool_memory.ts` | Knowledge-base memory operations |
| **`src/config/configManager.ts`** — `ConfigManager` | Imported by most tools | `ConfigManager.tool.*` (decks, bans, default-closed, maxCallCount, record paths, character), `ConfigManager.backend.*` (web URLs, render URL), `ConfigManager.message.*` (showNumber, isPrefix) |
| **`src/utils/utils_seal.ts`** — `getCtxAndMsg` | Imported by several tools | Constructs temporary `MsgContext` for cross-session operations |
| **`src/utils/utils_ob11.ts`** — OB11 network helpers | Imported by admin tools | `netExists`, `getGroupMemberInfo`, `setGroupBan`, `sendGroupAISound`, `getFriendList`, etc. |
| **`src/utils/utils_string.ts`** — `fixJsonString`, `parseSpecialTokens`, etc. | Imported by tool.ts + tool_message.ts, tool_render.ts | JSON repair for malformed LLM output; content parsing |
| **`src/utils/utils.ts`** — `generateId`, `replyToSender`, `transformMsgId` | Imported by tool_image.ts, tool_message.ts, tool_essence_msg.ts, tool_render.ts | ID generation, message sending, ID format conversion |
| **`src/utils/utils_message.ts`** — `buildContent`, `handleReply`, `getRoleSetting` | Imported by tool_context.ts, tool_memory.ts, tool_message.ts | Message building helpers |
| **`src/timer.ts`** — `TimerManager` | Imported by `tool_time.ts` | Timer CRUD operations |
| **`src/logger.ts`** — logger | Imported by many tools | Structured logging |
| **SeaDice Runtime** — `seal.ext`, `seal.deck`, `seal.vars`, `seal.replyToSender`, `seal.setPlayerGroupCard`, `seal.format`, `seal.base64ToImage` | Used via global scope | Native dice bot extension system, deck drawing, variable CRUD, message sending |
| **OB11 / OneBot v11** — via `utils_ob11.ts` | Indirect via util functions | HTTP-based QQ bot protocol for group management, messaging, TTS |
| **External APIs** — web search endpoint, render endpoint, music search APIs | Direct fetch calls in tool_web.ts, tool_render.ts, tool_music.ts | Backend services configured via `ConfigManager.backend` |

---

## 6. Tool Categories by Dependency Type

| Category | Tools | Dependency |
|---|---|---|
| **Standalone** (no ext/network) | `get_time`, `list_decks`/`draw_deck`, `search_memory`, `add_memory`, `del_memory`, `clear_memory`, `get_context`, `list_images`, `send_image` | AI instance only |
| **Extension-delegated** (via `extensionSolve`) | `attr_show`, `attr_get`, `attr_set`, `jrrp`, `roll_check`, `san_check`, `modu_roll`, `modu_search` | SeaDice extension commands |
| **OB11 network** (group admin) | `ban`, `whole_ban`, `get_ban_list`, `rename`, `group_sign`, `get_person_info`, `get_list`, `get_group_member_list`, `search_chat`, `search_common_group`, `get_msg`, `delete_msg`, `send_forward_msg`, `set_essence_msg`, `get_essence_msg_list`, `delete_essence_msg`, `text_to_sound` (non-custom) | `utils_ob11.ts` |
| **External HTTP** | `web_search`, `web_read`, `music_play`, `render_markdown`, `render_html` | Backend services |
| **Plugin-dependent** | `text_to_image`, `text_to_sound` (custom mode) | `AIDrawing` / `AITTS` plugins |
| **Cross-session** (switches AI context) | `send_msg`, `get_context`, `add_memory`, `del_memory`, `search_memory`, `clear_memory` | Uses `AIManager.getAI()` + `getCtxAndMsg()` |
