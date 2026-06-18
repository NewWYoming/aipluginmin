# src/AI/ — Core AI Chat, Context, Memory & Image Management

---

## Responsibility

This directory is the **brain of the plugin**. It manages per-session AI instances that drive the bot's conversational behavior. Responsibilities include:

- **`AI.ts`** — Session-scoped AI orchestrator. Owns all sub-components (context, tools, memory, images, settings). Exposes `chat()` as the master entry point for generating a reply, guarded by `isChatting` to prevent re-entrant calls (lazy-load guard). `resetState()` clears context timer, decrements bucket, and resets tool call count before each chat. Persists session via `AIManager.saveAI()` both before and after tool-call loops (persist-on-receive pattern). Tracks `_lastCleanupDate` for daily impression/maintenance tasks. The static `AIManager` handles serialization/deserialization of AI instances to/from SealDice storage, plus token usage tracking, and provides `evictAI(id)` / `evictPrivateInstances()` for cache lifecycle management.
- **`context.ts`** — Conversation history management. Maintains the ordered message array (user + assistant + tool messages), enforces round limits, supports context-clearing flags (via `$gCLRMSGS` with role-filter variants: `clearMessages()`, `clearMessages('assistant', 'tool')`, `clearMessages('user')`), and provides cross-session user/group/image lookups. Manages `ignoreList` (UID-based blocking), `autoNameMod` (automatic name update to nickname/card), and `aliases` (UID-to-name registry capped at 10 names per UID with `cleanupStaleAliases()`). Collects **Tier 1 observations** (raw user messages) for the impression system during `addMessage()` — observations hard-capped at `maxObservedMessages * 3` entries.
- **`memory.ts`** — Long-term memory with a **multi-tier memory system**. `Memory` is a single indexed record with text, keywords, user/group associations, weight, decay, **scope** (private/group/universal), **witnesses**, and **importance** level. `MemoryManager` manages the full collection — adding, **POV-filtered search**, **composite scoring** (Jaccard + recency + importance), **LLM re-ranking**, **impression generation/cleanup** (Tier 2), **user observations** (Tier 1), and **memory limit eviction** (via `limitMemory()` using `decay * weight` score ordering). `updateRelatedMemoryWeight()` propagates weight updates across bot, knowledge base, session, and group users. `getRelevantMemories()` supports pre-filtered lists with static `scoreCandidates()` for direct composite scoring. `KnowledgeMemoryManager` extends this for admin-defined knowledge bases. The old short-term memory system (`useShortMemory`/`shortMemoryList`/`updateShortMemory`) and embedding-based scoring (`vector`/`cosineSimilarity`) have been removed.
- **`image.ts`** — Image representation (`Image` class with URL/base64/local type detection, OCR via LLM vision (`imageToText()` with JSON prompt parsing for `text1`/`text2`/`isEmoji`), URL validation/conversion) and `ImageManager` for handling image segments arriving in chat messages (OCR, auto-steal emoji into pool), plus `extractExistingImagesToSave()` for capturing in-text image references into memory.
- **`ImagePool.ts`** — A searchable image library combining admin-defined local images with auto-stolen chat images. Supports text-token matching with Levenshtein fallback, freshness boosting, and paginated listing.

---

## Design Patterns

