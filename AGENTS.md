# AGENTS.md — aiplugin4

## What this is

A SealDice JS plugin (AI骰娘4) that makes the dice bot converse like a human. Runs inside the SeaDice host runtime. Single bundled JS output loaded by SeaDice.

## Build

```bash
npm run build       # production → dist/aiplugin4.js
npm run build-dev   # dev (sourcemaps, ES2020) → dev/aiplugin4.js
```

- Bundler: **esbuild** (not tsc). `tsconfig.json` is only for eslint type-checking + esbuild config reference.
- esbuild prepends `header.txt` (UserScript metadata) to the output.
- Build marks `csharp` and `puerts` as external — these exist in the SeaDice host runtime.

### Before every build

1. **Backup old dist file** — `tools/build.js` auto-copies `dist/aiplugin4.js` to `dist-backups/aiplugin4-v{old-version}.js` before overwriting.
2. The backup is automatic; `dist-backups/` can be gitignored.

## Version bumping

**Every commit that modifies `src/` must bump the patch version (X.Y.Z → X.Y.Z+1).** Version lives in two places:

- `src/config/config.ts` → `VERSION` constant
- `header.txt` → `@version` field

Bump both before committing. Do not bump for docs-only or AGENTS.md-only changes.

**⚠️ Use the `edit` tool to bump versions. Never use PowerShell `Set-Content` or `(Get-Content).replace()` — they destroy UTF-8 encoding of Chinese characters.** `header.txt` and `config.ts` contain Chinese text that will garble irreversibly with PowerShell pipes.

## Workflow for changes

**Non-trivial changes must follow: brainstorm → design → plan → implement.** Do not jump directly to code edits for features, refactors, or structural changes.

1. **Brainstorm** — load `brainstorming` skill, explore context, ask questions, propose approaches, get user approval
2. **Design doc** — write to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
3. **Implementation plan** — load `writing-plans` skill, write to `docs/superpowers/plans/YYYY-MM-DD-<topic>-plan.md`
4. **Implement** — execute plan with `subagent-driven-development` (preferred) or `executing-plans`

Exceptions: trivial bugfixes (<10 lines, single file), config default changes, log line additions, version bumps themselves.

## SeaDice API

- **`types/seal.d.ts`** declares the SeaDice runtime types (provided globally, no import needed). The file is **incomplete**.
- If you need an API not covered here, check the SeaDice source: `https://github.com/sealdice/sealdice-core`
- Key patterns: plugin registers via `seal.ext.new()`, configs via `seal.ext.registerStringConfig()` etc., hooks via `ext.onNotCommandReceived` / `ext.onCommandReceived` / `ext.onMessageSend`.

## Architecture

```
src/index.ts          → main() entry, wires everything
src/config/           → plugin config registration (seal.ext.register*Config)
src/tool/             → AI function-calling tools (file: tool_xxx.ts)
src/AI/               → core AI chat, context, memory, image handling
src/cmd/              → chat commands (.ai, .img, .timer, etc.)
src/utils/            → shared utilities
```

- Tools are registered in `src/tool/tool.ts` → `ToolManager.registerTool()`. Each tool file exports a registration function.
- Config keys are registered in `src/config/configManager.ts`. Each config file exports a class/function that registers its group of keys.
- Session-scoped AI instances are managed by `AIManager.getAI(sid)` keyed by user/group ID.

## Conventions

- **2-space indent, LF, single quotes** (`.editorconfig`, prettier in `package.json`)
- Import order enforced by eslint: `import/order` with `newlines-between: always`, alphabetical.
- No test framework exists; CI (`build-check.yml`) only verifies `npm run build` succeeds.
- `package-lock.json` is gitignored.
- Branch: `main`. No formal PR/release conventions beyond the `release.yml` workflow (manual trigger via `workflow_dispatch`).

## Constraints (user directive)

- **ALL changes must go through git.** No direct file edits without committing.
- **User reviews every change before commit.** Do not commit/push without explicit approval.
- Plugin goal: make bot dialogue feel more human / 更像真人.
