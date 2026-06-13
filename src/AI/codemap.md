# src/AI/ — Core AI Chat, Context, Memory & Image Management

---

## Responsibility

This directory is the **brain of the plugin**. It manages per-session AI instances that drive the bot's conversational behavior. Responsibilities include:

- **`AI.ts`** — Session-scoped AI orchestrator. Owns all sub-components (context, tools, memory, images, settings). Exposes `chat()` as the master entry point for generating a reply. The static `AIManager` handles serialization/deserialization of AI instances to/from SealDice storage, plus token usage tracking.
- **`context.ts`** — Conversation history management. Maintains the ordered message array (user + assistant + tool messages), enforces round limits, supports context-clearing flags, and provides cross-session user/group/image lookups.
- **`memory.ts`** — Long-term & short-term memory. `Memory` is a single indexed record with text, vector embedding, keywords, user/group associations, weight, and decay. `MemoryManager` manages the full collection — adding, searching (by vector similarity / keyword / recency / score), weighting (reinforcement-based), and periodic LLM-driven summarization into short-term memory. `KnowledgeMemoryManager` extends this for admin-defined knowledge bases.
- **`image.ts`** — Image representation (`Image` class with URL/base64/local type detection, OCR via LLM vision, URL validation/conversion) and `ImageManager` for handling image segments arriving in chat messages (OCR, auto-steal emoji into pool).
- **`ImagePool.ts`** — A searchable image library combining admin-defined local images with auto-stolen chat images. Supports text-token matching with Levenshtein fallback, freshness boosting, and paginated listing.

---

## Design Patterns

| Pattern | Where | How |
|---|---|---|
| **Singleton + Cache** | `AIManager` | Static `cache: { [id]: AI }` — keyed by user/group session ID. `getAI(id)` loads from storage on cache miss. |
| **Strategy** | `Memory.search()` | Six sort methods (`weight`, `similarity`, `score`, `early`, `late`, `recent`) selected via `options.method`. |
| **Template Method** | `MemoryManager.buildMemory()` / `KnowledgeMemoryManager.buildKnowledgeMemory()` | Shared search logic, different rendering via configurable templates. |
| **Revival (serialization)** | All classes | Custom `revive()` utility reconstructs class instances from plain JSON after `JSON.parse`. Each class declares `static validKeys` for controlled serialization. |
| **Token Bucket** | `AI.bucket` | Rate-limits AI triggers: refills at `fillInterval`, capped at `bucketLimit`, decrements on each `chat()`. |
| **Composition** | `AI` class | Holds `Context`, `ToolManager`, `MemoryManager`, `ImageManager`, `ImagePool`, `Setting` as composable sub-objects. |
| **Reinforcement Weighting** | `memory.ts` | Memory weights increase when their keywords appear in user messages, decay otherwise. |
| **Embedding-augmented Retrieval** | `Memory` | Optional vector embeddings (`cosineSimilarity`) combined with keyword/user/group matching for scored retrieval. |
| **LLM-as-a-Service summarization** | `MemoryManager.updateShortMemory()` | Delegates conversation summarization to an LLM, parsing structured JSON output into memory entries. |

---

## Data / Control Flow

### Chat Reply Flow (`AI.chat()`)

```
User message arrives
       │
       ▼
AI.chat(reason)
  ├─ Token bucket check (skip if tool-callback)
  ├─ AI.resetState() → clear context timer, decrement bucket, reset tool call count
  ├─ Build AIClient from ConfigManager.request settings
  ├─ handleMessages(ctx, ai) → assemble OpenAI-format message array from:
  │     ├─ System prompt (role setting + persona + memory prompt)
  │     ├─ Context.messages (history)
  │     └─ MemoryManager.buildMemoryPrompt() (top-scored memories)
  │
  ├─ [if tools enabled] ToolCallLoop.run() → multi-turn function calling
  │     └─ Each tool call: context.addToolCallsMessage() → execute → context.addToolMessage()
  │
  ├─ [else] AIClient.chat() → single-turn completion
  │
  ├─ handleReply() → parse response into reply segments (text + images + context)
  ├─ AI.reply() → for each segment: replyToSender() + context.addMessage() (role=assistant)
  │
  └─ AIManager.saveAI(id) → persist session to SealDice storage
```

