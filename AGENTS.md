# AGENTS.md — aipluginmin

## What this is

A SealDice JS plugin (dicemin) that makes the dice bot converse like a human. Runs inside the SealDice host runtime. Its public bundle is `aipluginmin.js`; the internal `aiplugin4` SealDice configuration namespace is retained for compatibility.

## Build

```bash
npm run build       # production → dist/aipluginmin.js
npm run build-dev   # dev (sourcemaps, ES2020) → dev/aipluginmin.js
```

- Bundler: **esbuild** (not tsc). `tsconfig.json` is only for eslint type-checking + esbuild config reference.
- esbuild prepends `header.txt` (UserScript metadata) to the output.
- Build marks `csharp` and `puerts` as external — these exist in the SealDice host runtime.

### Before every build

1. **Backup old dist file** — `tools/build.js` auto-copies the configured output to `dist-backups/{artifact}-v{old-version}.js` before overwriting.
2. The backup is automatic; `dist-backups/` can be gitignored.

## Version bumping

**Every commit that modifies `src/` must bump the patch version (X.Y.Z → X.Y.Z+1).** Version lives in two places:

- `src/config/config.ts` → `VERSION` constant
- `header.txt` → `@version` field

Bump both before committing. Do not bump for docs-only or AGENTS.md-only changes.

**⚠️ Use the `edit` tool to bump versions. Never use PowerShell `Set-Content` or `(Get-Content).replace()` — they destroy UTF-8 encoding of Chinese characters.** `header.txt` and `config.ts` contain Chinese text that will garble irreversibly with PowerShell pipes.

## Workflow for changes

**Non-trivial changes must follow: spec → design → plan → implement.** Do not jump directly to code edits for features, refactors, or structural changes.

1. **Grill / Spec** — use `grill-me` to stress-test the idea, or `to-spec` to synthesize conversation into a published spec
2. **Design doc** — write to `docs/specs/YYYY-MM-DD-<topic>-design.md`
3. **Implementation plan** — use `to-tickets` to break the design into tracer-bullet tickets with explicit dependencies
4. **Implement** — use `implement` skill to drive `tdd` at seams, close with `code-review`

Exceptions: trivial bugfixes (<10 lines, single file), config default changes, log line additions, version bumps themselves.

### Preferred troubleshooting / implementation workflow

For debugging, investigation, and non-trivial fixes, the preferred pattern is:

1. **Research** — dispatch `@explorer` for codebase search, `@librarian` for external/library docs. Run in parallel when independent.
2. **Analyze & Plan** — present findings; write implementation plan with exact file paths, code changes, and impact analysis.
3. **Independent review** — dispatch `@oracle` to review the plan for bugs, omissions, side effects, and simplification opportunities. Update plan based on findings.
4. **Implement** — dispatch `@fixer` with the full plan and precise instructions. Single responsible fixer per plan.
5. **Implementation review** — dispatch `@oracle` to review the actual diff against the plan (correctness, side effects, omissions) before commit. Mandatory for non-trivial fixes.
6. **Verify & Commit** — run `npm run build`, commit with descriptive message.
7. **Update codemap** — load the `codemap` skill, run change detection, dispatch fixers to update affected `codemap.md` files, run `update` to save state, commit.
8. **Reconcile** — check all background tasks completed; reconcile any file conflicts from parallel agents.

Example of this flow in practice: vector dead code cleanup → Jina EOF debugging → timezone fix. Each followed: research (subagent) → write plan → oracle review → implement (fixer) → commit + codemap update.

### Long-term fix tracking workflow

When a code review or investigation surfaces **multiple bugs/issues** (5+), do not try to fix them all at once. Instead:

1. **Create tracking document** — write to `docs/plans/YYYY-MM-DD-<topic>-fixes-plan.md` with this structure:

   - **Main task table**: task ID, name, affected file(s), severity (🔴/🟠/🟡/🔵), overall progress (⬜/🔄/✅)
   - **Per-task sub-task tables**: sub-task ID, description, file:line, progress, notes
   - Tasks grouped by severity: 🔴 Critical (security/crash/logic) > 🟠 Medium (data integrity) > 🟡 Low (code quality/tech debt) > 🔵 Info (architecture/cleanup)

2. **Prioritize** — fix in severity order. Critical bugs first, code quality last.

3. **Fix one task at a time** — per the preferred troubleshooting workflow. **Every fix plan MUST go through independent oracle review before implementation.** No exceptions, including trivial-looking one-liners:

   a. **Research** — dispatch `@explorer` / `@librarian` as needed
   b. **Write fix plan** — exact file paths, line numbers, code changes, and impact analysis
   c. **Oracle review** — dispatch `@oracle` to review the plan for bugs, omissions, side effects, and simplification opportunities. **Mandatory.** Update plan based on findings.
   d. **Implement** — dispatch `@fixer` with the reviewed plan
   e. **Implementation review** — dispatch `@oracle` to review the implementation diff against the plan before commit. **Mandatory.**
   f. **Verify** — `npm run build`
    g. **Commit + Codemap** — record commit hash in tracking document, then update codemap files (load `codemap` skill, detect changes, dispatch fixers, save state, commit).

