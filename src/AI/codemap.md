# src/AI/ — Core AI Chat, Context, Memory & Image Management

---

## Responsibility

This directory is the **brain of the plugin**. It manages per-session AI instances that drive the bot's conversational behavior. Responsibilities include:

- **`AI.ts`** — Session-scoped AI orchestrator. Owns all sub-components (context, tools, memory, images, settings). Exposes `chat()` as the master entry point for generating a reply, guarded by `isChatting` to prevent re-entrant calls (lazy-load guard). `resetState()` clears context timer, decrements bucket, and resets tool call count before each chat. Persists session via `AIManager.saveAI()` both before and after tool-call loops (persist-on-receive pattern). Tracks `_lastCleanupDate` for the daily maintenance block (impression cleanup + fire-and-forget memory tidy via `memory.tidyMemories()`, which saves the session on success — never blocks the message mainline). Manages a **task reminder queue** (`pendingReminders: { ctx, msg }[]`): `enqueueReminder(ctx, msg)` appends a reminder and triggers processing; `processNextReminder()` dequeues and calls `chat('任务提醒')` (exempt from bucket limits). The `chat()` finally block calls `processNextReminder()` after setting `isChatting = false`, ensuring queued reminders fire only after the current conversation finishes. The static `AIManager` handles serialization/deserialization of AI instances to/from SealDice storage, plus token usage tracking, and provides `evictAI(id)` / `evictPrivateInstances()` for cache lifecycle management.
- **`context.ts`** — Conversation history management (~620 lines). Maintains the ordered message array (user + assistant + tool messages), enforces round limits, supports context-clearing flags (via `$gCLRMSGS` with role-filter variants: `clearMessages()`, `clearMessages('assistant', 'tool')`, `clearMessages('user')`), and provides cross-session user/group/image lookups. Manages `ignoreList` (UID-based blocking), `autoNameMod` (automatic name update to nickname/card), and `aliases` (UID-to-name registry capped at 10 names per UID with `cleanupStaleAliases()`). Alias registration is centralized in **`registerAlias(uid, name)`** (8 个调用点: `addMessage`/`setName` 注册 + `findUserInfo` 群成员/好友命中回填) — it dedupes via **`normalizeName()`** (imported from `../utils/utils`; toLowerCase + 全角→半角 + 去零宽/变体选择符 + 去 emoji/空白), so fullwidth/halfwidth and case variants never duplicate table entries; a normalized-equivalent hit only refreshes `lastUsed` on the existing name instead of pushing a new one, while the 10-entry cap keeps the oldest-eviction policy. `findUserInfo()` rewritten for **归一化匹配**: entry trims and strips `<名字>`/`名字(123)` brackets *before* the pure-digit branch (`/^\d+$/`, length 5-11, using the raw name so fullwidth digits can't be misjudged), hoists `nn = normalizeName(name)`, compares alias table / player / context / group members / friends via `normalizeName()` and returns the **original stored name**; pure-emoji/symbol nicknames that normalize to empty fall back to **raw exact matching** (aliases → player → bot name → context → group members/friends) to avoid empty-string cross-equal mismatches; matched members/friends are backfilled via `registerAlias()`. `findGroupInfo()` got the same-shape refactor (trim + bracket-strip before pure-digit `/^\d+$/` length >5; normalized matching; group-list hit returns `group.group_name`). Collects **Tier 1 observations** (raw user messages) for the impression system during `addMessage()` — observations hard-capped at `maxObservedMessages * 3` entries (oldest dropped). Triggers **Tier 2** impression updates **fire-and-forget**: snapshot batch is passed to `updateImpression()` and an `impressionInFlight` Set guards against re-entry, so the LLM call never blocks the message mainline. **Y9 no-data-loss retry**: on failure the observation batch is retained (never shifted away) and a 5-minute cooldown (`impressionFailAt`) is set before retrying the whole batch (cooldown only set when ≥3 messages remain); success clears the cooldown.
- **`memory.ts`** — Long-term memory with a **multi-tier memory system**. `Memory` is a single indexed record with text, keywords, user/group associations, weight, decay, **scope** (private/group/universal), and **importance** level. `MemoryManager` manages the full collection — adding, **POV-filtered search**, **composite scoring**, **LLM re-ranking**, **impression generation/cleanup** (Tier 2), **user observations** (Tier 1), and **memory limit eviction** (via `limitMemory()` using `decay * weight` score ordering, capacity floored at `Math.max(1, memoryLimit - 1)` so `memoryLimit = 1` still keeps the top-scored memory). Search & scoring share module-level utilities: `tokenizeForScore()` (punctuation/whitespace split + Chinese bigram), `jaccardSimilarity()`, and `calcBaseScore()` (four-factor: kwScore 45% + recency 25% + importance 20% + userMatch 10%) — plus `djb2Hash()` (32-bit unsigned djb2 content hash, toString(36)) shared by knowledge parse-caching and stable kb ids. `search()` is user-list aware — soft user-match bonus, optional `hardUserFilter` (explicitly-named-user tool paths), keyword soft-merge into the unified query token set, and a P1 injection gate (method `score` + non-empty query + kwScore 0 → dropped); the `weight` and time-based (`early`/`late`/`recent`) sorts skip the `_baseScore > 0.1` cutoff so weight/relevance ordering isn't truncated. `addMemory()` dedupes by same scope + body Jaccard ≥ 0.7, merging keywords / refreshing `lastMentionTime` / bumping weight instead of duplicating. `reviveMemoryMap()` migrates scope-less legacy data by inferring scope from `sessionInfo.isPrivate` (data preserved, `_needsSave` set). `deleteMemory()` returns the actual deleted count; its keyword branch matches by pure substring (`kw.length >= 2` guard, memory keyword or text contains the keyword). `mergeMemories()` merges multiple memories into one (base = first memory; userList/groupList dedup by id; createTime min / lastMentionTime max / weight min(10, max); deletes the rest), and module-level `generateMergeText()` (llmRerank-style AIClient + `fixJsonString` parse) LLM-generates merged text/keywords (keep all facts, length ≤ original sum, unmergeable → first original, empty/failure → null) — both shared with the `merge_memory` tool. `tidyMemories()` (daily-once maintenance, fire-and-forget from `checkActiveTimer`) LLM-classifies obsolete memories (≤5, text snapshot taken before delete) and duplicate pairs (≤2, deduped → `generateMergeText` → `mergeMemories`); gated by persisted `_lastTidyDate` (added to validKeys) with the latch set only after the quantity guards pass (guard early-returns don't consume the daily quota; `force=true` skips guards). `updateMemoryWeight()` boosts weight when a keyword is a substring of or tokenized-within the message (`kw.length >= 2` guard, `s.includes(kw)` / `sTokens.includes(kw)`), decays otherwise — new memories get a 1-day protection period (no decay within 86400s of creation); on knowledge-base instances it additionally sets a `_weightsDirty` flag (via an `instanceof KnowledgeMemoryManager` guard, so session AIs are unaffected). `updateRelatedMemoryWeight()` propagates these updates across bot, knowledge base, session, and **cached** group users (P5: `AIManager.cache[ui.id]` guard — only already-cached instances are updated, avoiding create-on-read zombie AI instances). `getRelevantMemories()` supports pre-filtered lists with static `scoreCandidates()` (optional `ui` param for userMatch soft bonus). `KnowledgeMemoryManager` extends this for admin-defined knowledge bases — user/group entries parsed as `name=segs[0]` with `QQ:`/`QQ-Group:` id prefixes, ID-less entries given stable `'kb'+djb2Hash(text)` ids. **Y5 parse-cache**: `updateKnowledgeMemory()` hashes `roleIndex + '\n' + text` via `djb2Hash()` and skips the full re-parse + save when unchanged — a dirty `_weightsDirty` flag (set by `updateMemoryWeight` on knowledge-base instances) still forces the save so weight drift persists. The old short-term memory system (`useShortMemory`/`shortMemoryList`/`updateShortMemory`) and embedding-based scoring (`vector`/`cosineSimilarity`) have been removed.
- **`image.ts`** — Image representation (`Image` class with URL/base64/local type detection, OCR via LLM vision (`imageToText()` with JSON prompt parsing for `text1`/`text2`/`isEmoji`), URL validation/conversion) and `ImageManager` for handling image segments arriving in chat messages (OCR, auto-steal emoji into pool), plus `extractExistingImagesToSave()` for capturing in-text image references into memory.
- **`ImagePool.ts`** — A searchable image library combining admin-defined local images with auto-stolen chat images. Supports text-token matching with Levenshtein fallback, freshness boosting, and paginated listing.

