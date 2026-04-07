import assert from "node:assert";
import { execSync as execSyncChild, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import type { Proposal, RoadmapConfig } from "../../src/types/index.ts";
import {
	createUniqueTestDir,
	execSync,
	safeCleanup,
} from "../support/test-utils.ts";

const CLI_PATH =
	process.env.TUI_TEST_CLI_PATH?.trim() || join(process.cwd(), "src", "cli.ts");
const CLI_RUNTIME = process.env.TUI_TEST_CLI_RUNTIME?.trim() ?? "bun";
const TRANSCRIPT_DIR = join(
	process.cwd(),
	"tmp",
	"tui-interactive-transcripts",
);
const EXPECT_PATH =
	execSyncChild("which expect || echo ''", { encoding: "utf-8" }).trim() ||
	null;
const RUN_INTERACTIVE_TUI_TESTS = process.env.RUN_INTERACTIVE_TUI_TESTS === "1";

function getSkipReason(): string | null {
	if (process.platform === "win32") {
		return "interactive PTY tests require a Unix-like environment";
	}
	if (!RUN_INTERACTIVE_TUI_TESTS) {
		return "set RUN_INTERACTIVE_TUI_TESTS=1 to enable interactive PTY tests";
	}
	if (!EXPECT_PATH) {
		return "expect is not installed";
	}
	return null;
}

const skipReason = getSkipReason();
if (skipReason) {
	console.warn(
		`[tui-interactive] Skipping interactive editor handoff tests: ${skipReason}`,
	);
}
const itInteractive = skipReason ? it.skip : it;

interface InteractiveEditRunOptions {
	scenario: string;
	cliArgs: string[];
	proposalTitle: string;
	readyPattern: string;
}

interface InteractiveEditRunResult {
	proposalContent: string;
	transcriptPath: string;
	editorMarker: string;
	editorInputLog: string;
}

function buildSpawnCommand(cliArgs: string[]): string {
	const argsSegment = cliArgs.map((arg) => `"${arg}"`).join(" ");
	if (CLI_RUNTIME.length === 0) {
		return `spawn {${CLI_PATH}} ${argsSegment}`;
	}
	return `spawn {${CLI_RUNTIME}} {${CLI_PATH}} ${argsSegment}`;
}

async function runInteractiveEditScenario(
	options: InteractiveEditRunOptions,
): Promise<InteractiveEditRunResult> {
	const testDir = createUniqueTestDir(
		`test-tui-interactive-${options.scenario}`,
	);
	await mkdir(testDir, { recursive: true });
	await mkdir(TRANSCRIPT_DIR, { recursive: true });

	const transcriptPath = join(
		TRANSCRIPT_DIR,
		`${options.scenario}-${Date.now()}.log`,
	);
	const editorMarkerPath = join(
		testDir,
		`${options.scenario}-editor-marker.txt`,
	);
	const editorInputPath = join(testDir, `${options.scenario}-editor-input.log`);
	const editorScriptPath = join(testDir, `${options.scenario}-editor.cjs`);
	const expectScriptPath = join(testDir, `${options.scenario}.expect`);

	await writeFile(
		editorScriptPath,
		`const { appendFileSync, createReadStream } = require("node:fs");

const proposalFile = process.argv[2];
const markerFile = process.env.TUI_EDITOR_MARKER_FILE;
const keyLogFile = process.env.TUI_EDITOR_KEY_LOG_FILE;

if (markerFile) {
	appendFileSync(markerFile, "started\\n");
}
if (proposalFile) {
	appendFileSync(proposalFile, "\\nEdited in interactive TUI test\\n");
}

let input = process.stdin;
if (!input.isTTY) {
	try {
		input = createReadStream("/dev/tty");
	} catch {}
}
if (input.isTTY && typeof input.setRawMode === "function") {
	input.setRawMode(true);
}
input.resume();
input.on("data", (chunk) => {
	if (!keyLogFile) {
		return;
	}
	const bytes = Array.from(chunk.values());
	appendFileSync(keyLogFile, \`DATA:\${bytes.join(",")}\\n\`);
});
process.stdout.write("__EDITOR_READY__\\n");

setTimeout(() => {
	process.exit(0);
}, 1200);
`,
	);

	execSync(`git init -b main`, { cwd: testDir });
	execSync(`git config user.email test@example.com`, { cwd: testDir });
	execSync(`git config user.name "Test User"`, { cwd: testDir });

	const core = new Core(testDir);
	await core.initializeProject(`Interactive ${options.scenario}`);

	const config = await core.filesystem.loadConfig();
	if (!config) {
		throw new Error(`Failed to load config for scenario ${options.scenario}`);
	}

	const updatedConfig: RoadmapConfig = {
		...config,
		remoteOperations: false,
		checkActiveBranches: false,
		defaultEditor: `node ${editorScriptPath}`,
	};
	await core.filesystem.saveConfig(updatedConfig);

	const proposal: Proposal = {
		id: "proposal-1",
		title: options.proposalTitle,
		status: "Potential",
		assignee: [],
		createdDate: "2026-02-11 00:00",
		labels: [],
		dependencies: [],
		description: "TUI interactive editor test",
	};
	await core.createProposal(proposal, false);

	await writeFile(
		expectScriptPath,
		`#!/usr/bin/expect -f
set timeout 20
log_user 0
log_file -a {${transcriptPath}}
set env(TERM) {xterm-256color}
set env(COLUMNS) {120}
set env(LINES) {40}
set env(NO_COLOR) {1}
set env(EDITOR) {node ${editorScriptPath}}
set env(TUI_EDITOR_MARKER_FILE) {${editorMarkerPath}}
set env(TUI_EDITOR_KEY_LOG_FILE) {${editorInputPath}}
${buildSpawnCommand(options.cliArgs)}
expect {
	-re {${options.readyPattern}} {}
	timeout { exit 91 }
}
sleep 0.5
send -- "E"
expect {
	-re {__EDITOR_READY__} {}
	timeout { exit 92 }
}
send -- "\\033\\[A"
sleep 0.2
send -- "q"
sleep 1.0
send -- "q"
sleep 2.0
send -- "\\003"
expect eof
set wait_status [wait]
set exit_code [lindex $wait_status 3]
exit $exit_code
`,
	);

	const child = spawn("expect", ["-f", expectScriptPath], {
		cwd: testDir,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const stdout = child.stdout?.toString() || "";
	const stderr = child.stderr?.toString() || "";
	const exitCode = await new Promise<number>((resolve) => {
		child.on("close", (code) => resolve(code ?? 1));
	});
	const transcript = await readFile(transcriptPath, "utf-8").catch(
		() => "(no transcript captured)",
	);

	try {
		assert.ok([0, 130].includes(exitCode));
	} catch (_error) {
		throw new Error(
			`Interactive CLI run failed for ${options.scenario}.\n` +
				`Exit code: ${exitCode}\n` +
				`STDOUT:\n${stdout}\n` +
				`STDERR:\n${stderr}\n` +
				`Transcript: ${transcriptPath}\n` +
				`Transcript contents:\n${transcript}\n`,
		);
	}

	const markerContent = await readFile(editorMarkerPath, "utf8").catch(
		() => "",
	);
	const editorInputLog = await readFile(editorInputPath, "utf8").catch(
		() => "",
	);
	const proposalContent = await core.getProposalContent("proposal-1");

	await safeCleanup(testDir);
	return {
		proposalContent: proposalContent || "",
		transcriptPath,
		editorMarker: markerContent,
		editorInputLog,
	};
}

describe("interactive TUI editor handoff", () => {
	itInteractive(
		"launches terminal editor from board view and marks proposal updated",
		async () => {
			const result = await runInteractiveEditScenario({
				scenario: "board",
				cliArgs: ["board"],
				proposalTitle: "Board interactive editor proposal",
				readyPattern: "Roadmap Board",
			});

			assert.ok(result.editorMarker.includes("started"));
			assert.ok(result.editorInputLog.includes("DATA:27,91,65"));
			assert.ok(
				result.proposalContent.includes("Edited in interactive TUI test"),
			);
			assert.ok(result.transcriptPath.includes("tui-interactive-transcripts"));
		},
	);

	itInteractive(
		"launches terminal editor from proposal list view and marks proposal updated",
		async () => {
			const result = await runInteractiveEditScenario({
				scenario: "proposal-list",
				cliArgs: ["proposal", "list"],
				proposalTitle: "Proposal list interactive editor proposal",
				readyPattern: "Proposals",
			});

			assert.ok(result.editorMarker.includes("started"));
			assert.ok(result.editorInputLog.includes("DATA:27,91,65"));
			assert.ok(
				result.proposalContent.includes("Edited in interactive TUI test"),
			);
			assert.ok(result.transcriptPath.includes("tui-interactive-transcripts"));
		},
	);
});
