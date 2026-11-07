# API

```ts
import { syncVersions, SyncError } from "@marianmeres/sync-versions";
```

Library functions never exit the process. They throw `SyncError`; only the CLI turns that
into exit code 1.

## Functions

### `syncVersions(options?)`

Copies the root `package.json` version into every workspace member manifest that has a
`version`, every `versionModules` file and the changelog. In the `check` and `preflight`
modes it only verifies that they already agree. Every check runs before any write.

**Parameters:**

- `options` (`SyncOptions`, optional)
  - `root` (string): the repository root. Default: `process.cwd()`.
  - `mode` (`"write" | "check" | "preflight"`): default `"write"`.
  - `strict` (boolean): refuse a release with no `## Unreleased` section. In `preflight`,
    fail instead of warning. Throws when combined with `mode: "check"`. Default: `false`.
  - `exclude` (string[]): member directories to leave alone, root-relative.
  - `versionModules` (string[]): root-relative files with one `export const VERSION = "…"`.
  - `changelog` (string | `false`): root-relative changelog path, or `false` for none.
    Default: `"CHANGELOG.md"`.
  - `date` (string): the `YYYY-MM-DD` a stamped heading carries. Default: today, in UTC.

**Returns:** `SyncReport`

**Throws:** `SyncError`, on a refusal or (outside `"write"`) on drift. Nothing has been
written when it throws.

**Example:**

```ts
const report = syncVersions({ versionModules: ["packages/core/src/version.ts"] });
for (const { path, from, to } of report.changes) console.log(`${path} ${from} → ${to}`);
for (const warning of report.warnings) console.warn(warning);
```

### `findMembers(root, exclude?)`

Returns the workspace's member directories, root-relative and sorted, without the
`exclude`d ones. Returns `[]` when `pnpm-workspace.yaml` is missing or has no `packages:` key.

```ts
findMembers(".", ["examples/demo"]); // ["packages/a", "packages/b"]
```

### `parseWorkspaceGlobs(yaml)`

Returns the `packages:` globs of a `pnpm-workspace.yaml` text, or `undefined` when there is no
`packages:` key. It throws on the inline form (`packages: [a, b]`), on an entry it cannot
read, and on a key with no entries.

### `setManifestVersion(text, version, path?)`

Returns the manifest `text` with its top-level `version` replaced and every other byte left
as it was. It throws when the first `"version"` key is not the top-level one. `path` is used
only in error messages.

### `readModuleVersion(text, path?)` / `setModuleVersion(text, version, path?)`

Read or replace the single `export const VERSION = "…"` (single or double quotes, an optional
`: string` annotation). Both throw when there is none or more than one.

### `stampChangelog(text, version, date)`

Returns `{ text, stamp }`, where `stamp` is one of:

- `"already"`: the newest section already names `version`, and `text` is unchanged.
- `"unreleased"`: `## Unreleased` became `## <version> — <date>`.
- `"no-notes"`: there was no `## Unreleased`, so a heading with `NO_NOTES` under it went in
  above the newest section, or at the end if there are no sections.

Run `changelogProblems` first; this function assumes the changelog is well-formed.

### `changelogProblems(text, version, path?, releasing?)`

Returns a list of problems, empty when there are none: two `## Unreleased` sections, or one
that is not the newest section. With `releasing`, it also reports a section for `version`
that is not the newest one.

### `changelogHeadings(text)`

Returns the first token of every `## ` heading, newest first: versions, or `"Unreleased"`.

## Types

### `SyncReport`

```ts
interface SyncReport {
	version: string; // the root version
	manifests: string[]; // member manifests that carry it
	changes: Change[]; // "write": the files rewritten; otherwise []
	warnings: string[]; // e.g. a release stamped with no notes
}

interface Change {
	path: string;
	from: string;
	to: string;
}
```

### `SyncError`

```ts
class SyncError extends Error {
	readonly problems: readonly string[]; // every problem found, in order
}
```

## Constants

### `NO_NOTES`

`"_No notes were written for this release._"`: the line placed under a heading that was
stamped without a `## Unreleased` section.
