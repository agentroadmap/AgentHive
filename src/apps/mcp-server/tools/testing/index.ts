/**
 * Testing MCP Tools Registration
 *
 * Provides tools for AI agents to programmatically discover, run,
 * and track tests across the project.
 */

import type { McpServer } from "../../server.ts";
import type { McpToolHandler } from "../../types.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import { TestHandlers } from "./handlers.ts";
import {
	testDiscoverSchema,
	testIssueCreateSchema,
	testIssueResolveSchema,
	testIssuesSchema,
	testRunSchema,
} from "./schemas.ts";

export function registerTestingTools(server: McpServer): void {
	const handlers = new TestHandlers(server);

	const testDiscoverTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "test_discover",
			description:
				"Discover test files in the project and categorize by type (unit, integration, e2e, regression)",
			inputSchema: testDiscoverSchema,
		},
		testDiscoverSchema,
		async (input) =>
			handlers.discoverTests(
				input as {
					testDir?: string;
					category?: "unit" | "integration" | "e2e" | "regression";
				},
			),
	);

	const testRunTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "test_run",
			description:
				"Run discovered tests with optional filtering by category or specific files",
			inputSchema: testRunSchema,
		},
		testRunSchema,
		async (input) =>
			handlers.runTests(
				input as {
					files?: string[];
					category?: "unit" | "integration" | "e2e" | "regression";
					timeout?: number;
					testDir?: string;
				},
			),
	);

	const testIssuesTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "test_issues",
			description:
				"List test issues (bugs/regressions) tracked against proposals",
			inputSchema: testIssuesSchema,
		},
		testIssuesSchema,
		async (input) =>
			handlers.listIssues(
				input as { proposalId?: string; status?: string; severity?: string },
			),
	);

	const testIssueCreateTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "test_issue_create",
			description: "Create a new test issue linked to a proposal",
			inputSchema: testIssueCreateSchema,
		},
		testIssueCreateSchema,
		async (input) =>
			handlers.createIssue(
				input as {
					proposalId: string;
					title: string;
					severity: "critical" | "major" | "minor";
					testFile: string;
					description?: string;
				},
			),
	);

	const testIssueResolveTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "test_issue_resolve",
			description: "Resolve a test issue with resolution notes",
			inputSchema: testIssueResolveSchema,
		},
		testIssueResolveSchema,
		async (input) =>
			handlers.resolveIssue(input as { issueId: string; resolution: string }),
	);

	const testCheckBlockedTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "test_check_blocked",
			description:
				"Check if a proposal is blocked by open critical/major test issues",
			inputSchema: {
				properties: {
					proposalId: {
						type: "string",
						description: "Proposal ID to check",
					},
				},
				required: ["proposalId"],
			},
		},
		{
			properties: { proposalId: { type: "string" } },
			required: ["proposalId"],
		},
		async (input) => handlers.checkBlocked(input as { proposalId: string }),
	);

	server.addTool(testDiscoverTool);
	server.addTool(testRunTool);
	server.addTool(testIssuesTool);
	server.addTool(testIssueCreateTool);
	server.addTool(testIssueResolveTool);
	server.addTool(testCheckBlockedTool);
}
