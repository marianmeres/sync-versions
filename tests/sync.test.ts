// Whole repositories: a throwaway workspace on disk, driven through the CLI's `main` (and
// `syncVersions` where an exact date is needed), checked file by file.

import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, test } from "node:test";
import { main } from "../src/cli.ts";
import { NO_NOTES, SyncError, syncVersions } from "../src/sync-versions.ts";

type Files = Record<string, string | null>;

const TABS = (fields: Record<string, unknown>): string =>
	`${JSON.stringify(fields, null, "\t")}\n`;
const SPACES = (fields: Record<string, unknown>): string =>
	`${JSON.stringify(fields, null, 2)}\n`;

/**
 * A workspace at root version 1.1.0 whose members are still at 1.0.0: `packages/*` (one
 * tab-indented, one 2-space, one with no version, one hidden, one directory with no
 * manifest) and a plainly named `examples/demo`.
 */
const WORKSPACE: Files = {
	"package.json": TABS({ name: "root", private: true, version: "1.1.0" }),
	"pnpm-workspace.yaml": "packages:\n  - packages/*\n  - examples/demo\n",
	"packages/a/package.json": TABS({
		name: "a",
		version: "1.0.0",
		dependencies: { b: "1" },
	}),
	"packages/a/src/version.ts": 'export const VERSION = "1.0.0";\n',
	"packages/b/package.json": SPACES({ name: "b", version: "1.0.0" }),
	"packages/c/package.json": SPACES({ name: "c", private: true }),
	"packages/.hidden/package.json": SPACES({ name: "hidden", version: "1.0.0" }),
	"packages/notes/README.md": "not a package\n",
	"examples/demo/package.json": SPACES({
		name: "demo",
		private: true,
		version: "1.0.0",
	}),
	"CHANGELOG.md":
		"# Changelog\n\n## Unreleased\n\n- new\n\n## 1.0.0 — 2026-01-01\n\n- old\n",
};

/** `WORKSPACE` with `overrides` applied (`null` deletes a file), written to a temp dir. */
function repo(overrides: Files = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "sync-versions-"));
	for (const [path, text] of Object.entries({ ...WORKSPACE, ...overrides })) {
		if (text === null) continue;
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
	return dir;
}

/** Every file under `dir`, by relative path: what "nothing was written" is checked against. */
function snapshot(dir: string): Record<string, string> {
	const files: Record<string, string> = {};
	const walk = (at: string): void => {
		for (const entry of readdirSync(at, { withFileTypes: true })) {
			const path = join(at, entry.name);
			if (entry.isDirectory()) walk(path);
			else files[relative(dir, path)] = readFileSync(path, "utf8");
		}
	};
	walk(dir);
	return files;
}

const read = (dir: string, path: string): string => readFileSync(join(dir, path), "utf8");

/** Run the CLI in `dir`; returns its exit code and the lines it wrote. */
function run(dir: string, ...argv: string[]): { code: number; out: string; err: string } {
	const out: string[] = [];
	const err: string[] = [];
	const code = main(argv, {
		cwd: dir,
		out: (l) => out.push(l),
		err: (l) => err.push(l),
	});
	return { code, out: out.join("\n"), err: err.join("\n") };
}

/** The run is refused (exit 1, `pattern` on stderr) and leaves every file as it was. */
function assertRefused(dir: string, argv: string[], pattern: RegExp): void {
	const before = snapshot(dir);
	const result = run(dir, ...argv);
	assert.equal(result.code, 1, result.out);
	assert.match(result.err, pattern);
	assert.deepEqual(snapshot(dir), before, "a refusal wrote a file");
}

const VERSION_MODULE = ["--version-module", "packages/a/src/version.ts"];

