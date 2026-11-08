# Changelog

The version is `package.json`'s. This tool stamps the heading below when it releases itself
(`pnpm run release` runs `node src/bin.ts` as its `--before-commit` step).

## 0.2.0 — 2026-11-08

_No notes were written for this release._

## 0.1.0 — 2026-11-07

**First release.** This replaces the `scripts/sync-versions.ts` that `joy-next`, `stack` and
`collection-next` each kept their own copy of.

- Copies the root `package.json` version into every pnpm workspace member that has a
  `version`, read from the `packages:` list in `pnpm-workspace.yaml` (`<dir>/*` and plain
  `<dir>` patterns). `--exclude <dir>` leaves a member out. Formatting is preserved: the value
  is replaced in place and checked by re-parsing.
- `--version-module <path>` (repeatable) copies the version into a file's single
  `export const VERSION = "…"`.
- Stamps the changelog: `## Unreleased` becomes `## <version> — <date>`. With no
  `## Unreleased` section, the release still goes through: a heading with a "no notes" line
  goes in, and a warning is printed. `--strict` refuses it instead. `--changelog <path>` and
  `--no-changelog` choose the file or turn the changelog off.
- `--check` verifies without writing. `--preflight` runs before a release: the same check,
  plus a warning (a failure with `--strict`) when there are no notes yet.
- Refuses anything ambiguous, always before writing a file.
- A library entry: `syncVersions()` and its pure helpers (see `API.md`).