---

## Design Patterns

| Pattern | Where | How |
|---|---|---|
| **Singleton + Cache + Eviction** | `AIManager` | Static `cache: { [id]: AI }` — keyed by user/group session ID. `getAI(id)` loads from storage on cache miss. `evictAI(id)` persists then removes an instance; `evictPrivateInstances()` bulk-evicts all non-group instances. |
| **Strategy** | `Memory.search()` | Five sort methods (`weight`, `score`, `early`, `late`, `recent`) selected via `options.method`. The `weight` and time-based methods (`early`/`late`/`recent`) skip the `_baseScore > 0.1` filter so weight-ordered and old-but-relevant memories still surface. `similarity` (vector-based) removed. |
| **Template Method** | `MemoryManager.buildMemory()` / `KnowledgeMemoryManager.buildKnowledgeMemory()` | Shared search logic, different rendering via configurable templates. |
| **Revival (serialization)** | All classes | Custom `revive()` utility reconstructs class instances from plain JSON after `JSON.parse`. Each class declares `static validKeys` for controlled serialization. |
| **Token Bucket** | `AI.bucket` | Rate-limits AI triggers: refills at `fillInterval`, capped at `bucketLimit`, decrements on each `chat()`. |
| **Lazy-Load Guard** | `AI.isChatting` | Prevents re-entrant `chat()` calls: if `isChatting` is true, subsequent triggers are silently skipped. Set true at entry, false in `finally` block. |
| **Persist-on-Receive** | `AI.chat()` | Calls `AIManager.saveAI(id)` before tool-call interaction (to persist context) and again after reply (to persist new messages). Ensures crash recovery doesn't lose recent state. |
| **Composition** | `AI` class | Holds `Context`, `ToolManager`, `MemoryManager`, `ImageManager`, `ImagePool`, `Setting` as composable sub-objects. |
| **Reinforcement Weighting** | `memory.ts` | Memory weights increase when their keywords appear in user messages, decay otherwise. `updateRelatedMemoryWeight()` propagates weight updates across bot, knowledge base, session, and **cached** group users (P5: `AIManager.cache[ui.id]` guard prevents create-on-read zombie AI instances). |
| **Similarity Dedup** | `MemoryManager.addMemory()` | New memory matching an existing one in the same scope with body Jaccard (`tokenizeForScore`) ≥ 0.7 merges instead of duplicating: keywords unioned, `lastMentionTime` refreshed, `weight` +1 (cap 10). |
| **Composite Scoring** | `MemoryManager.search()` / `scoreCandidates()` | Four-factor scoring via shared `calcBaseScore()`: **kwScore** (45%) = max(Jaccard(qTokens, memory.keywords), Jaccard(qTokens, memory.text)) where qTokens = unified tokenization of query ∪ keywords, **recency** (25%) via exponential half-life decay, **importance** (20%) level mapping, **userMatch** (10%) soft bonus from common users. Tokenized once with shared `tokenizeForScore()` (punctuation/whitespace split + Chinese bigram). Candidates below 0.1 threshold are filtered (skipped for weight/time-based sorts). Vector embedding scoring removed. |
| **LLM Re-ranking** | `MemoryManager.llmRerank()` | For >5 candidates, calls an LLM to score each memory's relevance (0-5) against the current query. Combines LLM score (70%) with composite base score (30%) to produce a final ranking. Candidates the LLM omits fall back to `_baseScore` as their LLM score (no longer systematically eliminated when the LLM returns ordinal indices or skips ids); if the filtered result is empty it returns the original topK (candidates are already base-score descending); on error falls back to base score. |
| **POV Filtering** | `MemoryManager.getPOVFilteredMemories()` | Filters memories by scope + session ID. Only returns memories that match the current context (universal always included — B4 pre-reserved branch: no current writer since `addMemory()` only produces private/group, so the bot memory block is always empty; `private` only matches same session; `group` only matches same group session). Used in `buildMemoryPrompt()` to prevent cross-session memory leakage. |
| **Two-Tier Impression System** | `context.ts` + `memory.ts` | **Tier 1** (`context.addMessage`): silently collects raw user messages into `observations[uid]`. When `maxObservedMessages` threshold reached (or the impression is stale per `impressionMaxAge`), triggers **Tier 2** fire-and-forget: `updateImpression(uid, snapshot)` runs an LLM to generate/update a short (≤80 char) impression per user describing their personality/speech style. `impressionInFlight` Set prevents re-entry while a call is in-flight; on success the consumed snapshot batch is removed (messages arriving during the LLM call are kept for the next batch); on failure the batch is **kept** (no data loss) and a 5-minute cooldown (`impressionFailAt`) is set before retrying the whole batch (cooldown only set when ≥3 messages remain), success clears it. `cleanupImpressions()` removes stale entries for left/silent users on daily schedule. |
| **Daily Memory Tidy (F3)** | `MemoryManager.tidyMemories()` | Daily-once scheduled LLM maintenance (fire-and-forget from `checkActiveTimer`): auto path requires ≥10 memories and (≥20 or any memory with createTime/lastMentionTime older than 30 days); LLM returns `{obsolete, duplicates}`; obsolete (≤5) snapshot-then-deleted, duplicate pairs (≤2, Set-deduped) merged via `generateMergeText`/`mergeMemories`. Persisted `_lastTidyDate` latch (validKeys) is set only after guards pass so early returns don't burn the daily quota; `force=true` (`.ai memo tidy`) skips the quantity guards. |
| **Reminder Queue** | `AI.ts` | `pendingReminders: { ctx, msg }[]` — reminders are enqueued via `enqueueReminder()` and processed one-at-a-time by `processNextReminder()` after the current `chat()` finishes (called from the `finally` block). The reminder invocation (`chat('任务提醒')`) bypasses the token bucket via an explicit exemption. This ensures task reminders never interrupt active conversations. |

