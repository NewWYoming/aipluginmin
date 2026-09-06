# tools

## Responsibility

Contains the esbuild-based development and production build scripts for AI骰娘Min.

## Design patterns

Build settings are separated from orchestration: `build-config.js` declares targets and output paths, while `build.js` handles backup, cleanup, esbuild execution, and UserScript-header prepending.

## Data and control flow

`npm run build` selects the production configuration, backs up the previous configured artifact by version, rebuilds `dist/aipluginmin.js`, then prepends `header.txt`.

## Integration points

- `package.json`: exposes build commands.
- `header.txt`: supplies UserScript metadata.
- `src/index.ts`: esbuild entry point.
