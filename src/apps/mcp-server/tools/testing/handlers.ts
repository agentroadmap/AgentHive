/**
 * MCP Tool Handlers for Testing Tools
 */

import { join } from "node:path";
import {
	addIssue,
	formatIssues,
	getBlockingIssues,
	type IssueSeverity,
	loadIssues,
	resolveIssue,
	saveIssues,
} from "../../../../core/pipeline/issue-tracker.ts";
import type { TestFile } from "../../../../core/pipeline/test-discovery.ts";
import {
	discoverTests,
	filterByCategory,
	getTestStats,
	type TestCategory,
} from "../../../../core/pipeline/test-discovery.ts";
import {
	allTestsPassed,
	formatTestReport,
	runTests,
	type TestRunOptions,
} from "../../../../core/pipeline/test-runner.ts";
import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";

export interface TestDiscoverArgs {
	testDir?: string;
	category?: TestCategory;
}

export interface TestRunArgs {
	files?: string[];
	category?: TestCategory;
	timeout?: number;
	testDir?: string;
}

export interface TestIssuesArgs {
	proposalId?: string;
	status?: string;
	severity?: string;
}

export interface TestIssueCreateArgs {
	proposalId: string;
	title: string;
	severity: IssueSeverity;
	testFile: string;
	description?: string;
}

export interface TestIssueResolveArgs {
	issueId: string;
	resolution: string;
}

export class TestHandlers {
	private readonly server: McpServer;

	constructor(server: McpServer) {
		this.server = server;
	}

	private getProjectRoot(): string {
		return this.server.fs.rootDir;
	}

	private getDefaultTestDir(): string {
		return join(this.getProjectRoot(), "src", "test");
	}

	/**
	 * Discover tests in the project.
	 */
	async discoverTests(args: TestDiscoverArgs): Promise<CallToolResult> {
		const testDir = args.testDir || this.getDefaultTestDir();
		const result = await discoverTests(testDir);

		let tests = result.tests;
		if (args.category) {
			tests = filterByCategory(result, args.category);
		}

		const stats = getTestStats(result);
		const testList = tests
			.map((t: TestFile) => `  ${t.category}: ${t.name}`)
			.join("\n");

		return {
			content: [
				{
					type: "text",
					text: `Test Discovery Results\n=======================\n\n${stats}\n\nDiscovered Tests:\n${testList || "  (none)"}`,
				},
			],
		};
	}

	/**
	 * Run discovered tests.
	 */
	async runTests(args: TestRunArgs): Promise<CallToolResult> {
		const testDir = args.testDir || this.getDefaultTestDir();
		const discovery = await discoverTests(testDir);

		let testFiles = discovery.tests;
		if (args.category) {
			testFiles = filterByCategory(discovery, args.category);
		}

		const options: TestRunOptions = {
			files: args.files,
			timeout: args.timeout || 30000,
		};

		const report = await runTests(testFiles, options);
		const output = formatTestReport(report);

		return {
			content: [
				{
					type: "text",
					text: output,
				},
			],
			isError: !allTestsPassed(report),
		};
	}

	/**
	 * List test issues.
	 */
	async listIssues(args: TestIssuesArgs): Promise<CallToolResult> {
		const store = loadIssues(this.getProjectRoot());
		let issues = store.issues;

		if (args.proposalId) {
			issues = issues.filter((i) => i.proposalId === args.proposalId);
		}
		if (args.status) {
			issues = issues.filter((i) => i.status === args.status);
		}
		if (args.severity) {
			issues = issues.filter((i) => i.severity === args.severity);
		}

		const output =
			issues.length > 0 ? formatIssues(issues) : "No issues found.";

		return {
			content: [
				{
					type: "text",
					text: `Test Issues (${issues.length})\n${"=".repeat(40)}\n\n${output}`,
				},
			],
		};
	}

	/**
	 * Create a new test issue.
	 */
	async createIssue(args: TestIssueCreateArgs): Promise<CallToolResult> {
		const store = loadIssues(this.getProjectRoot());
		const newStore = addIssue(store, {
			id: "",
			proposalId: args.proposalId,
			title: args.title,
			description: args.description,
			severity: args.severity,
			testFile: args.testFile,
			discoveredAt: new Date().toISOString(),
			status: "open",
		});

		const created = newStore.issues.at(-1);
		saveIssues(this.getProjectRoot(), newStore);
		if (!created) {
			return {
				content: [{ type: "text", text: "Failed to create issue" }],
				isError: true,
			};
		}

		return {
			content: [
				{
					type: "text",
					text: `Created issue ${created.id}\n\nTitle: ${created.title}\nSeverity: ${created.severity}\nProposal: ${created.proposalId}\nTest: ${created.testFile}`,
				},
			],
		};
	}

	/**
	 * Resolve a test issue.
	 */
	async resolveIssue(args: TestIssueResolveArgs): Promise<CallToolResult> {
		const store = loadIssues(this.getProjectRoot());
		const issue = store.issues.find((i) => i.id === args.issueId);

		if (!issue) {
			return {
				content: [{ type: "text", text: `Issue not found: ${args.issueId}` }],
				isError: true,
			};
		}

		const newStore = resolveIssue(store, args.issueId, args.resolution);
		saveIssues(this.getProjectRoot(), newStore);

		return {
			content: [
				{
					type: "text",
					text: `Resolved issue ${args.issueId}\n\nResolution: ${args.resolution}`,
				},
			],
		};
	}

	/**
	 * Check if a proposal is blocked by issues.
	 */
	async checkBlocked(args: { proposalId: string }): Promise<CallToolResult> {
		const store = loadIssues(this.getProjectRoot());
		const blocking = getBlockingIssues(store, args.proposalId);

		if (blocking.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `Proposal ${args.proposalId} is not blocked by any open issues.`,
					},
				],
			};
		}

		const output = formatIssues(blocking);
		return {
			content: [
				{
					type: "text",
					text: `Proposal ${args.proposalId} is BLOCKED by ${blocking.length} issue(s):\n\n${output}`,
				},
			],
			isError: true,
		};
	}
}