---

## Data / Control Flow

### Chat Reply Flow (`AI.chat()`)

```
User message arrives
       │
       ▼
AI.chat(reason)
  ├─ isChatting guard → if already chatting, skip silently (lazy-load guard)
  ├─ Token bucket check (skip if tool-callback OR reason === '任务提醒')
  ├─ AI.resetState() → clear context timer, decrement bucket, reset tool call count
  ├─ Build AIClient from ConfigManager.request settings
  ├─ handleMessages(ctx, ai) → assemble OpenAI-format message array from:
  │     ├─ System prompt (role setting + knowledge + **impression prompt** + memory prompt)
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
  ├─ AIManager.saveAI(id) → persist session to SealDice storage
  │
  └─ [finally block] isChatting = false
       └─ processNextReminder() → if queue non-empty, dequeue next
            └─ chat('任务提醒') → recurses (exempt from bucket check)
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
  ai.memory.observations[uid].lastSpeak = now
  (rawMessages hard-capped at maxObservedMessages * 3, oldest dropped)
       │
       ▼
if (needUpdate || impressionStale) && !impressionInFlight.has(uid) && now >= (obs.impressionFailAt || 0):
  → fire-and-forget Tier 2, non-blocking  (Y9: failure cooldown suppresses re-trigger during backoff)

Tier 2 — LLM Impression Generation (MemoryManager.updateImpression)
       │
       ▼
impressionInFlight.add(uid); batch = obs.rawMessages.slice()  (snapshot)
updateImpression(uid, batch) → if msgs.length >= 3:
  Build prompt: old impression + recent observations (snapshot batch)
  Call LLM → parse JSON { impression }
  Store: impressions[uid] = { text, updatedAt }
  Return success/failure
  ├─ success → obs.rawMessages.splice(0, batch.length); obs.impressionFailAt = 0  (new msgs kept, cooldown cleared)
  └─ failure → no data loss: if rawMessages.length >= 3 set obs.impressionFailAt = now + 300  (5-min cooldown, whole batch retried)
finally: impressionInFlight.delete(uid)
```