describe("write", () => {
	test("carries the version into every member, the module and the changelog", () => {
		const dir = repo();
		const report = syncVersions({
			root: dir,
			versionModules: ["packages/a/src/version.ts"],
			date: "2026-11-07",
		});

		assert.deepEqual(report.manifests, [
			"examples/demo/package.json",
			"packages/a/package.json",
			"packages/b/package.json",
		]);
		assert.deepEqual(
			report.changes.map((change) => change.path),
			[...report.manifests, "packages/a/src/version.ts", "CHANGELOG.md"],
		);
		assert.deepEqual(report.warnings, []);

		// in place: each file keeps its own indentation, and nothing else moves
		assert.equal(
			read(dir, "packages/a/package.json"),
			TABS({ name: "a", version: "1.1.0", dependencies: { b: "1" } }),
		);
		assert.equal(
			read(dir, "packages/b/package.json"),
			SPACES({ name: "b", version: "1.1.0" }),
		);
		assert.equal(
			read(dir, "packages/a/src/version.ts"),
			'export const VERSION = "1.1.0";\n',
		);
		assert.equal(
			read(dir, "CHANGELOG.md"),
			"# Changelog\n\n## 1.1.0 — 2026-11-07\n\n- new\n\n## 1.0.0 — 2026-01-01\n\n- old\n",
		);

		// no version, a hidden directory, a directory with no manifest: not members
		assert.equal(
			read(dir, "packages/c/package.json"),
			WORKSPACE["packages/c/package.json"],
		);
		assert.equal(
			read(dir, "packages/.hidden/package.json"),
			WORKSPACE["packages/.hidden/package.json"],
		);
	});

	test("prints what it changed, then agrees with --check, then is a no-op", () => {
		const dir = repo();
		const written = run(dir, ...VERSION_MODULE);
		assert.equal(written.code, 0, written.err);
		assert.match(written.out, /packages\/b\/package\.json 1\.0\.0 → 1\.1\.0/);
		assert.match(
			written.out,
			/CHANGELOG\.md ## Unreleased → ## 1\.1\.0 — \d{4}-\d{2}-\d{2}/,
		);

		assert.equal(run(dir, "--check", ...VERSION_MODULE).code, 0);

		const before = snapshot(dir);
		const again = run(dir, ...VERSION_MODULE);
		assert.equal(again.code, 0, again.err);
		assert.match(again.out, /everything already carries 1\.1\.0/);
		assert.deepEqual(snapshot(dir), before);
	});

	test("a changelog with no `## Unreleased` gets a heading with no notes, and a warning", () => {
		const changelog = "# Changelog\n\nIntro.\n\n## 1.0.0 — 2026-01-01\n\n- old\n";
		const dir = repo({ "CHANGELOG.md": changelog });
		const report = syncVersions({ root: dir, date: "2026-11-07" });

		assert.match(report.warnings[0] ?? "", /no "## Unreleased" section/);
		assert.equal(
			read(dir, "CHANGELOG.md"),
			"# Changelog\n\nIntro.\n\n## 1.1.0 — 2026-11-07\n\n" +
				`${NO_NOTES}\n\n## 1.0.0 — 2026-01-01\n\n- old\n`,
		);
		assert.equal(
			read(dir, "packages/b/package.json"),
			SPACES({ name: "b", version: "1.1.0" }),
		);

		// the heading is what keeps --check green afterwards, and a re-run adds no second one
		assert.equal(run(dir, "--check").code, 0);
		const before = snapshot(dir);
		assert.equal(run(dir).code, 0);
		assert.deepEqual(snapshot(dir), before);

		// and the CLI says so on stderr
		const cli = run(repo({ "CHANGELOG.md": changelog }));
		assert.equal(cli.code, 0);
		assert.match(cli.err, /warning — CHANGELOG\.md has no "## Unreleased" section/);
	});

	test("--strict refuses a release with no `## Unreleased`, before writing anything", () => {
		const dir = repo({
			"CHANGELOG.md": "# Changelog\n\n## 1.0.0 — 2026-01-01\n\n- old\n",
		});
		assertRefused(
			dir,
			["--strict", ...VERSION_MODULE],
			/no "## Unreleased" section for 1\.1\.0/,
		);
	});

	test("--strict stamps `## Unreleased` like the default does", () => {
		const dir = repo();
		const result = run(dir, "--strict");
		assert.equal(result.code, 0, result.err);
		assert.match(
			read(dir, "CHANGELOG.md"),
			/^## 1\.1\.0 — \d{4}-\d{2}-\d{2}\n\n- new\n/m,
		);
	});

	test("a version that already has a section below the top was not bumped: refused", () => {
		const dir = repo({
			"CHANGELOG.md": "## Unreleased\n\n- new\n\n## 1.1.0 — 2026-01-01\n\n- old\n",
		});
		assertRefused(dir, [], /already has a section for 1\.1\.0/);
	});

	test("a manifest whose first `version` key is nested is refused, all files untouched", () => {
		const dir = repo({
			"packages/b/package.json": SPACES({
				name: "b",
				config: { version: "9" },
				version: "1.0.0",
			}),
		});
		assertRefused(
			dir,
			[],
			/packages\/b\/package\.json: rewriting its first "version" key/,
		);
	});
});

