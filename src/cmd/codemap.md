# src/cmd/ — AI Plugin Chat Commands

## Responsibility

The command layer of the AI骰娘4 plugin. It registers and handles all `.ai` prefixed chat commands (e.g., `.ai on`, `.ai status`, `.ai img`, `.ai memo`). This is the primary user-facing interface — every interaction a user has with the AI (beyond raw passive chat) goes through this module.

The single registered SealDice command is `.ai`. All sub-commands are dispatched internally via the `SubCmd` registry.

## Files

| File | Purpose |
|------|---------|
| `root.ts` | Defines `SubCmd` base class + `SubCmdContext` interface; registers the `.ai` SealDice command; orchestrates sub-command discovery and dispatch |
| `privilege.ts` | Declares `CmdPrivInfo` tree structure; implements `PrivilegeManager` for cascading session/user permission checks |
| `sub_cmd/on.ts` | `.ai on [--c=10] [--t=60] [--p=10] [--a=09:00-18:00-5]` — Activate AI with counter/timer/probability/active-time triggers |
| `sub_cmd/off.ts` | `.ai off [--c] [--t] [--p] [--a]` — Deactivate AI or disable individual trigger modes |
| `sub_cmd/status.ts` | `.ai status` — Show current AI settings (priv, context length, counter/timer/prob values, active time, standby) |
| `sub_cmd/standby.ts` | `.ai standby` — Enter passive recording mode (logs chat but does not auto-respond) |
| `sub_cmd/forget.ts` | `.ai forget [assistant|user]` — Clear conversation context (all, assistant-only, or user-only) |
| `sub_cmd/ctxn.ts` | `.ai ctxn [status|set|mod]` — Manage how user names appear in context (nickname/card/none) |
| `sub_cmd/memory.ts` | `.ai memory [p/g/short] [set|del|list|clear]` — Long-term and short-term memory CRUD |
| `sub_cmd/token.ts` | `.ai token [list|sum|all|year|month|clear] [model] [chart]` — Token usage tracking and statistics |
| `sub_cmd/tool.ts` | `.ai tool [on|off|help|call] [name] [--params]` — Enable/disable/list/invoke tool functions |
| `sub_cmd/image.ts` | `.ai image [list|steal|itt|find]` — Image pool management, image-to-text, image lookup |
| `sub_cmd/timer.ts` | `.ai timer [list|clear]` — View/clear per-session timers |
| `sub_cmd/role.ts` | `.ai role <name>` — Switch character/persona preset |
| `sub_cmd/prompt.ts` | `.ai prompt` — View current system prompt (master only) |
| `sub_cmd/privilege.ts` | `.ai privilege [session|set|show|reset]` — Manage session-level and command-level permissions |
| `sub_cmd/ignore.ts` | `.ai ignore [add|remove|list] [@user]` — Manage per-session user ignore list (group only) |
| `sub_cmd/shut.ts` | `.ai shut` — Interrupt current AI response (stub — not implemented, no streaming support) |
| `sub_cmd/sample.ts` | Stub template — no-op placeholder for future sub-commands |

## Design Patterns

### 1. Registry Pattern (`SubCmd` base class)
- `SubCmd` constructor writes `this` into `SubCmd.map[name]`, providing self-registration.
- `SubCmd.register()` calls each `registerCmd*()` factory function, which instantiates `new SubCmd(name)` → auto-registers.
- The `.ai` command's `solve` handler looks up the sub-command from `SubCmd.map` by alias.

### 2. Factory Functions (per `sub_cmd/*.ts`)
Each file exports a **`registerCmd*()`** function that:
1. Creates a `new SubCmd('name')` instance
2. Sets `.desc`, `.help`, `.priv` (permission tree)
3. Assigns the `.solve` handler

### 3. Switch-Based Dispatch
Sub-commands with further nesting (tool, memory, token, image, privilege, ignore, ctxn) use `switch (aliasToCmd(valN))` to route to the right operation. The `aliasToCmd()` utility normalises aliases (e.g., `lst` → `list`, `stl` → `steal`).

### 4. Cascading Privilege System (`privilege.ts`)
Permissions form a tree (`CmdPrivInfo` with optional nested `args`). `PrivilegeManager.checkPriv()` walks the command chain:
1. Checks **session privilege** (0/1) against the AI's setting
2. Checks **user privilege** (user/master/inviter) against SealDice's `ctx.privilegeLevel`
3. Falls through to a force-trigger level if session-level check fails
4. Wildcard `*` entries allow catch-all permission rules

Three-number privilege tuples: `[sessionReq, userReq, forceTriggerUserReq]`

### 5. Shared Context (`SubCmdContext`)
All sub-command handlers receive a standardised `SubCmdContext` object with parsed fields (`sid`, `uid`, `gid`, `epId`, `page`, `ai`, `ret`, etc.), reducing boilerplate.

## Integration Points

| Point | What connects |
|-------|---------------|
| `ConfigManager.ext.cmdMap` | `.ai` command registered at startup via `ConfigManager.ext.cmdMap['AI']` and `cmdMap['ai']` |
| `AIManager.getAI(sid)` | Every command retrieves the AI instance for the current session (user/group) |
| `AIManager.saveAI(sid)` | Stateful commands persist AI settings, memory, tool status, ignore list |
| `PrivilegeManager` | Permission checks against `defaultCmdPriv` (loaded from SealDice storage) |
| `TimerManager` | `.ai on --active`, `.ai standby`, `.ai off`, `.ai timer` — manages per-session timers |
| `ToolManager` | `.ai tool on/off/call/help` — accesses registered tool functions |
| `ImageManager` / `ImagePool` | `.ai image` — manages stolen and local image pools |
| `buildSystemMessage()` | `.ai prompt` — used to render the current system prompt |
| `getRoleSetting()` | `.ai role` — retrieves available character templates |
| `get_chart_url()` | `.ai token year chart` / `.ai token month chart` — generates token usage charts |

## Flow

```
User: .ai on --c=10
  ↓
SealDice: cmd.solve(ctx, msg, cmdArgs)
  ↓
root.ts: parse args → extract sid, page, validate
  ↓
root.ts: PrivilegeManager.checkPriv() → session+user permission gate
  ↓
root.ts: SubCmd.map['on'].solve(scc)
  ↓
sub_cmd/on.ts: parse kwargs, set ai.setting.{counter,timer,prob,activeTimeInfo}
  ↓
AIManager.saveAI(sid) → persist to SealDice storage
  ↓
seal.replyToSender() → respond to chat
```

## Command Permissions Summary

| Level | Constant | Meaning |
|-------|----------|---------|
| `U` | user | Any user in the session |
| `I` | inviter | Group inviter / trusted user |
| `M` | master | Bot master (highest) |
| `S` | special | Needs session priv ≥1 → inviter; else master force-trigger |
