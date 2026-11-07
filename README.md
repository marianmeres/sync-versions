# @marianmeres/sync-versions

[![NPM](https://img.shields.io/npm/v/@marianmeres/sync-versions)](https://www.npmjs.com/package/@marianmeres/sync-versions)
[![License](https://img.shields.io/npm/l/@marianmeres/sync-versions)](LICENSE)

Use this in a pnpm workspace whose packages are all released together at one version. It
copies the root `package.json` version into every member manifest, into any
`export const VERSION = "…"` constants, and into the changelog, where `## Unreleased` becomes
`## <version> — <date>`. It is meant to run between the version bump and the release commit.

## Installation

```bash
pnpm add -D @marianmeres/sync-versions
```

Node 24.12 or newer. No runtime dependencies.

## Usage

A release tool such as [`@marianmeres/release`](https://github.com/marianmeres/release) bumps
one manifest: the root `package.json`. Run `sync-versions` as that tool's
`--before-commit` step, so the release commit carries the new version everywhere:

```json
{
  "scripts": {
    "release": "sync-versions --preflight && pnpm run ci && release --before-commit \"sync-versions\"",
    "version:check": "sync-versions --check"
  }
}
```

- `--preflight` runs before anything slow. It checks that the workspace already agrees on one
  version. It also warns when the changelog has no `## Unreleased` section; with `--strict`,
  it fails instead.
- `--check` belongs in CI or your test suite. It fails when someone edits a version by hand
  and the rest of the workspace no longer matches.

Run it from the repository root.

## What it changes

| Target            | Which                                                                                      | How                                                     |
| ----------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Member manifests  | Every workspace member that has a `version`, minus any `--exclude`                         | The value is replaced in place; formatting is untouched |
| `VERSION` modules | Each `--version-module <path>`; each must contain exactly one `export const VERSION = "…"` | Quotes, spacing and a `: string` annotation are kept    |
| The changelog     | `CHANGELOG.md`, or `--changelog <path>`, or nothing with `--no-changelog`                  | `## Unreleased` becomes `## <version> — <date>` (UTC)   |

Members are read from the `packages:` list in `pnpm-workspace.yaml`. A pattern can be
`<dir>/*` (every child directory with a `package.json`, hidden ones excluded) or a plain
`<dir>`. Without a `packages:` list, the repository is treated as a single package, and only
the modules and the changelog are synced.

### When there is no `## Unreleased` section

By default the release still goes through. A `## <version> — <date>` heading goes in above
the newest section, with a line saying _No notes were written for this release._, and a
warning is printed. The heading keeps `--check` passing afterwards, and the changelog still
lists every release.

With `--strict`, the release is refused instead. The tool exits 1 before writing anything,
and a release tool that restores its bump on failure, such as `@marianmeres/release`, leaves
the tree exactly as it was.

## Options

| Option                    | Meaning                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| _(none)_                  | Write mode: copy the version everywhere and stamp the changelog.                                        |
| `--check`                 | Verify only: exit 1 on drift, write nothing.                                                            |
| `--preflight`             | Same as `--check`, plus a warning (a failure with `--strict`) when there is no `## Unreleased` section. |
| `--strict`                | Refuse a release with no `## Unreleased` section. Not accepted with `--check`.                          |
| `--exclude <dir>`         | A workspace member to leave alone (repeatable). It must name an existing member.                        |
| `--version-module <path>` | A file whose `export const VERSION` gets the version (repeatable).                                      |
| `--changelog <path>`      | The changelog. Default: `CHANGELOG.md`.                                                                 |
| `--no-changelog`          | There is no changelog.                                                                                  |
| `-h`, `--help`            | Show usage.                                                                                             |

## Refusals

Anything ambiguous makes it exit 1, and it never writes a file before every check has
passed. It refuses when:

- the root version is missing or not semver
- a workspace pattern is negated (`!…`), deeper than `<dir>/*`, or names a directory that
  does not exist
- the `packages:` list matches no member
- the repository uses npm or yarn `workspaces` (only pnpm workspaces are supported)
- an `--exclude` matches no member
- a manifest's first `"version"` key is not the top-level one
- a version module has no `VERSION` export, or more than one
- the changelog is missing, has two `## Unreleased` sections, has one that is not the newest
  section, or, when releasing, already has a section for the version below the top
- an unknown flag, a stray argument, or contradictory flags are passed

## API

The same logic is available as a library (`syncVersions()` and its helpers). See
[API.md](API.md).

## License

[MIT](LICENSE)