describe("check and preflight", () => {
	test("--check lists every drifted file and writes nothing", () => {
		const dir = repo({ "CHANGELOG.md": "## 1.0.0 — 2026-01-01\n\n- old\n" });
		const before = snapshot(dir);
		const result = run(dir, "--check", ...VERSION_MODULE);
		assert.equal(result.code, 1);
		for (const path of [
			"examples/demo/package.json",
			"packages/a/package.json",
			"packages/b/package.json",
			"packages/a/src/version.ts",
		]) {
			assert.match(
				result.err,
				new RegExp(`${path.replaceAll(".", "\\.")} is "1\\.0\\.0"`),
			);
		}
		assert.match(
			result.err,
			/newest section is "1\.0\.0", neither "1\.1\.0" nor "Unreleased"/,
		);
		assert.deepEqual(snapshot(dir), before);
	});

	test("--check passes with the version on top, or `## Unreleased` above it", () => {
		const dir = repo();
		assert.equal(run(dir).code, 0);
		assert.equal(run(dir, "--check").code, 0);

		writeFileSync(
			join(dir, "CHANGELOG.md"),
			`## Unreleased\n\n- next\n\n${read(dir, "CHANGELOG.md")}`,
		);
		const result = run(dir, "--check");
		assert.equal(result.code, 0, result.err);
		assert.match(result.out, /--check ok, everything carries 1\.1\.0/);
	});

	test("--preflight: `## Unreleased` passes quietly", () => {
		const dir = repo();
		assert.equal(run(dir).code, 0);
		writeFileSync(
			join(dir, "CHANGELOG.md"),
			`## Unreleased\n\n- next\n\n${read(dir, "CHANGELOG.md")}`,
		);
		const result = run(dir, "--preflight", "--strict");
		assert.equal(result.code, 0, result.err);
		assert.equal(result.err, "");
	});

	test("--preflight with no notes: a warning, or with --strict a failure", () => {
		const dir = repo();
		assert.equal(run(dir).code, 0); // the 1.1.0 section is now on top, no `## Unreleased`

		const relaxed = run(dir, "--preflight");
		assert.equal(relaxed.code, 0);
		assert.match(relaxed.err, /warning — .*the next release goes out with no notes/);

		const strict = run(dir, "--preflight", "--strict");
		assert.equal(strict.code, 1);
		assert.match(
			strict.err,
			/the next release goes out with no notes — write them first/,
		);
	});

	test("--preflight fails on drift, like --check", () => {
		assertRefused(repo(), ["--preflight"], /packages\/a\/package\.json is "1\.0\.0"/);
	});
});