| Pattern | Where | How |
|---|---|---|
| **Singleton + Cache + Eviction** | `AIManager` | Static `cache: { [id]: AI }` — keyed by user/group session ID. `getAI(id)` loads from storage on cache miss. `evictAI(id)` persists then removes an instance; `evictPrivateInstances()` bulk-evicts all non-group instances. |
| **Strategy** | `Memory.search()` | Five sort methods (`weight`, `score`, `early`, `late`, `recent`) selected via `options.method`. `similarity` (vector-based) removed. |
| **Template Method** | `MemoryManager.buildMemory()` / `KnowledgeMemoryManager.buildKnowledgeMemory()` | Shared search logic, different rendering via configurable templates. |
| **Revival (serialization)** | All classes | Custom `revive()` utility reconstructs class instances from plain JSON after `JSON.parse`. Each class declares `static validKeys` for controlled serialization. |
| **Token Bucket** | `AI.bucket` | Rate-limits AI triggers: refills at `fillInterval`, capped at `bucketLimit`, decrements on each `chat()`. |
| **Lazy-Load Guard** | `AI.isChatting` | Prevents re-entrant `chat()` calls: if `isChatting` is true, subsequent triggers are silently skipped. Set true at entry, false in `finally` block. |
| **Persist-on-Receive** | `AI.chat()` | Calls `AIManager.saveAI(id)` before tool-call interaction (to persist context) and again after reply (to persist new messages). Ensures crash recovery doesn't lose recent state. |
| **Composition** | `AI` class | Holds `Context`, `ToolManager`, `MemoryManager`, `ImageManager`, `ImagePool`, `Setting` as composable sub-objects. |
| **Reinforcement Weighting** | `memory.ts` | Memory weights increase when their keywords appear in user messages, decay otherwise. `updateRelatedMemoryWeight()` propagates weight updates across bot, knowledge base, session, and group users. |
| **Composite Scoring** | `MemoryManager.search()` / `scoreCandidates()` | Three-factor scoring: **Jaccard similarity** of query tokens vs memory keywords (50%), **recency** via exponential half-life decay (30%), and **importance** level mapping (20%). Candidates below 0.1 threshold are filtered. Vector embedding scoring removed. |
| **LLM Re-ranking** | `MemoryManager.llmRerank()` | For >5 candidates, calls an LLM to score each memory's relevance (0-5) against the current query. Combines LLM score (70%) with composite base score (30%) to produce a final ranking. Falls back to base score on error. |
| **POV Filtering** | `MemoryManager.getPOVFilteredMemories()` | Filters memories by scope + session ID. Only returns memories that match the current context (universal memories always included; `private` only matches same session; `group` only matches same group session). Used in `buildMemoryPrompt()` to prevent cross-session memory leakage. |
| **Two-Tier Impression System** | `context.ts` + `memory.ts` | **Tier 1** (`context.addMessage`): silently collects raw user messages into `observations[uid]`. When `maxObservedMessages` threshold reached, triggers **Tier 2** (`MemoryManager.updateImpression`): LLM generates/updates a short (≤80 char) impression per user describing their personality/speech style. `cleanupImpressions()` removes stale entries for left/silent users on daily schedule. |

---

## Data / Control Flow

### Chat Reply Flow (`AI.chat()`)

```
User message arrives
       │
       ▼
AI.chat(reason)
  ├─ isChatting guard → if already chatting, skip silently (lazy-load guard)
  ├─ Token bucket check (skip if tool-callback)
  ├─ AI.resetState() → clear context timer, decrement bucket, reset tool call count
  ├─ Build AIClient from ConfigManager.request settings
  ├─ handleMessages(ctx, ai) → assemble OpenAI-format message array from:
  │     ├─ System prompt (role setting + persona + **impression prompt** + memory prompt)
  │     ├─ Context.messages (history)
  │     └─ MemoryManager.buildMemoryPrompt() (POV-filtered + scored + reranked memories)
  ├─ AIManager.saveAI(id) → persist context state before tool-call loop (persist-on-receive)
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
  └─ context.addMessage() → append to history, update name, check clear-flags
       └─ Tier 1: collect raw message into observations[uid] (triggers Tier 2 impression update at threshold)
```

### Impression System Flow (Two-Tier)

```
Tier 1 — Observation Collection (context.addMessage)
       │
       ▼
if role === 'user':
  ai.memory.observations[uid].rawMessages.push(content)
  ai.memory.observations[uid].msgCount++
  ai.memory.observations[uid].lastSpeak = now
       │
       ▼
if rawMessages.length >= maxObservedMessages:
  → trigger Tier 2

Tier 2 — LLM Impression Generation (MemoryManager.updateImpression)
       │
       ▼
if observations[uid].rawMessages >= 3:
  Build prompt: old impression + recent observations
  Call LLM → parse JSON { impression }
  Store: impressions[uid] = { text, updatedAt }
  Clear rawMessages buffer
```

