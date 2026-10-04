# types/ — SealDice Runtime Declarations

## Responsibility

Provides the global TypeScript declarations consumed by the plugin source. `seal.d.ts` describes the SealDice host objects (`seal`, `seal.ExtInfo`, `seal.MsgContext`, `seal.Message`, command arguments, extension hooks, storage, and API helpers) so esbuild and editor/type-check tooling can resolve host APIs that are injected at runtime.

## Design patterns

- **Ambient declarations**: the file is loaded through `tsconfig.json` and is not imported by runtime code.
- **Host boundary typing**: declarations model the subset of SealDice used by this plugin; the file is intentionally incomplete because the host supplies the implementation.

## Data and control flow

`tsconfig.json` includes `types/seal.d.ts` → TypeScript resolves the global SealDice names used throughout `src/` → esbuild bundles `src/index.ts` while leaving host-only modules such as `csharp` and `puerts` external.

## Integration points

- `src/index.ts`, `src/config/`, `src/cmd/`, `src/tool/`, and `src/utils/` use the ambient SealDice types.
- SealDice remains the runtime authority; changes to this declaration file should be checked against the local `sealdice-core` reference or the official API manual before changing call sites.
