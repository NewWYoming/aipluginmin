# src/utils/

## Responsibility

Shared utility functions consumed across the plugin: ID generation, message format conversion (CQ code <-> AI tokens <-> MessageSegment arrays), SealDice context creation, OneBot v11 API calls, AI message pipeline assembly, string similarity, version checking, and JSON repair. No business logic lives here—these are pure helpers with no circular dependencies between utils files.

## Design Patterns

| Pattern | Where | Rationale |
|---------|-------|-----------|
| **Thin host-API wrappers** | `utils_ob11.ts`, `utils_seal.ts` | Every function grabs the host runtime dependency (`net`/`http`/`seal`) inline, guards against null, and catches errors uniformly. Avoids abstraction layers—callers get a simple async function. |
| **Unified segment interface** | `utils_string.ts` `MessageSegment` | A single `{ type: string, data: { [key: string]: string } }` type serves both CQ-code parsing and OB11 API calls. Keeps the data model flat and JSON-friendly. |
| **Token-based serialization** | `<|tag:value|>` tokens | AI output uses special tokens (`<|at:name|>`, `<|quote:id|>`, `<|poke:name|>`, `<|face:name|>`) that `utils_string.ts` parses/emits. This decouples AI-generated text from platform-specific CQ codes. |
| **Promise-race timeout** | `utils.ts` `withTimeout` | Generic wrapper for any async operation—used wherever external API calls might hang. |
| **Revive + validKeys** | `utils.ts` `revive` | After JSON.parse loses class methods, `revive` restores typed instances using a static `validKeys` whitelist. Prevents prototype pollution while keeping serialization simple. |
| **Template-based filtering** | `utils_string.ts` `filterString` | AI reply text is split by filter regexes; matched segments are rerouted through configurable context/reply templates. Enables fine-grained control (e.g., suppress tool output, reformat certain patterns). |

## Key Functions by File

### `utils.ts` — General helpers

| Function | Purpose |
|----------|---------|
| `transformMsgId` / `transformMsgIdBack` | Encode/decode numeric message IDs to/from base-36 strings (compact, URL-safe). |
| `generateId` | Short 6-char ID from timestamp + random (base-36). Used for ephemeral correlation IDs. |
| `replyToSender` | High-level reply: sends via OB11 API when `showMsgId` is enabled (to capture `message_id`), otherwise falls back to `seal.replyToSender`. Also filters/handles `[CQ:poke]` segments separately. |
| `withTimeout` | `Promise.race` wrapper; rejects after `timeoutMs`. |
| `revive` | Restore constructor-instantiated objects from plain JSON using `validKeys`. |
| `aliasToCmd` | Resolve user-defined command aliases from `aliasMap`. |
| `cosineSimilarity` | Cosine similarity for numeric vectors (used in context relevance). |
| `levenshteinDistance` | Classic edit distance for strings. |
| `getCommonUser` / `getCommonGroup` / `getCommonKeyword` | Set-intersection helpers for user/group/keyword lists. |

### `utils_message.ts` — AI context assembly

| Function | Purpose |
|----------|---------|
| `buildSystemMessage` | Constructs the system prompt by rendering the `systemMessageTemplate` with current context (platform, user, group, role, knowledge, memory). |
| `buildSamplesMessages` | Converts config `samples` (flat string array, even=user odd=assistant) into `Message[]` for few-shot prompting. |
| `buildContextMessages` | Periodically re-inserts the system message into conversational context (every `insertCount` user turns) to reinforce behavior. |
| `handleMessages` | **Main pipeline**: calls the three builders above, prunes orphaned `tool_calls` (where no corresponding `role: 'tool'` message exists) and removes the tool-call message entirely if empty, merges consecutive same-role messages when `isMerge` is on. |
| `buildContent` | Serializes a `Message` to plain text with optional prefix, message ID, and timestamp markers (timezone-aware via `utcOffset`). |
| `getRoleSetting` | Reads `$gSYSPROMPT` variable (string or int) and resolves to a role setting template. |

### `utils_ob11.ts` — OneBot v11 API

All follow the same pattern: `getNet()` → `net.callApi(epId, action, params)` → catch + log.