4. **Update tracking document** — after each commit, update the progress markers:
   - `⬜` → `🔄` when work begins
   - `🔄` → `✅` when commit lands
   - Record the commit hash in the sub-task notes

5. **Version bump** — every commit that modifies `src/` bumps the patch version.

6. **Do not close** the tracking document until all 🔴 and 🟠 items are resolved. 🟡 and 🔵 items may be deferred to future iterations.
7. **Cleanup** — when the plan is fully executed (all tasks ✅ or explicitly deferred), delete or archive the tracking document (`docs/plans/`). Do not leave executed plans behind.

## SealDice API

- **`types/seal.d.ts`** declares the SealDice runtime types (provided globally, no import needed). The file is **incomplete**.
- Before researching external SealDice behavior, ensure the reference checkout exists at `..\Reference\sealdice-core`; if it is absent, clone `https://github.com/sealdice/sealdice-core` there. Keep future reference projects under the sibling `..\Reference\` directory rather than embedding machine-specific paths in project instructions.
- **`..\Reference\sealdice-core`** is the local SealDice core source (Go source; JS extension bindings in `dice/dice_jsvm.go`) and is the authoritative source for runtime semantics (e.g. `seal.vars` variable scopes like `$g`=group scope). Use its checked-out documentation/source when available; otherwise use the online manual below.
- For API signatures, check the online manual: `https://docs.sealdice.com/advanced/js_api_list.html`
- Key patterns: plugin registers via `seal.ext.new()`, configs via `seal.ext.registerStringConfig()` / `seal.ext.getStringConfig()`, hooks via `ext.onNotCommandReceived` / `ext.onCommandReceived` / `ext.onMessageSend`.

## Architecture

```
src/index.ts          → main() entry, wires everything
src/config/           → plugin config registration (seal.ext.register*Config)
src/tool/             → AI function-calling tools (file: tool_xxx.ts)
src/AI/               → core AI chat, context, memory, image handling
src/service/          → provider-neutral HTTP client, tool-call loop, protocol-artifact guard
src/service/providers/ → DeepSeek V4 and OpenAI-compatible request/response adapters
src/task.ts           → persistent deadline/periodic task manager and reminder scheduling
src/timer.ts          → persistent target/interval/active-time timer loop
src/cmd/              → chat commands (.ai, .img, .timer, etc.)
src/utils/            → shared utilities
```

- Tools are registered in `src/tool/tool.ts` → `ToolManager.registerTool()`. Each tool file exports a registration function.
- Config keys are registered in `src/config/configManager.ts`. Each config file exports a class/function that registers its group of keys.
- Session-scoped AI instances are managed by `AIManager.getAI(sid)` keyed by user/group ID.
- `AIClient` owns provider dispatch, timeout/error handling, usage accounting, and the ordinary-content `tool_artifact` guard. `ToolCallLoop` uses reply thinking for the first/final natural-language request and tool thinking only after a structured tool call.
- `src/service/toolCallArtifact.ts` must remain conservative: it blocks protocol-shaped DSML/XML/function-call text, while ordinary mentions of those terms must remain valid content.

## Verification boundaries

- `npm run build` is the repository's static acceptance gate; it produces `dist/aipluginmin.js` and automatically backs up the previous artifact.
- `git diff --check` is required for documentation and source changes.
- Build and static checks do not prove live provider behavior, thinking parameters, SealDice notification delivery, storage revival, or command/`.nn`/group-card behavior. Report those as pending until tested in a real SealDice instance with the configured provider.
- The current project status belongs in the task report and Git diff. Do not treat an uncommitted worktree snapshot as a release or as evidence that real runtime testing passed.

## Conventions

- **2-space indent, LF, single quotes** (`.editorconfig`, prettier in `package.json`)
- Import order enforced by eslint: `import/order` with `newlines-between: always`, alphabetical.
- No test framework exists; CI (`build-check.yml`) only verifies `npm run build` succeeds.
- `package-lock.json` is gitignored.
- Branch: `main`. No formal PR/release conventions beyond the `release.yml` workflow (manual trigger via `workflow_dispatch`).

## Constraints (user directive)

- **ALL changes must go through git.** No direct file edits without committing.
- **User reviews every change before commit.** Do not commit/push without explicit approval.
- **Desensitize user-provided data in documents** — error logs, group names, QQ IDs, nicknames, and message content must NOT be copied verbatim into plan/spec/design docs or any artifact that may be shared/backed up. Use placeholders (`XX群`, `QQ:****`, `用户A`) instead.
- Plugin goal: make bot dialogue feel more human / 更像真人.

## Repository Map

A full codemap is available at `codemap.md` in the project root.

Before working on any task, read `codemap.md` to understand:
- Project architecture and entry points
- Directory responsibilities and design patterns
- Data flow and integration points between modules

For deep work on a specific folder, also read that folder's `codemap.md`.
