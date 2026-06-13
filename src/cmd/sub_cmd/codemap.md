# Code Map: `src/cmd/sub_cmd/`

## 1. Responsibility

Each file in this directory implements one **subcommand** of the `.ai` command (the SealDice plugin's main command interface). Every subcommand is a self-contained module that registers itself via a `registerCmd<Name>()` function, creating a `SubCmd` instance and attaching it to the global `SubCmd.map` lookup.

The subcommand system acts as a CLI router: the parent `cmd/root.ts` `registerCmd()` function receives all `.ai` invocations, parses the first argument to select a subcommand, builds a `SubCmdContext`, runs privilege checks, and dispatches to the matched `SubCmd.solve()`.

## 2. Design Patterns

- **Command Pattern**: Each subcommand is a `SubCmd` object with a `name`, `desc`, `help`, `priv` (permissions), and `solve` handler — the command pattern in its purest form.
- **Registry Pattern**: `SubCmd` constructor automatically adds itself to `SubCmd.map` (static dictionary). The root `registerCmd()` iterates all imported registration functions to populate the map.
- **Nested Permission Tree**: Each subcommand defines a hierarchical permission structure via `CmdPrivInfo`. The `PrivilegeManager.checkPriv()` walks the command argument chain against this tree, allowing fine-grained access control at each subcommand level.
- **Strategy / Plug-in**: Each file is independent and can be added/removed without changing others. Integration happens purely through the registry in `root.ts`.
- **Alias Resolution**: The `aliasToCmd()` utility normalizes user input (abbreviations, synonyms) to canonical command names before dispatch.

## 3. Key Subcommands and Their Purposes

| Subcommand | File | Permission | Purpose |
|---|---|---|---|
| **on** | `on.ts` | S | Enable AI with trigger modes (counter, timer, probability, active time window). Accepts kwargs like `--c=10`, `--t=60`, `--p=42`, `--a=09:00-18:00-5`. |
| **off** | `off.ts` | I | Disable AI entirely or selectively turn off specific trigger modes via kwargs. Resets all trigger counters. |
| **standby** | `standby.ts` | I | Enable standby mode — AI records conversation passively without replying. |
| **status** | `status.ts` | U | Display current AI state: privilege level, context rounds, trigger mode statuses, active time window, standby mode. |
| **forget** | `forget.ts` | I (root) | Clear conversation context. Sub-options: `assistant` (clear AI/tool messages), `user` (clear user messages), default clears all. |
| **memory** | `memory.ts` | U (root) | Manage long-term (`private`/`group`) and short-term memory. CRUD operations: set/delete/list/clear. Also supports persona settings and `sum` (force summarization into short-term memory). |
| **image** | `image.ts` | U (root) | Image pool operations: list stolen/local images, clear stolen pool, image-to-text (`itt`), find image by ID. |
| **ctxn** | `ctxn.ts` | U (root) | Context name management: view names, set to nickname/card, enable auto-name-modification (0/1/2). |
| **tool** | `tool.ts` | U (root) | Tool function management: list all tools with on/off status, toggle individual tools, view tool help/params, manually call a tool function via `call`. |
| **token** | `token.ts` | S (root) | Token usage tracking: list models, view per-model/per-period usage, year/month charts (image generation), clear usage records. |
| **timer** | `timer.ts` | U (root) | Timer management: list active timers, clear all timers for the current session. |
| **privilege** | `privilege.ts` | M (root) | Permission management: set/check session permissions, set/show/reset command-level permissions. |
| **role** | `role.ts` | I | Switch between role/system prompt presets (defined in config). |
| **prompt** | `prompt.ts` | M | Debug command — prints the assembled system prompt sent to the AI. |
| **ignore** | `ignore.ts` | U | Ignore list management (group-only): add/remove/list users who can converse but cannot be targeted by `@`. |
| **shut** | `shut.ts` | U | Placeholder for interrupting streaming output (not yet supported — shows a notice). |
| **sample** | `sample.ts` | U | Empty skeleton subcommand — no-op, exists as a template for future commands. |

**Permission levels (highest to lowest):** `M` (master) > `I` (inviter) > `S` (special: session-level check) > `U` (user).

## 4. Integration Points

- **`cmd/root.ts` — `SubCmd.map`**: Every subcommand must be imported and called in `SubCmd.register()`. Add a new subcommand by: (a) creating a file with `registerCmdXxx()` exporting a `SubCmd`, (b) importing it in `root.ts`, (c) adding its call to `SubCmd.register()`.
- **`cmd/privilege.ts` — `PrivilegeManager`**: Each subcommand's permission tree is registered as part of `defaultCmdPriv` in `SubCmd.register()`. The `PrivilegeManager` performs walk-based checking at runtime.
- **`AI/AI.ts` — `AIManager.getAI(sid)`**: Subcommands receive the session-scoped `AI` instance via `SubCmdContext`, which provides access to context, memory, tool status, image pool, settings, etc.
- **`TimerManager`** (`timer.ts`): Used by `on.ts`, `off.ts`, `standby.ts`, `timer.ts` for managing active-time and auto-reply timers.
- **`ConfigManager`**: Used by `memory.ts` (memory feature flags), `tool.ts` (tool deny-list), `role.ts` (role setting names/templates).
- **`ToolManager`** (`tool/tool.ts`): Used by `tool.ts` for listing, inspecting, and calling tool functions.
- **`ImageManager`** (`AI/image.ts`): Used by `image.ts` for local image operations.
- **`utils/utils.ts` — `aliasToCmd()`**: Central normalization function used by nearly all subcommands for matching user input to canonical command names.