| Function | API Action | Use Case |
|----------|-----------|----------|
| `sendPrivateMsg` / `sendGroupMsg` | `send_private_msg` / `send_group_msg` | Message sending with `message_id` capture. |
| `getStrangerInfo` | `get_stranger_info` | User info lookup. |
| `getGroupMemberInfo` / `getGroupMemberList` | `get_group_member_info` / `get_group_member_list` | Group roster queries. |
| `getFriendList` / `getGroupList` | `get_friend_list` / `get_group_list` | Contact/group enumeration. |
| `setGroupBan` / `setGroupWholeBan` | `set_group_ban` / `set_group_whole_ban` | Mute/unmute. |
| `getGroupShutList` | `get_group_shut_list` | Ban list query. |
| `setEssenceMsg` / `getEssenceMsgList` / `deleteEssenceMsg` | `set_essence_msg` / `get_essence_msg_list` / `delete_essence_msg` | Essence message management. |
| `sendGroupSign` | `send_group_sign` | Group sign-in. |
| `getMsg` / `deleteMsg` | `get_msg` / `delete_msg` | Message retrieval/deletion. |
| `sendGroupAISound` | `send_group_ai_record` | AI voice synthesis in groups. |
| `sendPrivateForwardMsg` / `sendGroupForwardMsg` | `send_private_forward_msg` / `send_group_forward_msg` | Forward (combined) message sending. |

### `utils_seal.ts` — SealDice context creation

| Function | Purpose |
|----------|---------|
| `createMsg` | Factory for `seal.Message` with messageType, uid, gid. |
| `createCtx` | Finds the endpoint matching `epId`, creates a temporary context via `seal.createTempCtx`. |
| `getCtxAndMsg` | Combines the above two — common convenience for AI-initiated sends. |
| `getSessionCtxAndMsg` | Variant keyed by session ID (`sid`) + privacy flag instead of uid/gid. |

### `utils_string.ts` — String & content transformation

| Function | Purpose |
|----------|---------|
| `transformTextToArray` | Splits raw text on `[CQ:...]` patterns → `MessageSegment[]`. |
| `transformArrayToText` | Reverses the above: `MessageSegment[]` → CQ code string. |
| `transformArrayToContent` | Converts incoming message segments to AI-readable text + `Image[]`. Resolves `at`/`poke` via context, `reply` to message ID, `image` via `ai.imageManager`. |
| `handleReply` | **Main reply pipeline**: splits AI output by `<|from:...|>` multi-turn markers, extracts quote/poke segments, applies `filterString` to produce separated `contextArray`/`replyArray` (for log vs send), resolves tokens back to CQ codes. Also applies `replymsg` prefix (reply chain). |
| `checkRepeat` | Anti-repetition guard: computes similarity of AI output vs last assistant message; if above threshold, removes the offending context block and returns `true` (skips reply). |
| `calculateSimilarity` | Normalized Levenshtein-based similarity (1 - distance/maxLen). |
| `parseSpecialTokens` | Lexes `<|tag:content|>` tokens from AI output strings. |
| `filterString` | Splits text by `\f` separators and configurable regexes — each regex match can be rerouted through custom `contextTemplate`/`replyTemplate`. Enforced max-char truncation. |
| `advancedSplit` | Splits a string on a regex while preserving the matched delimiters in the result array. |
| `fmtDate` | Unix timestamp → `YYYY-MM-DD HH:mm:ss` format string. `utcOffset` parameter (hours, default 0) uses `getUTC*()` with offset compensation to bypass goja UTC bug. |
| `fixJsonString` | Tries to repair JSON missing leading double-quotes on keys/values (common with LLM output). Falls back to empty string on failure. |

### `utils_update.ts` — Version management

| Function | Purpose |
|----------|---------|
| `compareVersions` | `1` / `-1` / `0` for semver `x.y.z` strings. |
| `checkUpdate` | Reads stored version from SealDice persistent storage; if current `VERSION` is newer, writes it and logs the changelog from `updateInfo`. Called once at plugin load. |

## Integration Points

| Consumer | What it uses |
|----------|-------------|
| **`src/AI/`** (core chat) | `handleMessages`, `handleReply`, `buildSystemMessage`, `checkRepeat`, `transformArrayToContent`, `revive`, `withTimeout`, cosine similarity helpers |
| **`src/cmd/`** (commands) | `getCtxAndMsg`, `replyToSender`, `transformMsgId`, `createCtx`, various OB11 wrappers |
| **`src/tool/`** (function-calling tools) | `getCommonUser`, `getCommonGroup`, `getCommonKeyword`, OB11 API wrappers (group management, member queries) |
| **`src/config/configManager.ts`** | Config reader — all utils files import `ConfigManager` for feature flags and settings |
| **Plugin entry (`src/index.ts`)** | `checkUpdate` called once on startup |
