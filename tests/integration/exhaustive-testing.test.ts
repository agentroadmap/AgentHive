/**
 * Tests for Exhaustive Product-Level Testing Framework
 * Covers: test-discovery, test-runner, issue-tracker, acceptance integration
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
// Issue tracker
import {
	addIssue,
	createIssue,
	formatIssues,
	getBlockingIssues,
	getProposalIssues,
	isBlockedByIssues,
	loadIssues,
	resolveIssue,
	saveIssues,
	wontFixIssue,
} from "../../src/core/pipeline/issue-tracker.ts";
// Test discovery
import {
	categorizeTestFile,
	discoverTests,
	filterByCategory,
	getTestStats,
	scanTestDirectory,
} from "../../src/core/pipeline/test-discovery.ts";
// Test runner
import {
	allTestsPassed,
	formatTestReport,
	runTestFile,
} from "../../src/core/pipeline/test-runner.ts";
// Acceptance integration
import {
	validateNoBlockingIssues,
	validateReachedTransition,
} from "../../src/core/proposal/acceptance.ts";
import { Core } from "../../src/core/roadmap.ts";
import {
	createUniqueTestDir,
	execSync,
	safeCleanup,
} from "../support/test-utils.ts";

// --- Test Discovery Tests ---

describe("Test Discovery", () => {
	describe("categorizeTestFile", () => {
		it("categorizes regression tests", () => {
			assert.equal(
				categorizeTestFile("regression-issue-123.test.ts"),
				"regression",
			);
		});

		it("categorizes e2e tests", () => {
			assert.equal(categorizeTestFile("e2e-workflow.test.ts"), "e2e");
		});

		it("categorizes cli tests as integration", () => {
			assert.equal(categorizeTestFile("cli-search.test.ts"), "integration");
		});

		it("categorizes mcp tests as integration", () => {
			assert.equal(categorizeTestFile("mcp-proposals.test.ts"), "integration");
		});

		it("categorizes board tests as integration", () => {
			assert.equal(categorizeTestFile("board-render.test.ts"), "integration");
		});

		it("categorizes plain tests as unit", () => {
			assert.equal(categorizeTestFile("markdown.test.ts"), "unit");
			assert.equal(categorizeTestFile("git.test.ts"), "unit");
		});

		it("handles paths with directories", () => {
			assert.equal(
				categorizeTestFile("/some/path/cli-foo.test.ts"),
				"integration",
			);
		});
	});

	describe("scanTestDirectory", () => {
		let testDir: string;

		beforeEach(() => {
			testDir = join(tmpdir(), `test-discovery-${Date.now()}`);
			mkdirSync(testDir, { recursive: true });
		});

		afterEach(() => {
			rmSync(testDir, { recursive: true, force: true });
		});

		it("finds test files in directory", async () => {
			writeFileSync(join(testDir, "unit.test.ts"), "test");
			writeFileSync(join(testDir, "cli-integration.test.ts"), "test");

			const results = await scanTestDirectory(testDir);
			assert.equal(results.length, 2);
		});

		it("categorizes discovered files", async () => {
			writeFileSync(join(testDir, "unit.test.ts"), "test");
			writeFileSync(join(testDir, "cli-integration.test.ts"), "test");

			const results = await scanTestDirectory(testDir);
			const unit = results.find((r) => r.name === "unit.test.ts");
			const integration = results.find(
				(r) => r.name === "cli-integration.test.ts",
			);

			assert.equal(unit?.category, "unit");
			assert.equal(integration?.category, "integration");
		});

		it("scans subdirectories recursively", async () => {
			const subDir = join(testDir, "sub");
			mkdirSync(subDir, { recursive: true });
			writeFileSync(join(testDir, "root.test.ts"), "test");
			writeFileSync(join(subDir, "sub.test.ts"), "test");

			const results = await scanTestDirectory(testDir);
			assert.equal(results.length, 2);
		});

		it("skips node_modules", async () => {
			const nodeModules = join(testDir, "node_modules");
			mkdirSync(nodeModules, { recursive: true });
			writeFileSync(join(testDir, "root.test.ts"), "test");
			writeFileSync(join(nodeModules, "skipped.test.ts"), "test");

			const results = await scanTestDirectory(testDir);
			assert.equal(results.length, 1);
			assert.equal(results[0]?.name, "root.test.ts");
		});

		it("returns empty for non-existent directory", async () => {
			const results = await scanTestDirectory("/nonexistent/path");
			assert.equal(results.length, 0);
		});
	});

	describe("discoverTests", () => {
		let testDir: string;

		beforeEach(() => {
			testDir = join(tmpdir(), `test-discover-${Date.now()}`);
			mkdirSync(testDir, { recursive: true });
		});

		afterEach(() => {
			rmSync(testDir, { recursive: true, force: true });
		});

		it("groups tests by category", async () => {
			writeFileSync(join(testDir, "unit.test.ts"), "test");
			writeFileSync(join(testDir, "cli-integration.test.ts"), "test");
			writeFileSync(join(testDir, "e2e-workflow.test.ts"), "test");
			writeFileSync(join(testDir, "regression-bug.test.ts"), "test");

			const result = await discoverTests(testDir);

			assert.equal(result.total, 4);
			assert.equal(result.byCategory.unit.length, 1);
			assert.equal(result.byCategory.integration.length, 1);
			assert.equal(result.byCategory.e2e.length, 1);
			assert.equal(result.byCategory.regression.length, 1);
		});

		it("includes discovery timestamp", async () => {
			const result = await discoverTests(testDir);
			assert.ok(result.discoveredAt);
		});
	});

	describe("filterByCategory", () => {
		it("filters tests by category", async () => {
			const testDir = join(tmpdir(), `test-filter-${Date.now()}`);
			mkdirSync(testDir, { recursive: true });
			writeFileSync(join(testDir, "unit.test.ts"), "test");
			writeFileSync(join(testDir, "cli-integration.test.ts"), "test");

			const result = await discoverTests(testDir);
			const unitTests = filterByCategory(result, "unit");

			assert.equal(unitTests.length, 1);
			assert.equal(unitTests[0]?.name, "unit.test.ts");

			rmSync(testDir, { recursive: true, force: true });
		});
	});

	describe("getTestStats", () => {
		it("returns formatted statistics", async () => {
			const testDir = join(tmpdir(), `test-stats-${Date.now()}`);
			mkdirSync(testDir, { recursive: true });
			writeFileSync(join(testDir, "unit.test.ts"), "test");
			writeFileSync(join(testDir, "cli-integration.test.ts"), "test");

			const result = await discoverTests(testDir);
			const stats = getTestStats(result);

			assert.ok(stats.includes("Total tests: 2"));
			assert.ok(stats.includes("Unit: 1"));
			assert.ok(stats.includes("Integration: 1"));

			rmSync(testDir, { recursive: true, force: true });
		});
	});
});

// --- Test Runner Tests ---

describe("Test Runner", () => {
	describe("runTestFile", () => {
		it("runs a passing test file", async () => {
			const testDir = join(tmpdir(), `test-runner-${Date.now()}`);
			mkdirSync(testDir, { recursive: true });
			const testFile = join(testDir, "passing.test.js");
			writeFileSync(
				testFile,
				`
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
describe("passing", () => {
	it("should pass", () => { assert.equal(1, 1); });
});
`,
			);

			const result = await runTestFile(testFile, { timeout: 10000 });
			assert.equal(result.passed, true);
			assert.equal(result.exitCode, 0);

			rmSync(testDir, { recursive: true, force: true });
		});

		it("does not treat successful output containing 'fail 0' as a failure", async () => {
			const testDir = join(tmpdir(), `test-runner-output-${Date.now()}`);
			mkdirSync(testDir, { recursive: true });
			const testFile = join(testDir, "passing-output.test.js");
			writeFileSync(
				testFile,
				`
const { describe, it } = require("node:test");
describe("passing output", () => {
	it("logs summary-like text", () => {
		console.log("fail 0");
	});
});
`,
			);

			const result = await runTestFile(testFile, { timeout: 10000 });
			assert.equal(result.passed, true);
			assert.equal(result.exitCode, 0);

			rmSync(testDir, { recursive: true, force: true });
		});

		it("returns valid result structure", async () => {
			const testDir = join(tmpdir(), `test-runner-struct-${Date.now()}`);
			mkdirSync(testDir, { recursive: true });
			const testFile = join(testDir, "simple.test.js");
			writeFileSync(
				testFile,
				`
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
describe("simple", () => {
	it("works", () => { assert.equal(1, 1); });
});
`,
			);

			const result = await runTestFile(testFile, { timeout: 10000 });
			// Verify result structure regardless of pass/fail detection
			// (subprocess output detection is tested via formatTestReport/allTestsPassed)
			assert.ok(result.file);
			assert.ok(typeof result.passed === "boolean");
			assert.ok(typeof result.exitCode === "number");
			assert.ok(typeof result.duration === "number");
			assert.ok(result.duration > 0);
			assert.ok(typeof result.stdout === "string");
			assert.ok(typeof result.stderr === "string");

			rmSync(testDir, { recursive: true, force: true });
		});
	});

	describe("formatTestReport", () => {
		it("formats passing report", () => {
			const report = {
				results: [
					{
						file: "test1.test.ts",
						passed: true,
						exitCode: 0,
						stdout: "",
						stderr: "",
						duration: 100,
					},
				],
				summary: { total: 1, passed: 1, failed: 0, errors: 0 },
				totalDuration: 100,
				startedAt: "2026-03-21T00:00:00Z",
				completedAt: "2026-03-21T00:00:01Z",
			};

			const output = formatTestReport(report);
			assert.ok(output.includes("1/1 passed"));
		});

		it("formats failing report with details", () => {
			const report = {
				results: [
					{
						file: "test1.test.ts",
						passed: false,
						exitCode: 1,
						stdout: "",
						stderr: "assertion failed",
						duration: 100,
						error: "Test failed",
					},
				],
				summary: { total: 1, passed: 0, failed: 1, errors: 0 },
				totalDuration: 100,
				startedAt: "2026-03-21T00:00:00Z",
				completedAt: "2026-03-21T00:00:01Z",
			};

			const output = formatTestReport(report);
			assert.ok(output.includes("0/1 passed"));
			assert.ok(output.includes("Failed Tests"));
		});
	});

	describe("allTestsPassed", () => {
		it("returns true when all pass", () => {
			const report = {
				results: [
					{
						file: "test1.test.ts",
						passed: true,
						exitCode: 0,
						stdout: "",
						stderr: "",
						duration: 100,
					},
				],
				summary: { total: 1, passed: 1, failed: 0, errors: 0 },
				totalDuration: 100,
				startedAt: "",
				completedAt: "",
			};
			assert.equal(allTestsPassed(report), true);
		});

		it("returns false when any fail", () => {
			const report = {
				results: [
					{
						file: "test1.test.ts",
						passed: true,
						exitCode: 0,
						stdout: "",
						stderr: "",
						duration: 100,
					},
					{
						file: "test2.test.ts",
						passed: false,
						exitCode: 1,
						stdout: "",
						stderr: "",
						duration: 100,
					},
				],
				summary: { total: 2, passed: 1, failed: 1, errors: 0 },
				totalDuration: 200,
				startedAt: "",
				completedAt: "",
			};
			assert.equal(allTestsPassed(report), false);
		});
	});
});

describe("Complete issue enforcement", () => {
	let projectDir: string;
	let core: Core;

	beforeEach(async () => {
		projectDir = createUniqueTestDir("test-exhaustive-gate");
		mkdirSync(projectDir, { recursive: true });

		execSync(`git init -b main`, { cwd: projectDir });
		execSync(`git config user.name "Test User"`, { cwd: projectDir });
		execSync(`git config user.email test@example.com`, { cwd: projectDir });

		core = new Core(projectDir);
		await core.initializeProject("Exhaustive Gate Test Project");
	});

	afterEach(async () => {
		await safeCleanup(projectDir);
	});

	it("blocks transitioning a proposal to Complete when blocking issues exist", async () => {
		await core.createProposal(
			{
				id: "proposal-1",
				title: "Issue-blocked proposal",
				status: "Active",
				assignee: [],
				createdDate: "2026-03-21",
				labels: [],
				dependencies: [],
				rawContent: "Proposal description",
			},
			false,
		);

		let store = loadIssues(projectDir);
		store = addIssue(
			store,
			createIssue(
				"proposal-1",
				"Critical integration regression",
				"critical",
				"critical.test.ts",
			),
		);
		saveIssues(projectDir, store);

		await assert.rejects(
			core.editProposalOrDraft(
				"proposal-1",
				{
					status: "Complete",
					maturity: "audited",
					addProof: ["integration run"],
					finalSummary: "Complete summary",
				},
				false,
			),
			/blocking issue/i,
		);
	});

	it("blocks completing a Complete proposal when blocking issues exist", async () => {
		await core.createProposal(
			{
				id: "proposal-1",
				title: "Complete blocked proposal",
				status: "Complete",
				maturity: "audited",
				assignee: [],
				createdDate: "2026-03-21",
				labels: [],
				dependencies: [],
				rawContent: "Proposal description",
				finalSummary: "Complete summary",
				proof: ["integration run"],
			},
			false,
		);

		let store = loadIssues(projectDir);
		store = addIssue(
			store,
			createIssue(
				"proposal-1",
				"Major regression remains open",
				"major",
				"major.test.ts",
			),
		);
		saveIssues(projectDir, store);

		await assert.rejects(
			core.completeProposal("proposal-1", false),
			/blocking issue/i,
		);
	});
});

// --- Issue Tracker Tests ---

describe("Issue Tracker", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `test-issues-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("loadIssues / saveIssues", () => {
		it("returns empty store for new project", () => {
			const store = loadIssues(testDir);
			assert.equal(store.issues.length, 0);
		});

		it("persists issues to disk", () => {
			let store = loadIssues(testDir);
			store = addIssue(
				store,
				createIssue("proposal-1", "Bug found", "critical", "test.test.ts"),
			);
			saveIssues(testDir, store);

			const reloaded = loadIssues(testDir);
			assert.equal(reloaded.issues.length, 1);
			assert.equal(reloaded.issues[0]?.title, "Bug found");
		});
	});

	describe("addIssue", () => {
		it("assigns unique IDs", () => {
			let store = loadIssues(testDir);
			store = addIssue(
				store,
				createIssue("proposal-1", "Bug 1", "critical", "test.test.ts"),
			);
			store = addIssue(
				store,
				createIssue("proposal-1", "Bug 2", "major", "test.test.ts"),
			);

			assert.equal(store.issues[0]?.id, "ISSUE-proposal-1-1");
			assert.equal(store.issues[1]?.id, "ISSUE-proposal-1-2");
		});

		it("sets initial status to open", () => {
			let store = loadIssues(testDir);
			store = addIssue(
				store,
				createIssue("proposal-1", "Bug", "critical", "test.test.ts"),
			);

			assert.equal(store.issues[0]?.status, "open");
		});
	});

	describe("resolveIssue", () => {
		it("marks issue as resolved", () => {
			let store = loadIssues(testDir);
			store = addIssue(
				store,
				createIssue("proposal-1", "Bug", "critical", "test.test.ts"),
			);
			const first = store.issues[0];
			assert.ok(first);
			const issueId = first.id;

			store = resolveIssue(store, issueId, "Fixed in PR #42");

			assert.equal(store.issues[0]?.status, "resolved");
			assert.equal(store.issues[0]?.resolution, "Fixed in PR #42");
			assert.ok(store.issues[0]?.resolvedAt);
		});
	});

	describe("wontFixIssue", () => {
		it("marks issue as wontfix", () => {
			let store = loadIssues(testDir);
			store = addIssue(
				store,
				createIssue("proposal-1", "Bug", "minor", "test.test.ts"),
			);
			const first = store.issues[0];
			assert.ok(first);
			const issueId = first.id;

			store = wontFixIssue(store, issueId, "By design");

			assert.equal(store.issues[0]?.status, "wontfix");
		});
	});

	describe("getProposalIssues", () => {
		it("filters by proposal and open status", () => {
			let store = loadIssues(testDir);
			store = addIssue(
				store,
				createIssue("proposal-1", "Bug 1", "critical", "test.test.ts"),
			);
			store = addIssue(
				store,
				createIssue("proposal-2", "Bug 2", "critical", "test.test.ts"),
			);
			const first = store.issues[0];
			assert.ok(first);
			store = resolveIssue(store, first.id, "Fixed");

			const proposal1Issues = getProposalIssues(store, "proposal-1");
			assert.equal(proposal1Issues.length, 0); // resolved

			const proposal2Issues = getProposalIssues(store, "proposal-2");
			assert.equal(proposal2Issues.length, 1); // still open
		});
	});

	describe("getBlockingIssues", () => {
		it("returns only critical and major open issues", () => {
			let store = loadIssues(testDir);
			store = addIssue(
				store,
				createIssue("proposal-1", "Critical", "critical", "test.test.ts"),
			);
			store = addIssue(
				store,
				createIssue("proposal-1", "Major", "major", "test.test.ts"),
			);
			store = addIssue(
				store,
				createIssue("proposal-1", "Minor", "minor", "test.test.ts"),
			);

			const blocking = getBlockingIssues(store, "proposal-1");
			assert.equal(blocking.length, 2);
		});

		it("excludes resolved issues", () => {
			let store = loadIssues(testDir);
			store = addIssue(
				store,
				createIssue("proposal-1", "Critical", "critical", "test.test.ts"),
			);
			const first = store.issues[0];
			assert.ok(first);
			store = resolveIssue(store, first.id, "Fixed");

			const blocking = getBlockingIssues(store, "proposal-1");
			assert.equal(blocking.length, 0);
		});
	});

	describe("isBlockedByIssues", () => {
		it("returns true when critical issues exist", () => {
			let store = loadIssues(testDir);
			store = addIssue(
				store,
				createIssue("proposal-1", "Critical", "critical", "test.test.ts"),
			);

			assert.equal(isBlockedByIssues(store, "proposal-1"), true);
		});

		it("returns false when no blocking issues", () => {
			let store = loadIssues(testDir);
			store = addIssue(
				store,
				createIssue("proposal-1", "Minor", "minor", "test.test.ts"),
			);

			assert.equal(isBlockedByIssues(store, "proposal-1"), false);
		});
	});

	describe("formatIssues", () => {
		it("formats issues with severity icons", () => {
			const issue0 = createIssue(
				"proposal-1",
				"Critical bug",
				"critical",
				"test.test.ts",
			);
			const issue1 = createIssue(
				"proposal-1",
				"Major bug",
				"major",
				"test.test.ts",
			);
			issue0.id = "ISSUE-1";
			issue1.id = "ISSUE-2";

			const output = formatIssues([issue0, issue1]);
			assert.ok(output.includes("ISSUE-1"));
			assert.ok(output.includes("ISSUE-2"));
		});

		it("returns message for empty list", () => {
			assert.equal(formatIssues([]), "No issues found.");
		});
	});
});

// --- Acceptance Integration Tests ---

describe("Acceptance Integration", () => {
	describe("validateNoBlockingIssues", () => {
		it("returns not blocked when no issues", () => {
			const store = { issues: [], updatedAt: "" };
			const result = validateNoBlockingIssues(store, "proposal-1");

			assert.equal(result.blocked, false);
			assert.equal(result.issues.length, 0);
		});

		it("returns blocked when critical issues exist", () => {
			const store = {
				issues: [
					{
						id: "ISSUE-1",
						proposalId: "proposal-1",
						title: "Critical bug",
						severity: "critical" as const,
						testFile: "test.test.ts",
						discoveredAt: "",
						status: "open" as const,
					},
				],
				updatedAt: "",
			};

			const result = validateNoBlockingIssues(store, "proposal-1");
			assert.equal(result.blocked, true);
			assert.equal(result.issues.length, 1);
		});
	});

	describe("validateReachedTransition", () => {
		it("allows complete when all checks pass", () => {
			const store = { issues: [], updatedAt: "" };
			const result = validateReachedTransition([], [], store, "proposal-1");

			assert.equal(result.canReach, true);
			assert.equal(result.reasons.length, 0);
		});

		it("blocks complete when issues exist", () => {
			const store = {
				issues: [
					{
						id: "ISSUE-1",
						proposalId: "proposal-1",
						title: "Critical bug",
						severity: "critical" as const,
						testFile: "test.test.ts",
						discoveredAt: "",
						status: "open" as const,
					},
				],
				updatedAt: "",
			};

			const result = validateReachedTransition([], [], store, "proposal-1");
			assert.equal(result.canReach, false);
			assert.ok(result.reasons.some((r) => r.includes("Blocked by")));
		});
	});
});