describe("workspace discovery", () => {
	test("--exclude leaves a member alone; one that matches nothing is refused", () => {
		const dir = repo();
		const result = run(dir, "--exclude", "./examples/demo/");
		assert.equal(result.code, 0, result.err);
		assert.equal(
			read(dir, "examples/demo/package.json"),
			WORKSPACE["examples/demo/package.json"],
		);
		assert.equal(
			read(dir, "packages/b/package.json"),
			SPACES({ name: "b", version: "1.1.0" }),
		);

		assertRefused(
			repo(),
			["--exclude", "examples/dmeo"],
			/--exclude examples\/dmeo matches no/,
		);
	});

	test("patterns it cannot read are refused rather than skipped", () => {
		const cases: [string, RegExp][] = [
			["packages:\n  - '!**/test/**'\n  - packages/*\n", /negated pattern/],
			["packages:\n  - packages/**\n", /not supported/],
			["packages:\n  - tools/*\n", /tools\/ does not exist/],
			[
				"packages:\n  - packages/notes\n",
				/packages\/notes\/package\.json does not exist/,
			],
			["packages: [packages/*]\n", /inline/],
			["packages:\nother: 1\n", /no entries/],
		];
		for (const [yaml, pattern] of cases) {
			assertRefused(repo({ "pnpm-workspace.yaml": yaml }), [], pattern);
		}
	});

	test("a declared workspace that matches no member is refused", () => {
		const dir = repo();
		mkdirSync(join(dir, "empty"));
		writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - empty/*\n");
		assertRefused(dir, [], /matched no directory with a package\.json/);
	});

	test("npm / yarn `workspaces` are refused, not read as a single package", () => {
		const dir = repo({
			"pnpm-workspace.yaml": null,
			"package.json": TABS({ version: "1.1.0", workspaces: ["packages/*"] }),
		});
		assertRefused(dir, [], /only pnpm workspaces/);
	});

	test("no workspace: the module and the changelog still carry the version", () => {
		for (const yaml of [null, "onlyBuiltDependencies:\n  - esbuild\n"]) {
			const dir = repo({ "pnpm-workspace.yaml": yaml });
			const report = syncVersions({
				root: dir,
				versionModules: ["packages/a/src/version.ts"],
				date: "2026-11-07",
			});
			assert.deepEqual(report.manifests, []);
			assert.deepEqual(
				report.changes.map((change) => change.path),
				["packages/a/src/version.ts", "CHANGELOG.md"],
			);
			assert.equal(
				read(dir, "packages/b/package.json"),
				WORKSPACE["packages/b/package.json"],
			);
			assertRefused(dir, ["--exclude", "packages/b"], /no workspace members/);
		}
	});
});

describe("refusals", () => {
	test("the root version must be there and be semver", () => {
		assertRefused(
			repo({ "package.json": TABS({ version: "1.1" }) }),
			[],
			/no semver "version"/,
		);
		assertRefused(
			repo({ "package.json": "{ nope" }),
			[],
			/package\.json is not a JSON object/,
		);
		assertRefused(repo({ "package.json": null }), [], /there is no package\.json/);
	});

	test("a version module that is missing, empty or doubled", () => {
		assertRefused(
			repo(),
			["--version-module", "nope.ts"],
			/--version-module nope\.ts does not exist/,
		);
		const none = repo({ "packages/a/src/version.ts": "export const NAME = 'a';\n" });
		assertRefused(none, VERSION_MODULE, /has no `export const VERSION/);
		const two = repo({
			"packages/a/src/version.ts":
				'export const VERSION = "1";\nexport const VERSION = "2";\n',
		});
		assertRefused(two, VERSION_MODULE, /2 `export const VERSION` declarations/);
	});

	test("a missing changelog names the way out; --no-changelog and --changelog take it", () => {
		assertRefused(
			repo({ "CHANGELOG.md": null }),
			[],
			/CHANGELOG\.md does not exist.*--no-changelog/,
		);

		const none = repo({ "CHANGELOG.md": null });
		assert.equal(run(none, "--no-changelog").code, 0);
		assert.equal(
			read(none, "packages/b/package.json"),
			SPACES({ name: "b", version: "1.1.0" }),
		);

		const moved = repo({
			"CHANGELOG.md": null,
			"docs/CHANGES.md": WORKSPACE["CHANGELOG.md"] ?? "",
		});
		assert.equal(run(moved, "--changelog", "docs/CHANGES.md").code, 0);
		assert.match(read(moved, "docs/CHANGES.md"), /^## 1\.1\.0 — /m);
	});

	test("two `## Unreleased`, or one below a release, are refused in every mode", () => {
		const twice = `${WORKSPACE["CHANGELOG.md"]}\n## Unreleased\n`;
		const below = "## 1.0.0 — 2026-01-01\n\n## Unreleased\n";
		for (const argv of [[], ["--check"], ["--preflight"]]) {
			assertRefused(
				repo({ "CHANGELOG.md": twice }),
				argv,
				/2 "## Unreleased" sections/,
			);
			assertRefused(
				repo({ "CHANGELOG.md": below }),
				argv,
				/is not the newest section/,
			);
		}
	});

	test("SyncError carries every problem, in order", () => {
		const dir = repo({ "CHANGELOG.md": "## 1.0.0\n" });
		assert.throws(
			() => syncVersions({ root: dir, mode: "check" }),
			(error: unknown) =>
				error instanceof SyncError &&
				error.problems.length === 4 &&
				/newest section/.test(error.problems.at(-1) ?? ""),
		);
		rmSync(dir, { recursive: true });
	});
});

describe("arguments", () => {
	test("an unknown flag, a stray argument and contradictory flags are refused", () => {
		assertRefused(repo(), ["--dry-run"], /--dry-run/);
		assertRefused(repo(), ["patch"], /patch/);
		assertRefused(repo(), ["--check", "--preflight"], /two modes/);
		assertRefused(
			repo(),
			["--check", "--strict"],
			/--strict has no meaning with --check/,
		);
		assertRefused(repo(), ["--changelog", "X.md", "--no-changelog"], /contradict/);
	});

	test("--help prints the usage and touches nothing", () => {
		const dir = repo();
		const before = snapshot(dir);
		const result = run(dir, "--help");
		assert.equal(result.code, 0);
		assert.match(result.out, /^Usage: sync-versions/);
		assert.deepEqual(snapshot(dir), before);
	});
});
