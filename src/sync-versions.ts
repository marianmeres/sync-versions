/**
 * Carry a workspace's one version into everything that states it.
 *
 * A release tool bumps one manifest: the root `package.json`. When every package in a pnpm
 * workspace is released together at that one version, something has to copy it into each
 * member's manifest, into any `export const VERSION = "…"` a package exposes, and into the
 * changelog, whose `## Unreleased` heading becomes `## <version> — <date>`. That is this.
 *
 * Invariants:
 * - **Every check runs before any write.** A refusal leaves every file as it was: a release
 *   tool restores only the manifest it bumped, so nothing else may be left half-written.
 * - **Anything ambiguous is a refusal, never a guess**: a workspace file this cannot read, a
 *   glob shape it does not handle, an `exclude` that matches no member, a manifest whose first
 *   `"version"` key is not the top-level one, two `VERSION` exports in one module.
 * - **Formatting survives.** Versions are replaced in place; a manifest is never re-serialised.
 * - Library code throws {@link SyncError}; only the CLI exits.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

/** What a run does: write the version through, verify it, or verify ahead of a release. */
export type Mode = "write" | "check" | "preflight";

export interface SyncOptions {
	/** The repository root, holding the root `package.json`. Default: `process.cwd()`. */
	root?: string;
	/**
	 * - `"write"` (default): carry the version through and stamp the changelog.
	 * - `"check"`: verify only; throw on drift, write nothing.
	 * - `"preflight"`: `"check"`, plus a warning (an error with `strict`) when the changelog
	 *   has no `## Unreleased` section, meaning the next release would go out with no notes.
	 */
	mode?: Mode;
	/**
	 * Refuse a release whose changes nobody wrote down. Without it, a changelog with no
	 * `## Unreleased` section gets a `## <version> — <date>` heading saying no notes were
	 * written, and a warning. Not meaningful with `mode: "check"`, which throws if it is set.
	 */
	strict?: boolean;
	/** Workspace member directories to leave alone, root-relative (`"examples/demo"`). */
	exclude?: readonly string[];
	/** Root-relative files holding one `export const VERSION = "…"` to carry the version into. */
	versionModules?: readonly string[];
	/** The root-relative changelog, or `false` for none. Default: `"CHANGELOG.md"`. */
	changelog?: string | false;
	/** The date a stamped heading carries, `YYYY-MM-DD`. Default: today, in UTC. */
	date?: string;
}

/** One file whose stated version is (or, outside `"write"`, would be) rewritten. */
export interface Change {
	/** Root-relative path. */
	path: string;
	/** What it stated: a version, or for the changelog, the heading that was there. */
	from: string;
	/** What it states now. */
	to: string;
}

export interface SyncReport {
	/** The root `package.json`'s version, carried everywhere else. */
	version: string;
	/** The member manifests that carry the version (excluded and version-less ones left out). */
	manifests: string[];
	/** `"write"`: the files rewritten. `"check"` / `"preflight"`: always empty. */
	changes: Change[];
	/** Things worth saying that are not a refusal, such as a release stamped with no notes. */
	warnings: string[];
}

/** A refusal or, outside `"write"`, drift. `problems` lists every one found, in order. */
export class SyncError extends Error {
	override name = "SyncError";
	readonly problems: readonly string[];

	constructor(problems: string | readonly string[]) {
		const list = typeof problems === "string" ? [problems] : [...problems];
		super(list.join("\n"));
		this.problems = list;
	}
}

