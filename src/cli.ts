/**
 * The `sync-versions` command: flags in, {@link syncVersions} run, lines out, an exit code
 * back. `main` never exits the process itself, so a test can drive it in-process.
 */

import process from "node:process";
import { parseArgs } from "node:util";
import { type Mode, SyncError, syncVersions } from "./sync-versions.ts";

export const USAGE = `Usage: sync-versions [--check | --preflight] [options]

Carry the root package.json version into every pnpm workspace member that has a
version, each --version-module, and the changelog: "## Unreleased" becomes
"## <version> — <date>". Run it from the repository root.

Modes (default: write, the release tool's --before-commit step):
  --check                  Verify only: exit 1 on drift, write nothing.
  --preflight              Before a release: --check, and warn (fail, with
                           --strict) when there is no "## Unreleased" section.

Options:
  --strict                 Refuse a release with no "## Unreleased" section.
                           Without it, the version is stamped with a line
                           saying no notes were written, and a warning.
  --exclude <dir>          A workspace member to leave alone (repeatable).
  --version-module <path>  A file with one \`export const VERSION = "…"\`
                           to carry the version into (repeatable).
  --changelog <path>       The changelog (default: CHANGELOG.md).
  --no-changelog           There is no changelog.
  -h, --help               Show this help.`;

/** Where `main` reads its working directory from and writes its lines to. */
export interface Io {
	cwd: string;
	out: (line: string) => void;
	err: (line: string) => void;
}

const defaultIo = (): Io => ({
	cwd: process.cwd(),
	out: (line) => console.log(line),
	err: (line) => console.error(line),
});

const OPTIONS = {
	check: { type: "boolean" },
	preflight: { type: "boolean" },
	strict: { type: "boolean" },
	exclude: { type: "string", multiple: true },
	"version-module": { type: "string", multiple: true },
	changelog: { type: "string" },
	"no-changelog": { type: "boolean" },
	help: { type: "boolean", short: "h" },
} as const;

/** Unknown options and positional arguments throw: a typo must never run as a release step. */
const parse = (argv: readonly string[]) =>
	parseArgs({
		args: [...argv],
		options: OPTIONS,
		strict: true,
		allowPositionals: false,
	});

/** Run the command with `argv` (no node / script prefix); returns the exit code. */
export function main(argv: readonly string[], io: Io = defaultIo()): number {
	const fail = (message: string): number => {
		io.err(`sync-versions: ${message}`);
		return 1;
	};

	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(argv);
	} catch (error) {
		return fail(`${(error as Error).message} — see sync-versions --help.`);
	}
	const { values } = parsed;

	if (values.help) {
		io.out(USAGE);
		return 0;
	}
	if (values.check && values.preflight) {
		return fail("--check and --preflight are two modes; pass one.");
	}
	if (values.changelog !== undefined && values["no-changelog"]) {
		return fail("--changelog and --no-changelog contradict each other; pass one.");
	}

	const mode: Mode = values.check ? "check" : values.preflight ? "preflight" : "write";
	try {
		const report = syncVersions({
			root: io.cwd,
			mode,
			strict: values.strict ?? false,
			exclude: values.exclude ?? [],
			versionModules: values["version-module"] ?? [],
			changelog: values["no-changelog"]
				? false
				: (values.changelog ?? "CHANGELOG.md"),
		});
		for (const warning of report.warnings)
			io.err(`sync-versions: warning — ${warning}`);
		if (mode !== "write") {
			io.out(`sync-versions: --${mode} ok, everything carries ${report.version}`);
		} else if (report.changes.length === 0) {
			io.out(`sync-versions: everything already carries ${report.version}`);
		}
		for (const { path, from, to } of report.changes) {
			io.out(`sync-versions: ${path} ${from} → ${to}`);
		}
		return 0;
	} catch (error) {
		if (!(error instanceof SyncError)) throw error;
		for (const problem of error.problems) io.err(`sync-versions: ${problem}`);
		return 1;
	}
}
