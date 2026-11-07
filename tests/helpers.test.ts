// The pure helpers: no file system, no process.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	changelogHeadings,
	changelogProblems,
	NO_NOTES,
	parseWorkspaceGlobs,
	readModuleVersion,
	SyncError,
	setManifestVersion,
	setModuleVersion,
	stampChangelog,
} from "../src/sync-versions.ts";

describe("parseWorkspaceGlobs", () => {
	test("reads the block list, quoted or not, with comments and blank lines", () => {
		const yaml = [
			"# the workspace",
			"packages:",
			"  - packages/*",
			'  - "examples/*" # the examples',
			"",
			"  - 'tools/cli'",
			"- docs",
			"onlyBuiltDependencies:",
			"  - esbuild",
		].join("\n");
		assert.deepEqual(parseWorkspaceGlobs(yaml), [
			"packages/*",
			"examples/*",
			"tools/cli",
			"docs",
		]);
	});

	test("no `packages:` key is not a workspace, and not an error", () => {
		assert.equal(
			parseWorkspaceGlobs("onlyBuiltDependencies:\n  - esbuild\n"),
			undefined,
		);
		assert.equal(parseWorkspaceGlobs(""), undefined);
	});

	test("a `packages:` key with nothing readable under it is a refusal", () => {
		assert.throws(() => parseWorkspaceGlobs("packages:\n\nother: 1\n"), SyncError);
		assert.throws(() => parseWorkspaceGlobs("packages:\n"), /no entries/);
	});

	test("the inline form and an unreadable entry are refusals, not skips", () => {
		assert.throws(() => parseWorkspaceGlobs("packages: [a, b]\n"), /inline/);
		assert.throws(
			() => parseWorkspaceGlobs('packages:\n  - "a b"\n'),
			/cannot read the `packages:` entry/,
		);
	});
});

describe("setManifestVersion", () => {
	test("replaces the version in place: indentation, key order and newline survive", () => {
		const tabs = '{\n\t"name": "a",\n\t"version": "1.0.0",\n\t"private": true\n}\n';
		assert.equal(
			setManifestVersion(tabs, "1.1.0"),
			'{\n\t"name": "a",\n\t"version": "1.1.0",\n\t"private": true\n}\n',
		);
		const compact = '{"version":"1.0.0","name":"b"}';
		assert.equal(
			setManifestVersion(compact, "2.0.0-rc.1"),
			'{"version":"2.0.0-rc.1","name":"b"}',
		);
	});

	test("a first `version` key that is not the top-level one is a refusal", () => {
		const nested = '{\n  "config": { "version": "9" },\n  "version": "1.0.0"\n}\n';
		assert.throws(
			() => setManifestVersion(nested, "1.1.0", "packages/x/package.json"),
			/packages\/x\/package\.json: rewriting its first "version" key/,
		);
	});
});

describe("module VERSION", () => {
	test("reads and replaces one export, keeping its quotes, annotation and spacing", () => {
		const double = '// v\nexport const VERSION = "1.0.0";\n';
		assert.equal(readModuleVersion(double), "1.0.0");
		assert.equal(
			setModuleVersion(double, "1.1.0"),
			'// v\nexport const VERSION = "1.1.0";\n',
		);

		const single = "export const VERSION: string  =  '1.0.0';\n";
		assert.equal(readModuleVersion(single), "1.0.0");
		assert.equal(
			setModuleVersion(single, "1.1.0"),
			"export const VERSION: string  =  '1.1.0';\n",
		);
	});

	test("none, or more than one, is a refusal", () => {
		assert.throws(
			() => readModuleVersion("export const NAME = 'x';\n", "v.ts"),
			/v\.ts has no/,
		);
		const two = 'export const VERSION = "1";\nexport const VERSION = "2";\n';
		assert.throws(
			() => setModuleVersion(two, "3", "v.ts"),
			/2 `export const VERSION`/,
		);
	});
});

describe("changelog", () => {
	const DATE = "2026-11-07";
	const WITH_NOTES =
		"# Changelog\n\n## Unreleased\n\n- new\n\n## 1.0.0 — 2026-01-01\n\n- old\n";
	const WITHOUT = "# Changelog\n\nIntro.\n\n## 1.0.0 — 2026-01-01\n\n- old\n";

	test("headings are read newest first, by their first token", () => {
		assert.deepEqual(changelogHeadings(WITH_NOTES), ["Unreleased", "1.0.0"]);
		assert.deepEqual(changelogHeadings("# Changelog\n"), []);
	});

	test("`## Unreleased` becomes the version's heading", () => {
		assert.deepEqual(stampChangelog(WITH_NOTES, "1.1.0", DATE), {
			text: "# Changelog\n\n## 1.1.0 — 2026-11-07\n\n- new\n\n## 1.0.0 — 2026-01-01\n\n- old\n",
			stamp: "unreleased",
		});
	});

	test("with no `## Unreleased`, a heading with no notes goes above the newest section", () => {
		assert.deepEqual(stampChangelog(WITHOUT, "1.1.0", DATE), {
			text:
				"# Changelog\n\nIntro.\n\n## 1.1.0 — 2026-11-07\n\n" +
				`${NO_NOTES}\n\n## 1.0.0 — 2026-01-01\n\n- old\n`,
			stamp: "no-notes",
		});
		// no sections at all: at the end; an empty file: the whole file
		assert.equal(
			stampChangelog("# Changelog\n", "0.1.0", DATE).text,
			`# Changelog\n\n## 0.1.0 — 2026-11-07\n\n${NO_NOTES}\n`,
		);
		assert.equal(
			stampChangelog("", "0.1.0", DATE).text,
			`## 0.1.0 — 2026-11-07\n\n${NO_NOTES}\n`,
		);
	});

	test("a changelog that already names the version is left alone", () => {
		assert.deepEqual(stampChangelog(WITHOUT, "1.0.0", DATE), {
			text: WITHOUT,
			stamp: "already",
		});
	});

	test("problems: two `## Unreleased`, one not on top, a released version below the top", () => {
		assert.deepEqual(changelogProblems(WITH_NOTES, "1.1.0"), []);
		// between releases, the current version under `## Unreleased` is the normal state
		assert.deepEqual(changelogProblems(WITH_NOTES, "1.0.0"), []);
		// when releasing, it means the version was not bumped
		assert.match(
			changelogProblems(WITH_NOTES, "1.0.0", "CHANGELOG.md", true)[0] ?? "",
			/already has a section for 1\.0\.0/,
		);
		assert.match(
			changelogProblems(`${WITH_NOTES}\n## Unreleased\n`, "1.1.0")[0] ?? "",
			/2 "## Unreleased" sections/,
		);
		assert.match(
			changelogProblems("## 1.0.0\n\n## Unreleased\n", "1.1.0")[0] ?? "",
			/"## Unreleased" is not the newest section/,
		);
	});
});
