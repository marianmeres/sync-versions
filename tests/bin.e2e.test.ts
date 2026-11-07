// The real process: `node src/bin.ts` spawned in a throwaway repository, so the exit code a
// release tool's --before-commit hook sees is the one checked.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

function bin(cwd: string, ...args: string[]) {
	return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
}

function workspace(memberVersion: string): string {
	const dir = mkdtempSync(join(tmpdir(), "sync-versions-bin-"));
	mkdirSync(join(dir, "packages/a"), { recursive: true });
	writeFileSync(join(dir, "package.json"), '{\n  "version": "2.0.0"\n}\n');
	writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
	writeFileSync(
		join(dir, "packages/a/package.json"),
		`{\n  "version": "${memberVersion}"\n}\n`,
	);
	writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\n- new\n");
	return dir;
}

test("drift exits 1 under --check, and the write mode exits 0 having fixed it", () => {
	const dir = workspace("1.0.0");

	const checked = bin(dir, "--check");
	assert.equal(checked.status, 1);
	assert.match(checked.stderr, /packages\/a\/package\.json is "1\.0\.0"/);

	const written = bin(dir);
	assert.equal(written.status, 0, written.stderr);
	assert.equal(
		readFileSync(join(dir, "packages/a/package.json"), "utf8"),
		'{\n  "version": "2.0.0"\n}\n',
	);

	assert.equal(bin(dir, "--check").status, 0);
});

test("a refusal exits 1, and --help exits 0", () => {
	const dir = workspace("1.0.0");
	const refused = bin(dir, "--bogus");
	assert.equal(refused.status, 1);
	assert.match(refused.stderr, /--bogus/);

	const help = bin(dir, "-h");
	assert.equal(help.status, 0);
	assert.match(help.stdout, /^Usage: sync-versions/);
});