### Daily Impression Cleanup

```
AI.checkActiveTimer() (called periodically)
       │
       ▼
if today !== _lastCleanupDate:
  _lastCleanupDate = today
  MemoryManager.cleanupImpressions()
    ├─ Fetch current group member list (if network available)
    ├─ For each observed user:
    │     if not in group OR silent > inactiveDays:
    │       delete impressions[uid]
    │       delete observations[uid]
    └─ Log cleaned entries
```

### Memory Search & Retrieval Flow

```
MemoryManager.getRelevantMemories(query, userInfo, groupInfo, topK, preFiltered?)
  │
  ├─ Option A: preFiltered provided
  │     └─ MemoryManager.scoreCandidates(preFiltered, query)
  │         (composite scoring directly on pre-filtered list)
  │
  ├─ Option B: no preFiltered
  │     └─ MemoryManager.search(query, options)
  │         ├─ Composite scoring per memory:
  │         │     ├─ kwJaccard = Jaccard(query_tokens, memory.keywords)
  │         │     ├─ recency = exp(-ln2 * daysSinceCreate / 14)
  │         │     ├─ importanceScore = {1:0.2, 3:0.5, 5:0.8}
  │         │     └─ baseScore = 0.50*kwJaccard + 0.30*recency + 0.20*importanceScore
  │         ├─ Filter: baseScore > 0.1
  │         ├─ Sort by selected strategy (score/weight/early/late/recent)
  │         └─ Return top 20 candidates
  │
  ├─ if topK <= 5 → return candidates.slice(topK) directly (skip LLM rerank)
  │
  └─ LLM Rerank (if candidates > 5)
        ├─ Build prompt with query + candidate texts
        ├─ Call LLM → parse JSON { scores: { id: score } }
        ├─ Combine: finalScore = 0.7*llmScore + 0.3*baseScore
        ├─ Filter: finalScore > 0.2
        ├─ Sort by finalScore
        └─ Return topK

--- POV Filtering (used before scoring in buildMemoryPrompt) ---

MemoryManager.getPOVFilteredMemories(currentScope, currentSessionId)
  ├─ scope === 'universal' → always include
  ├─ scope === currentScope && sessionInfo.id === currentSessionId → include
  ├─ scope === 'private' && sessionInfo.id === currentSessionId → include
  └─ All others → exclude (prevents cross-session leakage)
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
| **Outbound (memory LLM)** | `src/service/legacy` (`fetchData`, `sendITTRequest`) | Image-to-text. Impression generation and memory re-ranking call the LLM directly via `AIClient`. `getEmbedding` (vector embeddings) removed. |
| **Outbound (tools)** | `src/tool/tool.ts` (`ToolManager`) | `ToolCallLoop.run()` uses `ToolManager.getToolsInfo()` and routes function calls back to `toolMap`. |
| **Outbound (reply)** | `src/utils/utils.ts` (`replyToSender`) + `src/utils/utils_string.ts` (`handleReply`) | `AI.reply()` sends messages via SealDice API. |
| **Config** | `src/config/configManager.ts` (`ConfigManager`) | All files read their settings (API keys, limits, templates, flags) from `ConfigManager.*`. |
| **Persistence** | SealDice `ext.storageSet`/`storageGet` | `AIManager.saveAI/getAI` serializes/deserializes each `AI` instance. `KnowledgeMemoryManager` stores knowledge separately. |
| **Timer** | `src/timer/TimerManager` | `AI.checkActiveTimer()` schedules active-time wake-up timers and runs daily impression cleanup (via `_lastCleanupDate` tracking). Timer callbacks invoke `AI.chat()`. |
| **Logger** | `src/logger` | All files use `logger.info/warning/error` for structured logging. |
| **QQ API (OB11)** | `src/utils/utils_ob11.ts` | `context.ts` uses `getFriendList`, `getGroupMemberInfo`, `getStrangerInfo`, `netExists` for user/group lookups. |
