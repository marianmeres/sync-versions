# @marianmeres/sync-versions — Agent Guide

## Quick Reference

- **What**: CLI + library. Carries the root `package.json` version into every pnpm workspace
  member manifest, each `--version-module` (`export const VERSION = "…"`) and the
  changelog (`## Unreleased` → `## <version> — <date>`). The `--before-commit` step of a
  one-version release. Zero runtime dependencies.
- **Stack**: TypeScript (erasable-only), Node LTS (`.node-version`), pnpm, `node:test`, Biome.
- **Install**: `pnpm install` | **Test**: `pnpm test` | **Check all**: `pnpm run ci` |
  **Build**: `pnpm run build`
- **Distribution**: npm only, public (`@marianmeres/sync-versions`, bin `sync-versions`). No JSR.
- **Origin**: written to replace the `scripts/sync-versions.ts` copied across `joy-next`,
  `stack` and `collection-next` (sibling repos under `~/projects/@marianmeres/`).

## Project Structure

```
src/sync-versions.ts    the library: syncVersions() + pure helpers; the package entry
src/cli.ts              flags → syncVersions → lines + exit code; main() never exits
src/bin.ts              npm `bin` entry (shebang); `node src/bin.ts` runs it from source
tests/helpers.test.ts   pure helpers, no file system
tests/sync.test.ts      throwaway workspaces on disk, driven through main() / syncVersions()
tests/bin.e2e.test.ts   spawns `node src/bin.ts`: the exit codes a release hook sees
API.md                  library reference; README.md is the CLI reference
CHANGELOG.md            stamped by this tool itself on release
dist/                   `tsc -p tsconfig.build.json` output; gitignored; all npm gets
```

## Critical Conventions

1. **Every check before any write.** A refusal must leave every file as it was: release tools
   restore only the manifest they bumped. A new check goes before the write loop at the end of
   `syncVersions`, never between writes.
2. **Ambiguous is a refusal, never a guess.** Unknown workspace pattern, unmatched `--exclude`,
   two `VERSION` exports, an empty `packages:` list: all throw. A parse that yields nothing is
   an error, never "no members".
3. **Formatting survives.** Replace versions in place with a regex and re-parse to verify. Never
   `JSON.stringify` a manifest back.
4. **Library throws `SyncError`; only `bin.ts` sets the exit code.** `main(argv, io)` returns it.
5. **Relaxed by default.** No `## Unreleased` → a heading with `NO_NOTES` + a warning; the
   heading is required (consumers' `--check` needs the newest heading to be the version).
   `--strict` turns it into a refusal. `--check` never requires notes; `--preflight` does.
6. **Runtime policy**: Node only, `node:*` imports, no `Deno.*` / `Bun.*` / `jsr:` / `npm:`.
   Erasable TS: no `enum`, `namespace`, constructor parameter properties; `import type`;
   explicit `.ts` import extensions. `pnpm run typecheck` is the only type gate.
7. **Formatting**: tabs, 4 wide, 90 columns (`biome.json`). `pnpm run format` before committing.
8. **Releasing is a human action**: `pnpm run rp` / `rpm` (`npm whoami` → the release tool's
   own checks → its `--before-bump`: preflight + ci → bump + this tool from source →
   commit + tag → its `--before-push`: `pnpm publish` → push). Public npm: irreversible.

## Before Making Changes

- [ ] Behaviour change: test in `tests/sync.test.ts`, the README tables, `API.md`, an entry
  under `## Unreleased` in `CHANGELOG.md`
- [ ] New flag: `OPTIONS` + `USAGE` in `src/cli.ts`, the README options table, a test in the
  "arguments" suite if it can conflict with another flag
- [ ] `pnpm run ci`
- [ ] Consumers pin this tool: a new flag reaches them only after they bump it

## Documentation Index

- [README.md](./README.md): CLI usage, what it writes, refusals
- [API.md](./API.md): library functions and types
- [CHANGELOG.md](./CHANGELOG.md): releases
