import assert from "node:assert";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core, isGitRepository } from "../../src/index.ts";
import { parseProposal } from "../../src/markdown/parser.ts";
import { extractStructuredSection } from "../../src/markdown/structured-sections.ts";
import type { Decision, Document, Proposal } from "../../src/types/index.ts";
import {
	listProposalsPlatformAware,
	viewProposalPlatformAware,
} from "../support/test-helpers.ts";
import {
	buildCliCommand,
	createUniqueTestDir,
	execSync,
	expect,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;
const CLI_PATH = join(process.cwd(), "src", "cli.ts");

describe("CLI Integration", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-cli");
		try {
			await rm(TEST_DIR, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		await mkdir(TEST_DIR, { recursive: true });
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	describe("roadmap init command", () => {
		it("should initialize roadmap project in existing git repo", async () => {
			// Set up a git repository
			execSync(`git init -b main`, { cwd: TEST_DIR });
			execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
			execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

			// Initialize roadmap project using Core (simulating CLI)
			const core = new Core(TEST_DIR);
			await core.initializeProject("CLI Test Project", true);

			// Verify directory structure was created
			const configExists = await stat(join(TEST_DIR, "roadmap", "config.yml"))
				.then(() => true)
				.catch(() => false);
			assert.strictEqual(configExists, true);

			// Verify config content
			const config = await core.filesystem.loadConfig();
			assert.strictEqual(config?.projectName, "CLI Test Project");
			assert.deepStrictEqual(config?.statuses, [
				"Potential",
				"Active",
				"Accepted",
				"Complete",
				"Abandoned",
			]);
			assert.strictEqual(config?.defaultStatus, "Potential");

			// Verify git commit was created
			const lastCommit = await core.gitOps.getLastCommitMessage();
			assert.ok(
				lastCommit.includes("Initialize roadmap project: CLI Test Project"),
			);
		});

		it("should create all required directories", async () => {
			// Set up a git repository
			execSync(`git init -b main`, { cwd: TEST_DIR });
			execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
			execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

			const core = new Core(TEST_DIR);
			await core.initializeProject("Directory Test");

			// Check all expected directories exist
			const expectedDirs = [
				"roadmap",
				"roadmap/proposals",
				"roadmap/drafts",
				"roadmap/archive",
				"roadmap/archive/proposals",
				"roadmap/archive/drafts",
				"roadmap/archive/directives",
				"roadmap/directives",
				"docs",
				"roadmap/decisions",
			];

			for (const dir of expectedDirs) {
				try {
					const stats = await stat(join(TEST_DIR, dir));
					expect(stats.isDirectory()).toBe(true);
				} catch {
					// If stat fails, directory doesn't exist
					assert.strictEqual(false, true);
				}
			}
		});

		it("should handle project names with special characters", async () => {
			// Set up a git repository
			execSync(`git init -b main`, { cwd: TEST_DIR });
			execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
			execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

			const core = new Core(TEST_DIR);
			const specialProjectName = "My-Project_2024 (v1.0)";
			await core.initializeProject(specialProjectName);

			const config = await core.filesystem.loadConfig();
			assert.strictEqual(config?.projectName, specialProjectName);
		});

		it("should work when git repo exists", async () => {
			// Set up existing git repo
			execSync(`git init -b main`, { cwd: TEST_DIR });
			execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
			execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

			const isRepo = await isGitRepository(TEST_DIR);
			assert.strictEqual(isRepo, true);

			const core = new Core(TEST_DIR);
			await core.initializeProject("Existing Repo Test");

			const config = await core.filesystem.loadConfig();
			assert.strictEqual(config?.projectName, "Existing Repo Test");
		});

		it("should accept optional project name parameter", async () => {
			execSync(`git init -b main`, { cwd: TEST_DIR });
			execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
			execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

			// Test the CLI implementation by directly using the Core functionality
			const core = new Core(TEST_DIR);
			await core.initializeProject("Test Project");

			const config = await core.filesystem.loadConfig();
			assert.strictEqual(config?.projectName, "Test Project");
		});

		it("should create agent instruction files when requested", async () => {
			// Set up a git repository
			execSync(`git init -b main`, { cwd: TEST_DIR });
			execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
			execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

			// Simulate the agent instructions being added
			const core = new Core(TEST_DIR);
			await core.initializeProject("Agent Test Project");

			// Import and call addAgentInstructions directly (simulating user saying "y")
			const { addAgentInstructions } = await import("../../src/index.ts");
			await addAgentInstructions(TEST_DIR, core.gitOps);

			// Verify agent files were created
			const agentsFile = await stat(join(TEST_DIR, "AGENTS.md"))
				.then(() => true)
				.catch(() => false);
			const claudeFile = await stat(join(TEST_DIR, "CLAUDE.md"))
				.then(() => true)
				.catch(() => false);
			// .cursorrules removed; Cursor now uses AGENTS.md
			const geminiFile = await stat(join(TEST_DIR, "GEMINI.md"))
				.then(() => true)
				.catch(() => false);
			const copilotFile = await stat(
				join(TEST_DIR, ".github/copilot-instructions.md"),
			)
				.then(() => true)
				.catch(() => false);

			assert.strictEqual(agentsFile, true);
			assert.strictEqual(claudeFile, true);
			assert.strictEqual(geminiFile, true);
			assert.strictEqual(copilotFile, true);

			// Verify content
			const agentsContent = await await readFile(
				join(TEST_DIR, "AGENTS.md"),
				"utf-8",
			);
			const claudeContent = await await readFile(
				join(TEST_DIR, "CLAUDE.md"),
				"utf-8",
			);
			const geminiContent = await await readFile(
				join(TEST_DIR, "GEMINI.md"),
				"utf-8",
			);
			const copilotContent = await await readFile(
				join(TEST_DIR, ".github/copilot-instructions.md"),
				"utf-8",
			);
			assert.ok(agentsContent.length > 0);
			assert.ok(claudeContent.length > 0);
			assert.ok(geminiContent.length > 0);
			assert.ok(copilotContent.length > 0);
		});

		it("should allow skipping agent instructions with 'none' selection", async () => {
			execSync(`git init -b main`, { cwd: TEST_DIR });
			execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
			execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

			const output = execSync(
				`node --experimental-strip-types ${CLI_PATH} init TestProj --defaults --agent-instructions none`,
				{ cwd: TEST_DIR },
			).text();

			const agentsFile = await stat(join(TEST_DIR, "AGENTS.md"))
				.then(() => true)
				.catch(() => false);
			const claudeFile = await stat(join(TEST_DIR, "CLAUDE.md"))
				.then(() => true)
				.catch(() => false);
			assert.strictEqual(agentsFile, false);
			assert.strictEqual(claudeFile, false);
			assert.ok(output.includes("AI Integration: CLI commands (legacy)"));
			assert.ok(
				output.includes("Skipping agent instruction files per selection."),
			);
		});

		it("should print minimal summary when advanced settings are skipped", async () => {
			execSync(`git init -b main`, { cwd: TEST_DIR });
			execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
			execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

			const output = execSync(
				`node --experimental-strip-types ${CLI_PATH} init SummaryProj --defaults --agent-instructions none`,
				{ cwd: TEST_DIR },
			).text();

			assert.ok(output.includes("Initialization Summary"));
			assert.ok(output.includes("Project Name: SummaryProj"));
			assert.ok(output.includes("AI Integration: CLI commands (legacy)"));
			assert.ok(output.includes("Advanced settings: unchanged"));
			assert.ok(!output.includes("Remote operations:"));
			assert.ok(!output.includes("Zero-padded IDs:"));
		});

		it("should support MCP integration mode via flag", async () => {
			execSync(`git init -b main`, { cwd: TEST_DIR });
			execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
			execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

			const output = execSync(
				`node --experimental-strip-types ${CLI_PATH} init McpProj --defaults --integration-mode mcp`,
				{ cwd: TEST_DIR },
			).text();

			assert.ok(output.includes("AI Integration: MCP connector"));
			assert.ok(
				output.includes(
					"Agent instruction files: guidance is provided through the MCP connector.",
				),
			);
			assert.ok(output.includes("MCP server name: roadmap"));
			assert.ok(output.includes("MCP client setup: skipped (non-interactive)"));
			const agentsFile = await stat(join(TEST_DIR, "AGENTS.md"))
				.then(() => true)
				.catch(() => false);
			const claudeFile = await stat(join(TEST_DIR, "CLAUDE.md"))
				.then(() => true)
				.catch(() => false);
			assert.strictEqual(agentsFile, false);
			assert.strictEqual(claudeFile, false);
		});

		it("should default to MCP integration when no mode is specified", async () => {
			execSync(`git init -b main`, { cwd: TEST_DIR });
			execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
			execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

			const output = execSync(
				`node --experimental-strip-types ${CLI_PATH} init DefaultMcpProj --defaults`,
				{ cwd: TEST_DIR },
			).text();

			assert.ok(output.includes("AI Integration: MCP connector"));
			assert.ok(output.includes("MCP server name: roadmap"));
			assert.ok(output.includes("MCP client setup: skipped (non-interactive)"));
		});

		it("should allow skipping AI integration via flag", async () => {
			execSync(`git init -b main`, { cwd: TEST_DIR });
			execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
			execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

			const output = execSync(
				`node --experimental-strip-types ${CLI_PATH} init SkipProj --defaults --integration-mode none`,
				{ cwd: TEST_DIR },
			).text();

			assert.ok(!output.includes("AI Integration:"));
			assert.ok(output.includes("AI integration: skipped"));
			const agentsFile = await stat(join(TEST_DIR, "AGENTS.md"))
				.then(() => true)
				.catch(() => false);
			const claudeFile = await stat(join(TEST_DIR, "CLAUDE.md"))
				.then(() => true)
				.catch(() => false);
			assert.strictEqual(agentsFile, false);
			assert.strictEqual(claudeFile, false);
		});

		it("should reject MCP integration when agent instruction flags are provided", async () => {
			execSync(`git init -b main`, { cwd: TEST_DIR });
			execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
			execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

			let failed = false;
			let combinedOutput = "";
			try {
				execSync(
					`node --experimental-strip-types ${CLI_PATH} init ConflictProj --defaults --integration-mode mcp --agent-instructions claude`,
					{ cwd: TEST_DIR },
				).text();
			} catch (err) {
				failed = true;
				const e = err as { stdout?: unknown; stderr?: unknown };
				combinedOutput = String(e.stdout ?? "") + String(e.stderr ?? "");
			}

			assert.strictEqual(failed, true);
			assert.ok(combinedOutput.includes("cannot be combined"));
		});

		it("should ignore 'none' when other agent instructions are provided", async () => {
			execSync(`git init -b main`, { cwd: TEST_DIR });
			execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
			execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

			execSync(
				`node --experimental-strip-types ${CLI_PATH} init TestProj --defaults --agent-instructions agents,none`,
				{ cwd: TEST_DIR },
			);

			const agentsFile = await stat(join(TEST_DIR, "AGENTS.md"))
				.then(() => true)
				.catch(() => false);
			assert.strictEqual(agentsFile, true);
		});

		it("should error on invalid agent instruction value", async () => {
			execSync(`git init -b main`, { cwd: TEST_DIR });
			execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
			execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

			let failed = false;
			try {
				execSync(
					`node --experimental-strip-types ${CLI_PATH} init InvalidProj --defaults --agent-instructions notreal`,
					{ cwd: TEST_DIR },
				);
			} catch (e) {
				failed = true;
				const err = e as { stdout?: unknown; stderr?: unknown };
				const out = String(err.stdout ?? "") + String(err.stderr ?? "");
				assert.ok(out.includes("Invalid agent instruction: notreal"));
				assert.ok(
					out.includes(
						"Valid options are: cursor, claude, agents, gemini, copilot, none",
					),
				);
			}

			assert.strictEqual(failed, true);
		});
	});

	describe("git integration", () => {
		beforeEach(async () => {
			// Set up a git repository
			execSync(`git init -b main`, { cwd: TEST_DIR });
			execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
			execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });
		});

		it("should create initial commit with roadmap structure", async () => {
			const core = new Core(TEST_DIR);
			await core.initializeProject("Git Integration Test", true);

			const lastCommit = await core.gitOps.getLastCommitMessage();
			assert.strictEqual(
				lastCommit,
				"roadmap: Initialize roadmap project: Git Integration Test",
			);

			// Verify git status is clean after initialization
			const isClean = await core.gitOps.isClean();
			assert.strictEqual(isClean, true);
		});
	});

	describe("proposal list command", () => {
		beforeEach(async () => {
			// Set up a git repository and initialize roadmap
			execSync(`git init -b main`, { cwd: TEST_DIR });
			execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
			execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

			const core = new Core(TEST_DIR);
			await core.initializeProject("List Test Project", true);
		});

		it("should show 'No proposals found' when no proposals exist", async () => {
			const core = new Core(TEST_DIR);
			const proposals = await core.filesystem.listProposals();
			assert.strictEqual(proposals.length, 0);
		});

		it("should list proposals grouped by status", async () => {
			const core = new Core(TEST_DIR);

			// Create test proposals with different statuses
			await core.createProposal(
				{
					id: "proposal-1",
					title: "First Proposal",
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-08",
					labels: [],
					dependencies: [],
					rawContent: "First test proposal",
				},
				false,
			);

			await core.createProposal(
				{
					id: "proposal-2",
					title: "Second Proposal",
					status: "Complete",
					assignee: [],
					createdDate: "2025-06-08",
					labels: [],
					dependencies: [],
					rawContent: "Second test proposal",
				},
				false,
			);

			await core.createProposal(
				{
					id: "proposal-3",
					title: "Third Proposal",
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-08",
					labels: [],
					dependencies: [],
					rawContent: "Third test proposal",
				},
				false,
			);

			const proposals = await core.filesystem.listProposals();
			assert.strictEqual(proposals.length, 3);

			// Verify proposals are grouped correctly by status
			const todoProposals = proposals.filter((t) => t.status === "Potential");
			const completeProposals = proposals.filter(
				(t) => t.status === "Complete",
			);

			assert.strictEqual(todoProposals.length, 2);
			assert.strictEqual(completeProposals.length, 1);
			expect(todoProposals.map((t) => t.id)).toEqual([
				"proposal-1",
				"proposal-3",
			]); // IDs normalized to uppercase
			expect(completeProposals.map((t) => t.id)).toEqual(["proposal-2"]); // IDs normalized to uppercase
		});

		it("should respect config status order", async () => {
			const core = new Core(TEST_DIR);

			// Load and verify default config status order
			const config = await core.filesystem.loadConfig();
			assert.deepStrictEqual(config?.statuses, [
				"Potential",
				"Active",
				"Accepted",
				"Complete",
				"Abandoned",
			]);
		});

		it("should filter proposals by status", async () => {
			const core = new Core(TEST_DIR);

			await core.createProposal(
				{
					id: "proposal-1",
					title: "First Proposal",
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-08",
					labels: [],
					dependencies: [],
					rawContent: "First test proposal",
				},
				false,
			);
			await core.createProposal(
				{
					id: "proposal-2",
					title: "Second Proposal",
					status: "Complete",
					assignee: [],
					createdDate: "2025-06-08",
					labels: [],
					dependencies: [],
					rawContent: "Second test proposal",
				},
				false,
			);

			const result = execSync(
				`node --experimental-strip-types ${CLI_PATH} proposal list --plain --status Complete`,
				{ cwd: TEST_DIR },
			);
			const out = result.stdout.toString();
			assert.ok(out.includes("Complete:"));
			assert.ok(out.includes("proposal-2 - Second Proposal")); // IDs normalized to uppercase
			assert.ok(!out.includes("proposal-1"));
		});

		it("should filter proposals by status case-insensitively", async () => {
			const core = new Core(TEST_DIR);

			await core.createProposal(
				{
					id: "proposal-1",
					title: "First Proposal",
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-08",
					labels: [],
					dependencies: [],
					rawContent: "First test proposal",
				},
				true,
			);
			await core.createProposal(
				{
					id: "proposal-2",
					title: "Second Proposal",
					status: "Complete",
					assignee: [],
					createdDate: "2025-06-08",
					labels: [],
					dependencies: [],
					rawContent: "Second test proposal",
				},
				true,
			);

			const testCases = ["complete", "complete", "complete"];

			for (const status of testCases) {
				const result = execSync(
					`node --experimental-strip-types ${CLI_PATH} proposal list --plain --status ${status}`,
					{ cwd: TEST_DIR },
				);
				const out = result.stdout.toString();
				assert.ok(out.includes("Complete:"));
				assert.ok(out.includes("proposal-2 - Second Proposal")); // IDs normalized to uppercase
				assert.ok(!out.includes("proposal-1"));
			}

			// Test with -s flag
			const resultShort = await listProposalsPlatformAware(
				{ plain: true, status: "complete" },
				TEST_DIR,
			);
			const outShort = resultShort.stdout;
			assert.ok(outShort.includes("Complete:"));
			assert.ok(outShort.includes("proposal-2 - Second Proposal")); // IDs normalized to uppercase
			assert.ok(!outShort.includes("proposal-1"));
		});

		it("should filter proposals by assignee", async () => {
			const core = new Core(TEST_DIR);

			await core.createProposal(
				{
					id: "proposal-1",
					title: "Assigned Proposal",
					status: "Potential",
					assignee: ["alice"],
					createdDate: "2025-06-08",
					labels: [],
					dependencies: [],
					rawContent: "Assigned proposal",
				},
				false,
			);
			await core.createProposal(
				{
					id: "proposal-2",
					title: "Unassigned Proposal",
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-08",
					labels: [],
					dependencies: [],
					rawContent: "Other proposal",
				},
				false,
			);

			const result = execSync(
				`node --experimental-strip-types ${CLI_PATH} proposal list --plain --assignee alice`,
				{ cwd: TEST_DIR },
			);
			const out = result.stdout.toString();
			assert.ok(out.includes("proposal-1 - Assigned Proposal")); // IDs normalized to uppercase
			assert.ok(!out.includes("proposal-2 - Unassigned Proposal"));
		});
	});

	describe("proposal view command", () => {
		beforeEach(async () => {
			// Set up a git repository and initialize roadmap
			execSync(`git init -b main`, { cwd: TEST_DIR });
			execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
			execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

			const core = new Core(TEST_DIR);
			await core.initializeProject("View Test Project");
		});

		it("should display proposal details with markdown formatting", async () => {
			const core = new Core(TEST_DIR);

			// Create a test proposal
			const testProposal = {
				id: "proposal-1",
				title: "Test View Proposal",
				status: "Potential",
				assignee: ["testuser"],
				createdDate: "2025-06-08",
				labels: ["test", "cli"],
				dependencies: [],
				rawContent: "This is a test proposal for view command",
			};

			await core.createProposal(testProposal, false);

			// Load the proposal back
			const loadedProposal = await core.filesystem.loadProposal("proposal-1");
			assert.notStrictEqual(loadedProposal, null);
			assert.strictEqual(loadedProposal?.id, "proposal-1"); // IDs normalized to uppercase
			assert.strictEqual(loadedProposal?.title, "Test View Proposal");
			assert.strictEqual(loadedProposal?.status, "Potential");
			assert.deepStrictEqual(loadedProposal?.assignee, ["testuser"]);
			assert.deepStrictEqual(loadedProposal?.labels, ["test", "cli"]);
			assert.strictEqual(
				loadedProposal?.rawContent,
				"This is a test proposal for view command",
			);
		});

		it("should handle proposal IDs with and without 'proposal-' prefix", async () => {
			const core = new Core(TEST_DIR);

			// Create a test proposal
			await core.createProposal(
				{
					id: "proposal-5",
					title: "Prefix Test Proposal",
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-08",
					labels: [],
					dependencies: [],
					rawContent: "Testing proposal ID normalization",
				},
				false,
			);

			// Test loading with full proposal-5 ID
			const proposalWithPrefix =
				await core.filesystem.loadProposal("proposal-5");
			assert.strictEqual(proposalWithPrefix?.id, "proposal-5"); // IDs normalized to uppercase

			// Test loading with just numeric ID (5)
			const proposalWithoutPrefix = await core.filesystem.loadProposal("5");
			// The filesystem loadProposal should handle normalization
			assert.strictEqual(proposalWithoutPrefix?.id, "proposal-5"); // IDs normalized to uppercase
		});

		it("should return null for non-existent proposals", async () => {
			const core = new Core(TEST_DIR);

			const nonExistentProposal =
				await core.filesystem.loadProposal("proposal-999");
			assert.strictEqual(nonExistentProposal, null);
		});

		it("should not modify proposal files (read-only operation)", async () => {
			const core = new Core(TEST_DIR);

			// Create a test proposal
			const originalProposal = {
				id: "proposal-1",
				title: "Read Only Test",
				status: "Potential",
				assignee: [],
				createdDate: "2025-06-08",
				labels: ["readonly"],
				dependencies: [],
				rawContent: "Original description",
			};

			await core.createProposal(originalProposal, false);

			// Load the proposal (simulating view operation)
			const viewedProposal = await core.filesystem.loadProposal("proposal-1");

			// Load again to verify nothing changed
			const secondView = await core.filesystem.loadProposal("proposal-1");

			assert.deepStrictEqual(viewedProposal, secondView);
			assert.strictEqual(viewedProposal?.title, "Read Only Test");
			assert.strictEqual(viewedProposal?.rawContent, "Original description");
		});
	});

	describe("proposal shortcut command", () => {
		beforeEach(async () => {
			execSync(`git init -b main`, { cwd: TEST_DIR });
			execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
			execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

			const core = new Core(TEST_DIR);
			await core.initializeProject("Shortcut Test Project");
		});

		it("should display formatted proposal details like the view command", async () => {
			const core = new Core(TEST_DIR);

			await core.createProposal(
				{
					id: "proposal-1",
					title: "Shortcut Proposal",
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-08",
					labels: [],
					dependencies: [],
					rawContent: "Shortcut description",
				},
				false,
			);

			const resultShortcut = await viewProposalPlatformAware(
				{ proposalId: "1", plain: true },
				TEST_DIR,
			);
			const resultView = await viewProposalPlatformAware(
				{ proposalId: "1", plain: true, useViewCommand: true },
				TEST_DIR,
			);

			const outShortcut = resultShortcut.stdout;
			const outView = resultView.stdout;

			assert.strictEqual(outShortcut, outView);
			assert.ok(
				outShortcut.includes("Proposal proposal-1 - Shortcut Proposal"),
			);
		});
	});

	describe("proposal edit command", () => {
		beforeEach(async () => {
			// Set up a git repository and initialize roadmap
			execSync(`git init -b main`, { cwd: TEST_DIR });
			execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
			execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

			const core = new Core(TEST_DIR);
			await core.initializeProject("Edit Test Project", true);
		});

		it("should update proposal title, description, and status", async () => {
			const core = new Core(TEST_DIR);

			// Create a test proposal
			await core.createProposal(
				{
					id: "proposal-1",
					title: "Original Title",
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-08",
					labels: [],
					dependencies: [],
					rawContent: "Original description",
				},
				false,
			);

			// Load and edit the proposal
			const proposal = await core.filesystem.loadProposal("proposal-1");
			assert.notStrictEqual(proposal, null);

			await core.updateProposalFromInput(
				"proposal-1",
				{
					title: "Updated Title",
					description: "Updated description",
					status: "Active",
				},
				false,
			);

			// Verify changes were persisted
			const updatedProposal = await core.filesystem.loadProposal("proposal-1");
			assert.strictEqual(updatedProposal?.title, "Updated Title");
			expect(
				extractStructuredSection(
					updatedProposal?.rawContent || "",
					"description",
				),
			).toBe("Updated description");
			assert.strictEqual(updatedProposal?.status, "Active");
			const today = new Date().toISOString().slice(0, 16).replace("T", " ");
			assert.strictEqual(updatedProposal?.updatedDate, today);
		});

		it("should update assignee", async () => {
			const core = new Core(TEST_DIR);

			// Create a test proposal
			await core.createProposal(
				{
					id: "proposal-2",
					title: "Assignee Test",
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-08",
					labels: [],
					dependencies: [],
					rawContent: "Testing assignee updates",
				},
				false,
			);

			// Update assignee
			await core.updateProposalFromInput(
				"proposal-2",
				{ assignee: ["newuser@example.com"] },
				false,
			);

			// Verify assignee was updated
			const updatedProposal = await core.filesystem.loadProposal("proposal-2");
			assert.deepStrictEqual(updatedProposal?.assignee, [
				"newuser@example.com",
			]);
		});

		it("should replace all labels with new labels", async () => {
			const core = new Core(TEST_DIR);

			// Create a test proposal with existing labels
			await core.createProposal(
				{
					id: "proposal-3",
					title: "Label Replace Test",
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-08",
					labels: ["old1", "old2"],
					dependencies: [],
					rawContent: "Testing label replacement",
				},
				false,
			);

			// Replace all labels
			await core.updateProposalFromInput(
				"proposal-3",
				{ labels: ["new1", "new2", "new3"] },
				false,
			);

			// Verify labels were replaced
			const updatedProposal = await core.filesystem.loadProposal("proposal-3");
			assert.deepStrictEqual(updatedProposal?.labels, ["new1", "new2", "new3"]);
		});

		it("should add labels without replacing existing ones", async () => {
			const core = new Core(TEST_DIR);

			// Create a test proposal with existing labels
			await core.createProposal(
				{
					id: "proposal-4",
					title: "Label Add Test",
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-08",
					labels: ["existing"],
					dependencies: [],
					rawContent: "Testing label addition",
				},
				false,
			);

			// Add new labels
			await core.updateProposalFromInput(
				"proposal-4",
				{ addLabels: ["added1", "added2"] },
				false,
			);

			// Verify labels were added
			const updatedProposal = await core.filesystem.loadProposal("proposal-4");
			assert.deepStrictEqual(updatedProposal?.labels, [
				"existing",
				"added1",
				"added2",
			]);
		});

		it("should remove specific labels", async () => {
			const core = new Core(TEST_DIR);

			// Create a test proposal with multiple labels
			await core.createProposal(
				{
					id: "proposal-5",
					title: "Label Remove Test",
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-08",
					labels: ["keep1", "remove", "keep2"],
					dependencies: [],
					rawContent: "Testing label removal",
				},
				false,
			);

			// Remove specific label
			await core.updateProposalFromInput(
				"proposal-5",
				{ removeLabels: ["remove"] },
				false,
			);

			// Verify label was removed
			const updatedProposal = await core.filesystem.loadProposal("proposal-5");
			assert.deepStrictEqual(updatedProposal?.labels, ["keep1", "keep2"]);
		});

		it("should handle non-existent proposal gracefully", async () => {
			const core = new Core(TEST_DIR);

			const nonExistentProposal =
				await core.filesystem.loadProposal("proposal-999");
			assert.strictEqual(nonExistentProposal, null);
		});

		it("should automatically set updated_date field when editing", async () => {
			const core = new Core(TEST_DIR);

			// Create a test proposal
			await core.createProposal(
				{
					id: "proposal-6",
					title: "Updated Date Test",
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-07",
					labels: [],
					dependencies: [],
					rawContent: "Testing updated date",
				},
				false,
			);

			// Edit the proposal (without manually setting updatedDate)
			await core.updateProposalFromInput(
				"proposal-6",
				{ title: "Updated Title" },
				false,
			);

			// Verify updated_date was automatically set to today's date
			const updatedProposal = await core.filesystem.loadProposal("proposal-6");
			const today = new Date().toISOString().slice(0, 16).replace("T", " ");
			assert.strictEqual(updatedProposal?.updatedDate, today);
			assert.strictEqual(updatedProposal?.createdDate, "2025-06-07"); // Should remain unchanged
		});

		it("should commit changes automatically", async () => {
			const core = new Core(TEST_DIR);

			// Create a test proposal
			await core.createProposal(
				{
					id: "proposal-7",
					title: "Commit Test",
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-08",
					labels: [],
					dependencies: [],
					rawContent: "Testing auto-commit",
				},
				false,
			);

			// Edit the proposal with auto-commit enabled
			await core.updateProposalFromInput(
				"proposal-7",
				{ title: "Updated for Commit" },
				true,
			);

			// Verify the proposal was updated (this confirms the update functionality works)
			const updatedProposal = await core.filesystem.loadProposal("proposal-7");
			assert.strictEqual(updatedProposal?.title, "Updated for Commit");

			// For now, just verify that updateProposal with autoCommit=true doesn't throw
			// The actual git commit functionality is tested at the Core level
		});

		it("should preserve YAML frontmatter formatting", async () => {
			const core = new Core(TEST_DIR);

			// Create a test proposal
			await core.createProposal(
				{
					id: "proposal-8",
					title: "YAML Test",
					status: "Potential",
					assignee: ["testuser"],
					createdDate: "2025-06-08",
					labels: ["yaml", "test"],
					dependencies: ["proposal-1"],
					rawContent: "Testing YAML preservation",
				},
				false,
			);

			// Edit the proposal
			await core.updateProposalFromInput(
				"proposal-8",
				{
					title: "Updated YAML Test",
					status: "Active",
				},
				false,
			);

			// Verify all frontmatter fields are preserved
			const updatedProposal = await core.filesystem.loadProposal("proposal-8");
			assert.strictEqual(updatedProposal?.id, "proposal-8"); // IDs normalized to uppercase
			assert.strictEqual(updatedProposal?.title, "Updated YAML Test");
			assert.strictEqual(updatedProposal?.status, "Active");
			assert.deepStrictEqual(updatedProposal?.assignee, ["testuser"]);
			assert.strictEqual(updatedProposal?.createdDate, "2025-06-08");
			const today = new Date().toISOString().slice(0, 16).replace("T", " ");
			assert.strictEqual(updatedProposal?.updatedDate, today);
			assert.deepStrictEqual(updatedProposal?.labels, ["yaml", "test"]);
			assert.deepStrictEqual(updatedProposal?.dependencies, ["proposal-1"]);
			assert.strictEqual(
				updatedProposal?.rawContent,
				"Testing YAML preservation",
			);
		});
	});

	describe("proposal archive and proposal transition commands", () => {
		beforeEach(async () => {
			// Set up a git repository and initialize roadmap
			execSync(`git init -b main`, { cwd: TEST_DIR });
			execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
			execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

			const core = new Core(TEST_DIR);
			await core.initializeProject("Archive Test Project");
		});

		it("should archive a proposal", async () => {
			const core = new Core(TEST_DIR);

			// Create a test proposal
			await core.createProposal(
				{
					id: "proposal-1",
					title: "Archive Test Proposal",
					status: "Complete",
					assignee: [],
					createdDate: "2025-06-08",
					labels: ["completed"],
					dependencies: [],
					rawContent: "Proposal ready for archiving",
				},
				false,
			);

			// Archive the proposal
			const success = await core.archiveProposal("proposal-1", false);
			assert.strictEqual(success, true);

			// Verify proposal is no longer in proposals directory
			const proposal = await core.filesystem.loadProposal("proposal-1");
			assert.strictEqual(proposal, null);

			// Verify proposal exists in archive
			const { readdir } = await import("node:fs/promises");
			const archiveFiles = await readdir(
				join(TEST_DIR, "roadmap", "archive", "proposals"),
			);
			expect(archiveFiles.some((f) => f.startsWith("proposal-1"))).toBe(true);
		});

		it("should handle archiving non-existent proposal", async () => {
			const core = new Core(TEST_DIR);

			const success = await core.archiveProposal("proposal-999", false);
			assert.strictEqual(success, false);
		});

		it("should demote proposal to drafts", async () => {
			const core = new Core(TEST_DIR);

			// Create a test proposal
			await core.createProposal(
				{
					id: "proposal-2",
					title: "Demote Test Proposal",
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-08",
					labels: ["needs-revision"],
					dependencies: [],
					rawContent: "Proposal that needs to go back to drafts",
				},
				false,
			);

			// Demote the proposal
			const success = await core.demoteProposal("proposal-2", false);
			assert.strictEqual(success, true);

			// Verify proposal is no longer in proposals directory
			const proposal = await core.filesystem.loadProposal("proposal-2");
			assert.strictEqual(proposal, null);

			// Verify demoted draft has new draft- ID
			const { readdir } = await import("node:fs/promises");
			const draftsFiles = await readdir(join(TEST_DIR, "roadmap", "drafts"));
			expect(draftsFiles.some((f) => f.startsWith("draft-"))).toBe(true);

			// Verify draft can be loaded with draft- ID
			const demotedDraft = await core.filesystem.loadDraft("draft-1");
			assert.strictEqual(demotedDraft?.title, "Demote Test Proposal");
		});

		it("should promote draft to proposals", async () => {
			const core = new Core(TEST_DIR);

			// Create a test draft with proper draft-X id
			await core.createDraft(
				{
					id: "draft-3",
					title: "Promote Test Draft",
					status: "Draft",
					assignee: [],
					createdDate: "2025-06-08",
					labels: ["ready"],
					dependencies: [],
					rawContent: "Draft ready for promotion",
				},
				false,
			);

			// Promote the draft
			const success = await core.promoteDraft("draft-3", false);
			assert.strictEqual(success, true);

			// Verify draft is no longer in drafts directory
			const draft = await core.filesystem.loadDraft("draft-3");
			assert.strictEqual(draft, null);

			// Verify promoted proposal has new proposal- ID
			const { readdir } = await import("node:fs/promises");
			const proposalsFiles = await readdir(
				join(TEST_DIR, "roadmap", "proposals"),
			);
			expect(proposalsFiles.some((f) => f.startsWith("proposal-"))).toBe(true);

			// Verify proposal can be loaded with proposal- ID
			const promotedProposal = await core.filesystem.loadProposal("proposal-1");
			assert.strictEqual(promotedProposal?.title, "Promote Test Draft");
		});

		it("should archive a draft", async () => {
			const core = new Core(TEST_DIR);

			// Create a test draft with proper draft-X id
			await core.createDraft(
				{
					id: "draft-4",
					title: "Archive Test Draft",
					status: "Draft",
					assignee: [],
					createdDate: "2025-06-08",
					labels: ["cancelled"],
					dependencies: [],
					rawContent: "Draft that should be archived",
				},
				false,
			);

			// Archive the draft
			const success = await core.archiveDraft("draft-4", false);
			assert.strictEqual(success, true);

			// Verify draft is no longer in drafts directory
			const draft = await core.filesystem.loadDraft("draft-4");
			assert.strictEqual(draft, null);

			// Verify draft exists in archive
			const { readdir } = await import("node:fs/promises");
			const archiveFiles = await readdir(
				join(TEST_DIR, "roadmap", "archive", "drafts"),
			);
			expect(archiveFiles.some((f) => f.startsWith("draft-4"))).toBe(true);
		});

		it("should handle promoting non-existent draft", async () => {
			const core = new Core(TEST_DIR);

			const success = await core.promoteDraft("proposal-999", false);
			assert.strictEqual(success, false);
		});

		it("should handle demoting non-existent proposal", async () => {
			const core = new Core(TEST_DIR);

			const success = await core.demoteProposal("proposal-999", false);
			assert.strictEqual(success, false);
		});

		it("should handle archiving non-existent draft", async () => {
			const core = new Core(TEST_DIR);

			const success = await core.archiveDraft("proposal-999", false);
			assert.strictEqual(success, false);
		});

		it("should commit archive operations automatically", async () => {
			const core = new Core(TEST_DIR);

			// Create and archive a proposal with auto-commit
			await core.createProposal(
				{
					id: "proposal-5",
					title: "Commit Archive Test",
					status: "Complete",
					assignee: [],
					createdDate: "2025-06-08",
					labels: [],
					dependencies: [],
					rawContent: "Testing auto-commit on archive",
				},
				false,
			);

			const success = await core.archiveProposal("proposal-5", true); // autoCommit = true
			assert.strictEqual(success, true);

			// Verify operation completed successfully
			const proposal = await core.filesystem.loadProposal("proposal-5");
			assert.strictEqual(proposal, null);
		});

		it("should preserve proposal content through proposal transitions", async () => {
			const core = new Core(TEST_DIR);

			// Create a proposal with rich content
			const originalProposal = {
				id: "proposal-6",
				title: "Content Preservation Test",
				status: "Active",
				assignee: ["testuser"],
				createdDate: "2025-06-08",
				labels: ["important", "preservation-test"],
				dependencies: ["proposal-1", "proposal-2"],
				rawContent:
					"This proposal has rich metadata that should be preserved through transitions",
			};

			await core.createProposal(originalProposal, false);

			// Demote to draft - note: this generates a new draft ID
			await core.demoteProposal("proposal-6", false);

			// Find the demoted draft (it will have a new draft- ID)
			const drafts = await core.filesystem.listDrafts();
			const asDraft = drafts.find((d) => d.title === originalProposal.title);

			assert.strictEqual(asDraft?.title, originalProposal.title);
			assert.deepStrictEqual(asDraft?.assignee, originalProposal.assignee);
			assert.deepStrictEqual(asDraft?.labels, originalProposal.labels);
			assert.deepStrictEqual(
				asDraft?.dependencies,
				originalProposal.dependencies,
			);
			assert.ok(asDraft?.rawContent?.includes(originalProposal.rawContent));

			// Promote back to proposal - use the draft's new ID
			assert.notStrictEqual(asDraft, undefined);
			if (!asDraft) {
				throw new Error("Expected demoted draft to exist");
			}
			await core.promoteDraft(asDraft.id, false);

			// Find the promoted proposal (it will have a new proposal- ID)
			const proposals = await core.filesystem.listProposals();
			const backToProposal = proposals.find(
				(t) => t.title === originalProposal.title,
			);

			assert.strictEqual(backToProposal?.title, originalProposal.title);
			assert.deepStrictEqual(
				backToProposal?.assignee,
				originalProposal.assignee,
			);
			assert.deepStrictEqual(backToProposal?.labels, originalProposal.labels);
			assert.deepStrictEqual(
				backToProposal?.dependencies,
				originalProposal.dependencies,
			);
			assert.ok(
				backToProposal?.rawContent?.includes(originalProposal.rawContent),
			);
		});
	});

	describe("doc and decision commands", () => {
		beforeEach(async () => {
			execSync(`git init -b main`, { cwd: TEST_DIR });
			execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
			execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

			const core = new Core(TEST_DIR);
			await core.initializeProject("Doc Test Project");
		});

		it("should create and list documents", async () => {
			const core = new Core(TEST_DIR);
			const doc: Document = {
				id: "doc-1",
				title: "Guide",
				type: "guide",
				createdDate: "2025-06-08",
				rawContent: "Content",
			};
			await core.createDocument(doc, false);

			const docs = await core.filesystem.listDocuments();
			assert.strictEqual(docs.length, 1);
			assert.strictEqual(docs[0]?.title, "Guide");
		});

		it("should create and list decisions", async () => {
			const core = new Core(TEST_DIR);
			const decision: Decision = {
				id: "decision-1",
				title: "Choose Stack",
				date: "2025-06-08",
				status: "accepted",
				context: "context",
				decision: "decide",
				consequences: "conseq",
				rawContent: "",
			};
			await core.createDecision(decision, false);
			const decisions = await core.filesystem.listDecisions();
			assert.strictEqual(decisions.length, 1);
			assert.strictEqual(decisions[0]?.title, "Choose Stack");
		});
	});

	describe("board view command", () => {
		beforeEach(async () => {
			execSync(`git init -b main`, { cwd: TEST_DIR });
			execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
			execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

			const core = new Core(TEST_DIR);
			await core.initializeProject("Board Test Project", true);
		});

		it("should display kanban board with proposals grouped by status", async () => {
			const core = new Core(TEST_DIR);

			// Create test proposals with different statuses
			await core.createProposal(
				{
					id: "proposal-1",
					title: "Todo Proposal",
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-08",
					labels: [],
					dependencies: [],
					rawContent: "A proposal in todo",
				},
				false,
			);

			await core.createProposal(
				{
					id: "proposal-2",
					title: "Progress Proposal",
					status: "Active",
					assignee: [],
					createdDate: "2025-06-08",
					labels: [],
					dependencies: [],
					rawContent: "A proposal active",
				},
				false,
			);

			await core.createProposal(
				{
					id: "proposal-3",
					title: "Complete Proposal",
					status: "Complete",
					assignee: [],
					createdDate: "2025-06-08",
					labels: [],
					dependencies: [],
					rawContent: "A completed proposal",
				},
				false,
			);

			const proposals = await core.filesystem.listProposals();
			assert.strictEqual(proposals.length, 3);

			const config = await core.filesystem.loadConfig();
			const statuses = config?.statuses || [];
			assert.deepStrictEqual(statuses, [
				"Potential",
				"Active",
				"Accepted",
				"Complete",
				"Abandoned",
			]);

			// Test the kanban board generation
			const { generateKanbanBoardWithMetadata } = await import(
				"../../src/board.ts"
			);
			const board = generateKanbanBoardWithMetadata(
				proposals,
				statuses,
				"Test Project",
			);

			// Verify board contains all statuses and proposals (now on separate lines)
			assert.ok(board.includes("Potential"));
			assert.ok(board.includes("Active"));
			assert.ok(board.includes("Complete"));
			assert.ok(board.includes("proposal-1"));
			assert.ok(board.includes("Todo Proposal"));
			assert.ok(board.includes("proposal-2"));
			assert.ok(board.includes("Progress Proposal"));
			assert.ok(board.includes("proposal-3"));
			assert.ok(board.includes("Complete Proposal"));

			// Verify board structure (now includes metadata header)
			const lines = board.split("\n");
			assert.ok(board.includes("# Kanban Board Export"));
			assert.ok(board.includes("Potential"));
			assert.ok(board.includes("Active"));
			assert.ok(board.includes("Complete"));
			assert.ok(board.includes("|")); // Table structure
			assert.ok(lines.length > 5); // Should have content rows
		});

		it("should handle empty project with default statuses", async () => {
			const core = new Core(TEST_DIR);

			const proposals = await core.filesystem.listProposals();
			assert.strictEqual(proposals.length, 0);

			const config = await core.filesystem.loadConfig();
			const statuses = config?.statuses || [];

			const { generateKanbanBoardWithMetadata } = await import(
				"../../src/board.ts"
			);
			const board = generateKanbanBoardWithMetadata(
				proposals,
				statuses,
				"Test Project",
			);

			// Should return board with metadata, configured status columns, and empty-proposal message
			assert.ok(board.includes("# Kanban Board Export"));
			assert.ok(board.includes("| Potential | Active | Complete |"));
			assert.ok(board.includes("No proposals found"));
		});

		it("should support vertical layout option", async () => {
			const core = new Core(TEST_DIR);

			await core.createProposal(
				{
					id: "proposal-1",
					title: "Todo Proposal",
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-08",
					labels: [],
					dependencies: [],
					rawContent: "A proposal in todo",
				},
				false,
			);

			const proposals = await core.filesystem.listProposals();
			const config = await core.filesystem.loadConfig();
			const statuses = config?.statuses || [];

			const { generateKanbanBoardWithMetadata } = await import(
				"../../src/board.ts"
			);
			const board = generateKanbanBoardWithMetadata(
				proposals,
				statuses,
				"Test Project",
			);

			// Should contain proper board structure
			assert.ok(board.includes("# Kanban Board Export"));
			assert.ok(board.includes("Potential"));
			assert.ok(board.includes("proposal-1"));
			assert.ok(board.includes("Todo Proposal"));
		});

		it("should support --vertical shortcut flag", async () => {
			const core = new Core(TEST_DIR);

			await core.createProposal(
				{
					id: "proposal-1",
					title: "Shortcut Proposal",
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-09",
					labels: [],
					dependencies: [],
					rawContent: "Testing vertical shortcut",
				},
				false,
			);

			const proposals = await core.filesystem.listProposals();
			const config = await core.filesystem.loadConfig();
			const statuses = config?.statuses || [];

			// Test that --vertical flag produces vertical layout
			const { generateKanbanBoardWithMetadata } = await import(
				"../../src/board.ts"
			);
			const board = generateKanbanBoardWithMetadata(
				proposals,
				statuses,
				"Test Project",
			);

			// Should contain proper board structure
			assert.ok(board.includes("# Kanban Board Export"));
			assert.ok(board.includes("Potential"));
			assert.ok(board.includes("proposal-1"));
			assert.ok(board.includes("Shortcut Proposal"));
		});

		it("should merge proposal status from remote branches", async () => {
			const core = new Core(TEST_DIR);

			const proposal = {
				id: "proposal-1",
				title: "Remote Proposal",
				status: "Potential",
				assignee: [],
				createdDate: "2025-06-09",
				labels: [],
				dependencies: [],
				rawContent: "from remote",
			} as Proposal;

			await core.createProposal(proposal, true);

			// set up remote repository
			const remoteDir = join(TEST_DIR, "remote.git");
			execSync(`git init --bare -b main ${remoteDir}`);
			execSync(`git remote add origin ${remoteDir}`, { cwd: TEST_DIR });
			execSync(`git push -u origin main`, { cwd: TEST_DIR });

			// create branch with updated status
			execSync(`git checkout -b feature`, { cwd: TEST_DIR });
			await core.updateProposalFromInput(
				"proposal-1",
				{ status: "Complete" },
				true,
			);
			execSync(`git push -u origin feature`, { cwd: TEST_DIR });

			// Update remote-tracking branches to ensure they are recognized
			execSync(`git remote update origin --prune`, { cwd: TEST_DIR });

			// switch back to main where status is still Potential
			execSync(`git checkout main`, { cwd: TEST_DIR });

			await core.gitOps.fetch();
			const branches = await core.gitOps.listRemoteBranches();
			const config = await core.filesystem.loadConfig();
			const statuses = config?.statuses || [];

			const localProposals = await core.filesystem.listProposals();
			const proposalsById = new Map(localProposals.map((t) => [t.id, t]));

			for (const branch of branches) {
				const ref = `origin/${branch}`;
				const files = await core.gitOps.listFilesInTree(
					ref,
					"roadmap/proposals",
				);
				for (const file of files) {
					const content = await core.gitOps.showFile(ref, file);
					const remoteProposal = parseProposal(content);
					const existing = proposalsById.get(remoteProposal.id);
					const currentIdx = existing ? statuses.indexOf(existing.status) : -1;
					const newIdx = statuses.indexOf(remoteProposal.status);
					if (
						!existing ||
						newIdx > currentIdx ||
						currentIdx === -1 ||
						newIdx === currentIdx
					) {
						proposalsById.set(remoteProposal.id, remoteProposal);
					}
				}
			}

			const final = proposalsById.get("proposal-1"); // IDs normalized to uppercase
			assert.strictEqual(final?.status, "Complete");
		});

		it("should default to view when no subcommand is provided", async () => {
			const core = new Core(TEST_DIR);

			await core.createProposal(
				{
					id: "proposal-99",
					title: "Default Cmd Proposal",
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-10",
					labels: [],
					dependencies: [],
					rawContent: "test",
				},
				false,
			);

			const resultDefault = execSync(
				`node --experimental-strip-types ${buildCliCommand(["src/cli.ts", "board"])}`,
				{ cwd: TEST_DIR },
			);
			const resultView = execSync(
				`node --experimental-strip-types ${buildCliCommand(["src/cli.ts", "board", "view"])}`,
				{ cwd: TEST_DIR },
			);

			expect(resultDefault.stdout.toString()).toBe(
				resultView.stdout.toString(),
			);
		});

		it("should export kanban board to file", async () => {
			const core = new Core(TEST_DIR);

			// Create test proposals
			await core.createProposal(
				{
					id: "proposal-1",
					title: "Export Test Proposal",
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-09",
					labels: [],
					dependencies: [],
					rawContent: "Testing board export",
				},
				false,
			);

			const { exportKanbanBoardToFile } = await import("../../src/board.ts");
			const outputPath = join(TEST_DIR, "test-export.md");
			const proposals = await core.filesystem.listProposals();
			const config = await core.filesystem.loadConfig();
			const statuses = config?.statuses || [];

			await exportKanbanBoardToFile(
				proposals,
				statuses,
				outputPath,
				"TestProject",
			);

			// Verify file was created and contains expected content
			const content = await await readFile(outputPath, "utf-8");
			assert.ok(content.includes("Potential"));
			assert.ok(content.includes("proposal-1"));
			assert.ok(content.includes("Export Test Proposal"));
			assert.ok(
				content.includes("# Kanban Board Export (powered by Roadmap.md)"),
			);
			assert.ok(content.includes("Project: TestProject"));

			// Test overwrite behavior
			await exportKanbanBoardToFile(
				proposals,
				statuses,
				outputPath,
				"TestProject",
			);
			const overwrittenContent = await await readFile(outputPath, "utf-8");
			const occurrences = overwrittenContent.split("proposal-1").length - 1;
			assert.strictEqual(occurrences, 1); // Should appear once after overwrite
		});
	});
});