/** The line a release with no `## Unreleased` section gets under its heading. */
export const NO_NOTES = "_No notes were written for this release._";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UNRELEASED = /^## Unreleased[ \t]*$/m;
const UNRELEASED_ALL = /^## Unreleased[ \t]*$/gm;
const HEADINGS = /^## (\S+)/gm;
/** The first `"version": "…"` of a manifest; the caller re-parses to prove it was top-level. */
const MANIFEST_VERSION = /("version"\s*:\s*")([^"]*)(")/;
const MODULE_VERSION =
	/(export const VERSION(?:\s*:\s*string)?\s*=\s*)(["'])([^"'\n]*)\2/g;
/** Characters that make a workspace pattern more than a plain directory. */
const GLOB_CHARS = /[*?[\]{}!]/;

const quote = (value: string | undefined): string => JSON.stringify(value ?? "none");

/**
 * The `packages:` globs of a `pnpm-workspace.yaml`, or `undefined` when it has no `packages:`
 * key (pnpm then treats the root as the only package). A key with nothing readable under it
 * throws: an empty result is a refusal, never "no members".
 *
 * Reads the block-list form pnpm documents (one `- glob` per line, quoted or not, comments
 * allowed) with a line scan rather than a YAML parser, and throws on any other shape.
 */
export function parseWorkspaceGlobs(yaml: string): string[] | undefined {
	const lines = yaml.split(/\r?\n/);
	const start = lines.findIndex((line) => /^packages[ \t]*:/.test(line));
	if (start === -1) return undefined;

	const inline = (lines[start] ?? "")
		.replace(/^packages[ \t]*:/, "")
		.replace(/#.*$/, "")
		.trim();
	if (inline !== "") {
		throw new SyncError(
			`pnpm-workspace.yaml: \`packages:\` is written inline (${inline}); only the block ` +
				'list form (one "- glob" per line) is read.',
		);
	}

	const globs: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^\s*(?:#.*)?$/.test(line)) continue;
		// the list ends at the first line that is not one of its entries
		if (!/^\s*-/.test(line)) break;
		const entry = /^\s*-\s*(["']?)([^"'#\s]+)\1\s*(?:#.*)?$/.exec(line);
		if (entry?.[2] === undefined) {
			throw new SyncError(
				`pnpm-workspace.yaml: cannot read the \`packages:\` entry ${quote(line.trim())}.`,
			);
		}
		globs.push(entry[2]);
	}
	if (globs.length === 0) {
		throw new SyncError(
			"pnpm-workspace.yaml has a `packages:` key with no entries this can read — an " +
				"empty workspace is not a result.",
		);
	}
	return globs;
}

function isDirectory(path: string): boolean {
	return existsSync(path) && statSync(path).isDirectory();
}

/** `"./a/b/"` → `"a/b"`: how a member directory is named everywhere here. */
function normalizeDirectory(path: string): string {
	return path.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
}

/** The member directories one workspace pattern names. */
function membersOf(root: string, glob: string): string[] {
	if (glob.startsWith("!")) {
		throw new SyncError(
			`pnpm-workspace.yaml: the negated pattern ${quote(glob)} is not supported — ` +
				"leave a member out with --exclude <dir> instead.",
		);
	}
	const pattern = normalizeDirectory(glob);
	// the root is where the version comes from, not a member it goes to
	if (pattern === "" || pattern === ".") return [];

	const parent = pattern.slice(0, -2);
	if (pattern.endsWith("/*") && !GLOB_CHARS.test(parent)) {
		if (!isDirectory(join(root, parent))) {
			throw new SyncError(
				`pnpm-workspace.yaml declares ${quote(glob)}, but ${parent}/ does not exist — ` +
					"a declared member directory that vanished is drift, not zero members.",
			);
		}
		return readdirSync(join(root, parent), { withFileTypes: true })
			.filter(
				(entry) =>
					entry.isDirectory() &&
					!entry.name.startsWith(".") &&
					existsSync(join(root, parent, entry.name, "package.json")),
			)
			.map((entry) => `${parent}/${entry.name}`);
	}

	if (!GLOB_CHARS.test(pattern)) {
		if (!existsSync(join(root, pattern, "package.json"))) {
			throw new SyncError(
				`pnpm-workspace.yaml declares ${quote(glob)}, but ${pattern}/package.json does ` +
					"not exist.",
			);
		}
		return [pattern];
	}

	throw new SyncError(
		`pnpm-workspace.yaml: the pattern ${quote(glob)} is not supported — only "<dir>/*" ` +
			'and a plain "<dir>" are read. A member this cannot see would go unsynced.',
	);
}

function readJson(root: string, path: string): Record<string, unknown> {
	const text = readFileSync(join(root, path), "utf8");
	try {
		const value: unknown = JSON.parse(text);
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			throw new Error("not an object");
		}
		return value as Record<string, unknown>;
	} catch (error) {
		throw new SyncError(`${path} is not a JSON object: ${(error as Error).message}`);
	}
}

/**
 * The workspace's member directories, root-relative and sorted, with `exclude` left out.
 * A repository with no `packages:` in `pnpm-workspace.yaml` (or no such file) has none.
 */
export function findMembers(root: string, exclude: readonly string[] = []): string[] {
	const yamlPath = join(root, "pnpm-workspace.yaml");
	const globs = existsSync(yamlPath)
		? parseWorkspaceGlobs(readFileSync(yamlPath, "utf8"))
		: undefined;

	if (globs === undefined) {
		if (readJson(root, "package.json").workspaces !== undefined) {
			throw new SyncError(
				"package.json declares `workspaces`, and only pnpm workspaces " +
					"(pnpm-workspace.yaml `packages:`) are read — refusing rather than syncing " +
					"no members.",
			);
		}
		if (exclude.length > 0) {
			throw new SyncError(
				`--exclude ${exclude.join(", ")}: this repository has no workspace members.`,
			);
		}
		return [];
	}

	const found = [...new Set(globs.flatMap((glob) => membersOf(root, glob)))].sort();
	if (found.length === 0) {
		throw new SyncError(
			`pnpm-workspace.yaml's \`packages:\` (${globs.join(", ")}) matched no directory ` +
				"with a package.json — an empty workspace is not a result.",
		);
	}

	const excluded = exclude.map(normalizeDirectory);
	const unmatched = excluded.filter((dir) => !found.includes(dir));
	if (unmatched.length > 0) {
		throw new SyncError(
			`--exclude ${unmatched.join(", ")} matches no workspace member (the members are ` +
				`${found.join(", ")}).`,
		);
	}
	return found.filter((dir) => !excluded.includes(dir));
}

/**
 * `text` (a manifest) with its top-level `version` set, all other bytes untouched. Throws
 * when the first `"version"` key is not the top-level one, rather than editing the wrong key.
 */
export function setManifestVersion(
	text: string,
	version: string,
	path = "package.json",
): string {
	const next = text.replace(
		MANIFEST_VERSION,
		(_match, before: string, _old: string, after: string) =>
			`${before}${version}${after}`,
	);
	if ((JSON.parse(next) as { version?: unknown }).version !== version) {
		throw new SyncError(
			`${path}: rewriting its first "version" key did not set the top-level version. ` +
				"Set it by hand and run again.",
		);
	}
	return next;
}

/** The version a module's single `export const VERSION = "…"` states. */
export function readModuleVersion(text: string, path = "the module"): string {
	const matches = [...text.matchAll(MODULE_VERSION)];
	if (matches.length > 1) {
		throw new SyncError(
			`${path} has ${matches.length} \`export const VERSION\` declarations — refusing ` +
				"to guess which one is the version.",
		);
	}
	const current = matches[0]?.[3];
	if (current === undefined) {
		throw new SyncError(
			`${path} has no \`export const VERSION = "…"\` to carry the version into.`,
		);
	}
	return current;
}

/** `text` (a module) with its `export const VERSION` set, quotes and spacing kept. */
export function setModuleVersion(
	text: string,
	version: string,
	path = "the module",
): string {
	readModuleVersion(text, path);
	return text.replace(
		MODULE_VERSION,
		(_match, before: string, q: string) => `${before}${q}${version}${q}`,
	);
}

/** The first token of every `## ` heading, newest first: versions, or `Unreleased`. */
export function changelogHeadings(text: string): string[] {
	return [...text.matchAll(HEADINGS)].map((match) => match[1] ?? "");
}

/**
 * `text` (a changelog) stamped for `version`:
 * - `"already"`: its newest section already names the version; `text` is unchanged.
 * - `"unreleased"`: `## Unreleased` became `## <version> — <date>`.
 * - `"no-notes"`: there was no `## Unreleased`, so a `## <version> — <date>` heading with
 *   {@link NO_NOTES} went in above the newest section (or at the end, if there is none).
 *
 * Validate with {@link changelogProblems} first; this assumes a well-formed changelog.
 */
export function stampChangelog(
	text: string,
	version: string,
	date: string,
): { text: string; stamp: "already" | "unreleased" | "no-notes" } {
	const heading = `## ${version} — ${date}`;
	if (changelogHeadings(text)[0] === version) return { text, stamp: "already" };
	if (UNRELEASED.test(text)) {
		return { text: text.replace(UNRELEASED, heading), stamp: "unreleased" };
	}

	const entry = `${heading}\n\n${NO_NOTES}\n`;
	const at = text.search(/^## /m);
	if (at === -1) {
		return {
			text: text.trim() === "" ? entry : `${text.trimEnd()}\n\n${entry}`,
			stamp: "no-notes",
		};
	}
	return { text: `${text.slice(0, at)}${entry}\n${text.slice(at)}`, stamp: "no-notes" };
}

/**
 * What makes a changelog unsafe to stamp or check, in any mode: more than one
 * `## Unreleased`, or one that is not the newest section. With `releasing`, also a section
 * for `version` that is not the newest one: the version was not bumped, or was released
 * before.
 */
export function changelogProblems(
	text: string,
	version: string,
	path = "CHANGELOG.md",
	releasing = false,
): string[] {
	const problems: string[] = [];
	const headings = changelogHeadings(text);
	const unreleased = [...text.matchAll(UNRELEASED_ALL)].length;
	if (unreleased > 1) {
		problems.push(
			`${path} has ${unreleased} "## Unreleased" sections; keep one, on top.`,
		);
	} else if (unreleased === 1 && headings[0] !== "Unreleased") {
		problems.push(
			`${path}: "## Unreleased" is not the newest section (the newest is ` +
				`${quote(headings[0])}); move it to the top.`,
		);
	}
	if (releasing && headings.indexOf(version) > 0) {
		problems.push(
			`${path} already has a section for ${version}, and it is not the newest one — ` +
				"was the version bumped?",
		);
	}
	return problems;
}

/** The root `package.json`'s version, validated as semver. */
function rootVersion(root: string): string {
	if (!existsSync(join(root, "package.json"))) {
		throw new SyncError(
			`there is no package.json in ${root} — run from the repository root.`,
		);
	}
	const value = readJson(root, "package.json").version;
	if (typeof value !== "string" || !SEMVER.test(value)) {
		throw new SyncError(
			`the root package.json has no semver "version" (got ${JSON.stringify(value)}).`,
		);
	}
	return value;
}

interface Pending extends Change {
	text: string;
}

/**
 * Carry the root `package.json`'s version into every workspace member manifest that has a
 * `version`, every {@link SyncOptions.versionModules} file and the changelog — or, outside
 * `"write"`, verify that they already agree. Throws {@link SyncError} on a refusal or on
 * drift, having written nothing.
 */
export function syncVersions(options: SyncOptions = {}): SyncReport {
	const root = options.root ?? process.cwd();
	const mode = options.mode ?? "write";
	const strict = options.strict ?? false;
	const changelog = options.changelog ?? "CHANGELOG.md";
	const date = options.date ?? new Date().toISOString().slice(0, 10);

	if (mode === "check" && strict) {
		throw new SyncError(
			"--strict has no meaning with --check, which never requires notes (it runs " +
				"between releases too) — use --preflight --strict before a release.",
		);
	}
	if (!DATE.test(date)) {
		throw new SyncError(`the date ${quote(date)} is not YYYY-MM-DD.`);
	}

	const version = rootVersion(root);
	const problems: string[] = [];
	const warnings: string[] = [];
	const pending: Pending[] = [];
	const manifests: string[] = [];

	for (const dir of findMembers(root, options.exclude)) {
		const path = `${dir}/package.json`;
		const current = readJson(root, path).version;
		// "everything that states it": a member with no version has nothing to carry
		if (current === undefined) continue;
		if (typeof current !== "string") {
			throw new SyncError(`${path}: "version" is not a string.`);
		}
		manifests.push(path);
		if (current === version) continue;
		const text = readFileSync(join(root, path), "utf8");
		pending.push({
			path,
			text: setManifestVersion(text, version, path),
			from: current,
			to: version,
		});
	}

	for (const path of options.versionModules ?? []) {
		if (!existsSync(join(root, path))) {
			throw new SyncError(`--version-module ${path} does not exist.`);
		}
		const text = readFileSync(join(root, path), "utf8");
		const current = readModuleVersion(text, path);
		if (current === version) continue;
		pending.push({
			path,
			text: setModuleVersion(text, version, path),
			from: current,
			to: version,
		});
	}

	if (mode !== "write") {
		for (const { path, from } of pending) {
			problems.push(
				`${path} is ${quote(from)}, the workspace is ${quote(version)}.`,
			);
		}
	}

	if (changelog !== false) {
		if (!existsSync(join(root, changelog))) {
			throw new SyncError(
				`${changelog} does not exist — create it, point --changelog at the right ` +
					"file, or pass --no-changelog.",
			);
		}
		const text = readFileSync(join(root, changelog), "utf8");
		problems.push(...changelogProblems(text, version, changelog, mode === "write"));
		const newest = changelogHeadings(text)[0];
		const unreleased = UNRELEASED.test(text);

		if (mode === "write") {
			if (newest !== version && !unreleased && strict) {
				problems.push(
					`${changelog} has no "## Unreleased" section for ${version} (its newest is ` +
						`${quote(newest)}). Write what this release changes under ` +
						'"## Unreleased" above the newest section, commit it, and release ' +
						"again — or release without --strict to stamp the version with no notes.",
				);
			} else if (problems.length === 0) {
				const stamped = stampChangelog(text, version, date);
				if (stamped.stamp !== "already") {
					pending.push({
						path: changelog,
						text: stamped.text,
						from:
							stamped.stamp === "unreleased"
								? "## Unreleased"
								: "(no notes)",
						to: `## ${version} — ${date}`,
					});
				}
				if (stamped.stamp === "no-notes") {
					warnings.push(
						`${changelog} has no "## Unreleased" section, so "## ${version} — ` +
							`${date}" went in with no notes (--strict refuses instead).`,
					);
				}
			}
		} else if (newest !== version && newest !== "Unreleased") {
			problems.push(
				`${changelog}'s newest section is ${quote(newest)}, neither ${quote(version)} ` +
					'nor "Unreleased".',
			);
		} else if (mode === "preflight" && !unreleased) {
			const message = `${changelog} has no "## Unreleased" section, so the next release goes out with no notes`;
			if (strict) problems.push(`${message} — write them first (--strict).`);
			else warnings.push(`${message}.`);
		}
	}

	if (problems.length > 0) throw new SyncError(problems);

	if (mode === "write") {
		for (const { path, text } of pending) writeFileSync(join(root, path), text);
	}
	return {
		version,
		manifests,
		changes:
			mode === "write"
				? pending.map(({ path, from, to }) => ({ path, from, to }))
				: [],
		warnings,
	};
}