### Daily Maintenance (via `AI.checkActiveTimer()`)

```
AI.checkActiveTimer() (called periodically)
       │
       ▼
if !ctx.isPrivate && today !== _lastCleanupDate:  (private sessions don't consume the daily latch)
  _lastCleanupDate = today
  MemoryManager.cleanupImpressions()
    ├─ Fetch current group member list (if network available)
    ├─ For each observed user:
    │     if not in group OR silent > inactiveDays:
    │       delete impressions[uid]
    │       delete observations[uid]
    └─ Log cleaned entries
  context.cleanupStaleAliases()
  └─ (fire-and-forget) memory.tidyMemories() → if result===1: AIManager.saveAI(this.id)
       ├─ returns 0 if _lastTidyDate === today (or auto-path guards unmet — latch only set after guards pass)
       ├─ obsolete (≤5): snapshot texts → deleteMemory → log
       └─ duplicates (≤2 groups): dedupe pair → generateMergeText → mergeMemories (null → skip group)
```

### Memory Search & Retrieval Flow

```
MemoryManager.getRelevantMemories(query, userInfo, groupInfo, topK, preFiltered?)
  │
  ├─ Option A: preFiltered provided
  │     └─ MemoryManager.scoreCandidates(preFiltered, query, ui)
  │         (composite scoring directly on pre-filtered list; ui enables userMatch soft bonus)
  │
  ├─ Option B: no preFiltered
  │     └─ MemoryManager.search(query, options)
  │         ├─ Tokenize once: qTokens = query ∪ keywords (unified tokenizeForScore)
  │         ├─ Composite scoring per memory (shared calcBaseScore):
  │         │     ├─ kwScore = max(Jaccard(qTokens, memory.keywords), Jaccard(qTokens, memory.text))
  │         │     ├─ recency = exp(-ln2 * daysSinceCreate / 14)
  │         │     ├─ importanceScore = {1:0.2, 3:0.5, 5:0.8}
  │         │     ├─ userMatch = 1 if common user with userList else 0 (soft bonus)
  │         │     └─ baseScore = 0.45*kwScore + 0.25*recency + 0.20*importanceScore + 0.10*userMatch
  │         ├─ P1 injection gate: method='score' && query non-empty && kwScore===0 → drop (no word overlap = don't inject)
  │         ├─ hardUserFilter: no common user with userList → drop (explicitly-named-user tool paths)
  │         ├─ Filter: baseScore > 0.1 (skipped for weight/time methods early/late/recent)
  │         ├─ Sort by selected strategy (score/weight/early/late/recent)
  │         └─ Return top 20 candidates
  │
  ├─ if topK <= 5 → return candidates.slice(topK) directly (skip LLM rerank)
  │
  └─ LLM Rerank (if candidates > 5)
        ├─ Build prompt with query + candidate texts
        ├─ Call LLM → parse JSON { scores: { id: score } }
        ├─ Combine: finalScore = 0.7*llmScore + 0.3*baseScore
        │     └─ Missing id score → llmScore falls back to _baseScore
        ├─ Filter: finalScore > 0.2
        ├─ Sort by finalScore
        ├─ Empty filtered result → fall back to candidates.slice(topK) (already base-desc)
        └─ Error → return candidates.slice(topK) (base-score fallback)

--- POV Filtering (used before scoring in buildMemoryPrompt) ---

MemoryManager.getPOVFilteredMemories(currentScope, currentSessionId)
  ├─ scope === 'universal' → always include  (B4 预留分支：当前无写入方，addMemory 只产生 private/group，bot 记忆块恒空)
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
| **Timer** | `src/timer/TimerManager` | `AI.checkActiveTimer()` schedules active-time wake-up timers and runs the daily maintenance block (impression cleanup + fire-and-forget memory tidy, via `_lastCleanupDate` tracking). Timer callbacks invoke `AI.chat()`. |
| **Logger** | `src/logger` | All files use `logger.info/warning/error` for structured logging. |
| **QQ API (OB11)** | `src/utils/utils_ob11.ts` | `context.ts` uses `getFriendList`, `getGroupMemberInfo`, `getStrangerInfo`, `netExists` for user/group lookups. |