### Message Reception Flow (via `AI.handleReceipt()`)

```
Incoming message
       │
       ▼
AI.handleReceipt() → transformArrayToContent()
  ├─ ImageManager.handleImageMessageSegment() for each image segment
  │     └─ Optionally: imageToText() (LLM OCR) + auto-steal to ImagePool (emoji probability)
  └─ context.addMessage() → append to history, update name, check clear-flags, update short memory
```

### Short Memory Flow

```
addMessage() increments summaryCounter
       │
       ▼
if summaryCounter >= shortMemorySummaryRound:
  MemoryManager.updateShortMemory()
    ├─ Build summarization prompt from recent N rounds
    ├─ Call LLM → parse JSON with { content, memories[] }
    ├─ Push content to shortMemoryList
    └─ For each parsed memory → ToolManager.toolMap["add_memory"].solve()
```

### Memory Search Flow

```
MemoryManager.search(query, options)
  ├─ Optionally: compute query vector embedding
  ├─ Ensure all stored vectors match embeddingDimension (re-fetch if stale)
  ├─ For each memory: copy, apply query-keyword weight boost (+10)
  ├─ Sort by selected strategy (score/similarity/weight/early/late/recent)
  └─ Return topK results
```

### Image Auto-Steal Flow

```
ImageManager.handleImageMessageSegment() → imageToText() returns JSON { text1, text2, isEmoji }
       │
       ▼
if isEmoji && Math.random() * 100 < ConfigManager.image.p:
  ImagePool.add({ file, description, source:'stolen' })
  → ImagePool.limit() evicts oldest if > maxStolenImageNum
```

---

## Integration Points

| Direction | Connects to | Mechanism |
|---|---|---|
| **Inbound** | `src/cmd/` (chat commands: `.ai`, `.timer`, etc.) | Commands call `AIManager.getAI(sid).chat(ctx, msg, reason)` or `handleReceipt()`. |
| **Inbound** | `src/index.ts` (main entry) | Registers `onNotCommandReceived` / `onCommandReceived` hooks → route to AI. |
| **Outbound (LLM)** | `src/service/AIClient` | `AI.chat()` creates `AIClient` from request config, calls `client.chat()` or passes to `ToolCallLoop`. |
| **Outbound (memory LLM)** | `src/service/legacy` (`fetchData`, `getEmbedding`, `sendITTRequest`) | Short memory summarization, embedding generation, image-to-text. |
| **Outbound (tools)** | `src/tool/tool.ts` (`ToolManager`) | `ToolCallLoop.run()` uses `ToolManager.getToolsInfo()` and routes function calls back to `toolMap`. |
| **Outbound (reply)** | `src/utils/utils.ts` (`replyToSender`) + `src/utils/utils_string.ts` (`handleReply`) | `AI.reply()` sends messages via SealDice API. |
| **Config** | `src/config/configManager.ts` (`ConfigManager`) | All files read their settings (API keys, limits, templates, flags) from `ConfigManager.*`. |
| **Persistence** | SealDice `ext.storageSet`/`storageGet` | `AIManager.saveAI/getAI` serializes/deserializes each `AI` instance. `KnowledgeMemoryManager` stores knowledge separately. |
| **Timer** | `src/timer/TimerManager` | `AI.checkActiveTimer()` schedules active-time wake-up timers. Timer callbacks invoke `AI.chat()`. |
| **Logger** | `src/logger` | All files use `logger.info/warning/error` for structured logging. |
| **QQ API (OB11)** | `src/utils/utils_ob11.ts` | `context.ts` uses `getFriendList`, `getGroupMemberInfo`, `getStrangerInfo`, `netExists` for user/group lookups. |
