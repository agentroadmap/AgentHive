import assert from "node:assert";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, test } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import { AcceptanceCriteriaManager } from "../../src/markdown/structured-sections.ts";
import {
	createUniqueTestDir,
	execSync,
	expect,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;
const CLI_PATH = join(process.cwd(), "src", "cli.ts");

describe("Acceptance Criteria CLI", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-acceptance-criteria");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		const core = new Core(TEST_DIR);
		await core.initializeProject("AC Test Project");
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	describe("proposal create with acceptance criteria", () => {
		it("should create proposal with single acceptance criterion using -ac", async () => {
			const result = execSync(
				`node --experimental-strip-types ${CLI_PATH} proposal create "Test Proposal" --ac "Must work correctly"`,
				{ cwd: TEST_DIR },
			);
			if (result.exitCode !== 0) {
				console.error("STDOUT:", result.stdout.toString());
				console.error("STDERR:", result.stderr.toString());
			}
			assert.strictEqual(result.exitCode, 0);

			const core = new Core(TEST_DIR);
			const proposal = await core.filesystem.loadProposal("proposal-1");
			assert.notStrictEqual(proposal, null);
			assert.ok(proposal?.rawContent?.includes("## Acceptance Criteria"));
			assert.ok(proposal?.rawContent?.includes("- [ ] #1 Must work correctly"));
		});

		it("should create proposal with multiple criteria using multiple --ac flags", async () => {
			const result = execSync(
				`node --experimental-strip-types ${CLI_PATH} proposal create "Test Proposal" --ac "Criterion 1" --ac "Criterion 2" --ac "Criterion 3"`,
				{ cwd: TEST_DIR },
			);
			assert.strictEqual(result.exitCode, 0);

			const core = new Core(TEST_DIR);
			const proposal = await core.filesystem.loadProposal("proposal-1");
			assert.notStrictEqual(proposal, null);
			assert.ok(proposal?.rawContent?.includes("- [ ] #1 Criterion 1"));
			assert.ok(proposal?.rawContent?.includes("- [ ] #2 Criterion 2"));
			assert.ok(proposal?.rawContent?.includes("- [ ] #3 Criterion 3"));
		});

		it("should treat comma-separated text as single criterion", async () => {
			const result = execSync(
				`node --experimental-strip-types ${CLI_PATH} proposal create "Test Proposal" --ac "Criterion 1, Criterion 2, Criterion 3"`,
				{ cwd: TEST_DIR },
			);
			assert.strictEqual(result.exitCode, 0);

			const core = new Core(TEST_DIR);
			const proposal = await core.filesystem.loadProposal("proposal-1");
			assert.notStrictEqual(proposal, null);
			// Should create single criterion with commas intact
			assert.ok(
				proposal?.rawContent?.includes(
					"- [ ] #1 Criterion 1, Criterion 2, Criterion 3",
				),
			);
			// Should NOT create multiple criteria
			assert.ok(!proposal?.rawContent?.includes("- [ ] #2"));
		});

		it("should create proposal with criteria using --acceptance-criteria", async () => {
			const result = execSync(
				`node --experimental-strip-types ${CLI_PATH} proposal create "Test Proposal" --acceptance-criteria "Full flag test"`,
				{ cwd: TEST_DIR },
			);
			assert.strictEqual(result.exitCode, 0);

			const core = new Core(TEST_DIR);
			const proposal = await core.filesystem.loadProposal("proposal-1");
			assert.notStrictEqual(proposal, null);
			assert.ok(proposal?.rawContent?.includes("## Acceptance Criteria"));
			assert.ok(proposal?.rawContent?.includes("- [ ] #1 Full flag test"));
		});

		it("should create proposal with both description and acceptance criteria", async () => {
			const result = execSync(
				`node --experimental-strip-types ${CLI_PATH} proposal create "Test Proposal" -d "Proposal description" --ac "Must pass tests" --ac "Must be documented"`,
				{ cwd: TEST_DIR },
			);
			assert.strictEqual(result.exitCode, 0);

			const core = new Core(TEST_DIR);
			const proposal = await core.filesystem.loadProposal("proposal-1");
			assert.notStrictEqual(proposal, null);
			assert.ok(proposal?.rawContent?.includes("## Description"));
			assert.ok(proposal?.rawContent?.includes("Proposal description"));
			assert.ok(proposal?.rawContent?.includes("## Acceptance Criteria"));
			assert.ok(proposal?.rawContent?.includes("- [ ] #1 Must pass tests"));
			assert.ok(proposal?.rawContent?.includes("- [ ] #2 Must be documented"));
		});
	});

	describe("proposal edit with acceptance criteria", () => {
		beforeEach(async () => {
			const core = new Core(TEST_DIR);
			await core.createProposal(
				{
					id: "proposal-1",
					title: "Existing Proposal",
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-19",
					labels: [],
					dependencies: [],
					rawContent: "## Description\n\nExisting proposal description",
				},
				false,
			);
		});

		it("should add acceptance criteria to existing proposal", async () => {
			const result = execSync(
				`node --experimental-strip-types ${CLI_PATH} proposal edit proposal-1 --ac "New criterion 1" --ac "New criterion 2"`,
				{ cwd: TEST_DIR },
			);
			assert.strictEqual(result.exitCode, 0);

			const core = new Core(TEST_DIR);
			const proposal = await core.filesystem.loadProposal("proposal-1");
			assert.notStrictEqual(proposal, null);
			assert.ok(proposal?.rawContent?.includes("## Description"));
			assert.ok(
				proposal?.rawContent?.includes("Existing proposal description"),
			);
			assert.ok(proposal?.rawContent?.includes("## Acceptance Criteria"));
			assert.ok(proposal?.rawContent?.includes("- [ ] #1 New criterion 1"));
			assert.ok(proposal?.rawContent?.includes("- [ ] #2 New criterion 2"));
		});

		it("consolidates duplicate Acceptance Criteria sections with markers into one", async () => {
			const core = new Core(TEST_DIR);
			await core.createProposal(
				{
					id: "proposal-9",
					title: "Dup AC Proposal",
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-19",
					labels: [],
					dependencies: [],
					rawContent:
						"## Description\n\nX\n\n## Acceptance Criteria\n<!-- AC:BEGIN -->\n- [ ] #1 Old A\n<!-- AC:END -->\n\n## Acceptance Criteria\n<!-- AC:BEGIN -->\n- [ ] #1 Old B\n<!-- AC:END -->",
				},
				false,
			);

			// Add a new criterion via CLI; this triggers consolidation
			const result = execSync(
				`node --experimental-strip-types ${CLI_PATH} proposal edit 9 --ac "New C"`,
				{ cwd: TEST_DIR },
			);
			assert.strictEqual(result.exitCode, 0);

			const proposal = await core.filesystem.loadProposal("proposal-9");
			assert.notStrictEqual(proposal, null);
			const body = proposal?.rawContent || "";
			// Only one header and one marker pair should remain
			expect((body.match(/## Acceptance Criteria/g) || []).length).toBe(1);
			expect((body.match(/<!-- AC:BEGIN -->/g) || []).length).toBe(1);
			expect((body.match(/<!-- AC:END -->/g) || []).length).toBe(1);
			// New content should be present and renumbered
			assert.ok(body.includes("- [ ] #1 Old A"));
			assert.ok(body.includes("- [ ] #2 Old B"));
			assert.ok(body.includes("- [ ] #3 New C"));
		});

		it("consolidates legacy and marked AC sections to a single marked section", async () => {
			const core = new Core(TEST_DIR);
			await core.createProposal(
				{
					id: "proposal-10",
					title: "Mixed AC Proposal",
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-19",
					labels: [],
					dependencies: [],
					rawContent:
						"## Description\n\nY\n\n## Acceptance Criteria\n\n- [ ] Legacy 1\n- [ ] Legacy 2\n\n## Acceptance Criteria\n<!-- AC:BEGIN -->\n- [ ] #1 Marked 1\n<!-- AC:END -->",
				},
				false,
			);

			const result = execSync(
				`node --experimental-strip-types ${CLI_PATH} proposal edit proposal-10 --ac "Marked 2"`,
				{ cwd: TEST_DIR },
			);
			assert.strictEqual(result.exitCode, 0);

			const proposal = await core.filesystem.loadProposal("proposal-10");
			assert.notStrictEqual(proposal, null);
			const body = proposal?.rawContent || "";
			expect((body.match(/## Acceptance Criteria/g) || []).length).toBe(1);
			expect((body.match(/<!-- AC:BEGIN -->/g) || []).length).toBe(1);
			expect((body.match(/<!-- AC:END -->/g) || []).length).toBe(1);
			// Final section should be marked format and renumbered
			assert.ok(body.includes("- [ ] #1 Marked 1"));
			assert.ok(body.includes("- [ ] #2 Marked 2"));
			// No legacy-only lines remaining
			assert.ok(!body.includes("Legacy 1"));
			assert.ok(!body.includes("Legacy 2"));
		});

		it("should add to existing acceptance criteria", async () => {
			// First add some criteria via CLI to avoid direct body mutation
			const res = execSync(
				`node --experimental-strip-types ${CLI_PATH} proposal edit proposal-1 --ac "Old criterion 1" --ac "Old criterion 2"`,
				{ cwd: TEST_DIR },
			);
			assert.strictEqual(res.exitCode, 0);

			// Now add new criterion
			const result = execSync(
				`node --experimental-strip-types ${CLI_PATH} proposal edit proposal-1 --ac "New criterion"`,
				{ cwd: TEST_DIR },
			);
			assert.strictEqual(result.exitCode, 0);

			const core = new Core(TEST_DIR);
			const proposal = await core.filesystem.loadProposal("proposal-1");
			assert.notStrictEqual(proposal, null);
			assert.ok(proposal?.rawContent?.includes("## Acceptance Criteria"));
			assert.ok(proposal?.rawContent?.includes("- [ ] #1 Old criterion 1"));
			assert.ok(proposal?.rawContent?.includes("- [ ] #2 Old criterion 2"));
			assert.ok(proposal?.rawContent?.includes("- [ ] #3 New criterion"));
		});

		it("should update title and add acceptance criteria together", async () => {
			const result = execSync(
				`node --experimental-strip-types ${CLI_PATH} proposal edit proposal-1 -t "Updated Title" --ac "Must be updated" --ac "Must work"`,
				{ cwd: TEST_DIR },
			);
			assert.strictEqual(result.exitCode, 0);

			const core = new Core(TEST_DIR);
			const proposal = await core.filesystem.loadProposal("proposal-1");
			assert.notStrictEqual(proposal, null);
			assert.strictEqual(proposal?.title, "Updated Title");
			assert.ok(proposal?.rawContent?.includes("## Acceptance Criteria"));
			assert.ok(proposal?.rawContent?.includes("- [ ] #1 Must be updated"));
			assert.ok(proposal?.rawContent?.includes("- [ ] #2 Must work"));
		});
	});

	describe("acceptance criteria parsing", () => {
		it("should handle empty criteria gracefully", async () => {
			// Skip the --ac flag entirely when empty, as the shell API doesn't handle empty strings the same way
			const result = execSync(
				`node --experimental-strip-types ${CLI_PATH} proposal create "Test Proposal"`,
				{ cwd: TEST_DIR },
			);
			assert.strictEqual(result.exitCode, 0);

			const core = new Core(TEST_DIR);
			const proposal = await core.filesystem.loadProposal("proposal-1");
			assert.notStrictEqual(proposal, null);
			// Should not add acceptance criteria section for empty input
			assert.ok(!proposal?.rawContent?.includes("## Acceptance Criteria"));
		});

		it("should trim whitespace from criteria", async () => {
			const result = execSync(
				`node --experimental-strip-types ${CLI_PATH} proposal create "Test Proposal" --ac "  Criterion with spaces  " --ac "  Another one  "`,
				{ cwd: TEST_DIR },
			);
			assert.strictEqual(result.exitCode, 0);

			const core = new Core(TEST_DIR);
			const proposal = await core.filesystem.loadProposal("proposal-1");
			assert.notStrictEqual(proposal, null);
			assert.ok(
				proposal?.rawContent?.includes("- [ ] #1 Criterion with spaces"),
			);
			assert.ok(proposal?.rawContent?.includes("- [ ] #2 Another one"));
		});
	});

	describe("new AC management features", () => {
		beforeEach(async () => {
			const core = new Core(TEST_DIR);
			await core.createProposal(
				{
					id: "proposal-1",
					title: "Test Proposal",
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-19",
					labels: [],
					dependencies: [],
					rawContent: `## Description

Test proposal with acceptance criteria

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 First criterion
- [ ] #2 Second criterion
- [ ] #3 Third criterion
<!-- AC:END -->`,
				},
				false,
			);
		});

		it("should add new acceptance criteria with --ac", async () => {
			const result = execSync(
				`node --experimental-strip-types ${CLI_PATH} proposal edit proposal-1 --ac "Fourth criterion" --ac "Fifth criterion"`,
				{ cwd: TEST_DIR },
			);
			assert.strictEqual(result.exitCode, 0);

			const core = new Core(TEST_DIR);
			const proposal = await core.filesystem.loadProposal("proposal-1");
			assert.ok(proposal?.rawContent?.includes("- [ ] #1 First criterion"));
			assert.ok(proposal?.rawContent?.includes("- [ ] #2 Second criterion"));
			assert.ok(proposal?.rawContent?.includes("- [ ] #3 Third criterion"));
			assert.ok(proposal?.rawContent?.includes("- [ ] #4 Fourth criterion"));
			assert.ok(proposal?.rawContent?.includes("- [ ] #5 Fifth criterion"));
		});

		it("should remove acceptance criterion by index with --remove-ac", async () => {
			const result = execSync(
				`node --experimental-strip-types ${CLI_PATH} proposal edit proposal-1 --remove-ac 2`,
				{ cwd: TEST_DIR },
			);
			assert.strictEqual(result.exitCode, 0);

			const core = new Core(TEST_DIR);
			const proposal = await core.filesystem.loadProposal("proposal-1");
			assert.ok(proposal?.rawContent?.includes("- [ ] #1 First criterion"));
			assert.ok(!proposal?.rawContent?.includes("Second criterion"));
			assert.ok(proposal?.rawContent?.includes("- [ ] #2 Third criterion")); // Renumbered
		});

		it("removes acceptance criteria section after deleting all items", async () => {
			const result = execSync(
				`node --experimental-strip-types ${CLI_PATH} proposal edit proposal-1 --remove-ac 1 --remove-ac 2 --remove-ac 3`,
				{ cwd: TEST_DIR },
			);
			assert.strictEqual(result.exitCode, 0);

			const core = new Core(TEST_DIR);
			const proposal = await core.filesystem.loadProposal("proposal-1");
			const body = proposal?.rawContent || "";
			assert.ok(!body.includes("## Acceptance Criteria"));
			assert.ok(!body.includes("<!-- AC:BEGIN -->"));
			assert.ok(!body.includes("<!-- AC:END -->"));
		});

		it("should check acceptance criterion by index with --check-ac", async () => {
			const result = execSync(
				`node --experimental-strip-types ${CLI_PATH} proposal edit proposal-1 --check-ac 2`,
				{ cwd: TEST_DIR },
			);
			assert.strictEqual(result.exitCode, 0);

			const core = new Core(TEST_DIR);
			const proposal = await core.filesystem.loadProposal("proposal-1");
			assert.ok(proposal?.rawContent?.includes("- [ ] #1 First criterion"));
			assert.ok(proposal?.rawContent?.includes("- [x] #2 Second criterion"));
			assert.ok(proposal?.rawContent?.includes("- [ ] #3 Third criterion"));
		});

		it("should uncheck acceptance criterion by index with --uncheck-ac", async () => {
			// First check a criterion
			execSync(
				`node --experimental-strip-types ${CLI_PATH} proposal edit proposal-1 --check-ac 1`,
				{ cwd: TEST_DIR },
			);

			// Then uncheck it
			const result = execSync(
				`node --experimental-strip-types ${CLI_PATH} proposal edit proposal-1 --uncheck-ac 1`,
				{ cwd: TEST_DIR },
			);
			assert.strictEqual(result.exitCode, 0);

			const core = new Core(TEST_DIR);
			const proposal = await core.filesystem.loadProposal("proposal-1");
			assert.ok(proposal?.rawContent?.includes("- [ ] #1 First criterion"));
		});

		it("should handle multiple operations in one command", async () => {
			const result = execSync(
				`node --experimental-strip-types ${CLI_PATH} proposal edit proposal-1 --check-ac 1 --remove-ac 2 --ac "New criterion"`,
				{ cwd: TEST_DIR },
			);
			assert.strictEqual(result.exitCode, 0);

			const core = new Core(TEST_DIR);
			const proposal = await core.filesystem.loadProposal("proposal-1");
			assert.ok(proposal?.rawContent?.includes("- [x] #1 First criterion"));
			assert.ok(!proposal?.rawContent?.includes("Second criterion"));
			assert.ok(proposal?.rawContent?.includes("- [ ] #2 Third criterion")); // Renumbered
			assert.ok(proposal?.rawContent?.includes("- [ ] #3 New criterion"));
		});

		it("should error on invalid index for --remove-ac", async () => {
			const result = execSync(
				`node --experimental-strip-types ${CLI_PATH} proposal edit proposal-1 --remove-ac 10`,
				{ cwd: TEST_DIR },
			);
			assert.notStrictEqual(result.exitCode, 0);
			const msg = result.stderr.toString();
			assert.ok(
				/Acceptance criterion (?:#\d+(?:, #\d+)* )?not found/.test(msg),
			);
		});

		it("should error on invalid index for --check-ac", async () => {
			const result = execSync(
				`node --experimental-strip-types ${CLI_PATH} proposal edit proposal-1 --check-ac 10`,
				{ cwd: TEST_DIR },
			);
			assert.notStrictEqual(result.exitCode, 0);
			const msg = result.stderr.toString();
			assert.ok(
				/Acceptance criterion (?:#\d+(?:, #\d+)* )?not found/.test(msg),
			);
		});

		it("should error on non-numeric index", async () => {
			const result = execSync(
				`node --experimental-strip-types ${CLI_PATH} proposal edit proposal-1 --remove-ac abc`,
				{ cwd: TEST_DIR },
			);
			assert.notStrictEqual(result.exitCode, 0);
			expect(result.stderr.toString()).toContain("Invalid index");
		});

		it("should error on zero index", async () => {
			const result = execSync(
				`node --experimental-strip-types ${CLI_PATH} proposal edit proposal-1 --remove-ac 0`,
				{ cwd: TEST_DIR },
			);
			assert.notStrictEqual(result.exitCode, 0);
			expect(result.stderr.toString()).toContain("Invalid index");
		});

		it("should error on negative index", async () => {
			const result = execSync(
				`node --experimental-strip-types ${CLI_PATH} proposal edit proposal-1 --remove-ac=-1`,
				{ cwd: TEST_DIR },
			);
			assert.notStrictEqual(result.exitCode, 0);
			expect(result.stderr.toString()).toContain("Invalid index");
		});
	});

	describe("stable format migration", () => {
		it("should convert old format to stable format when editing", async () => {
			const core = new Core(TEST_DIR);
			await core.createProposal(
				{
					id: "proposal-2",
					title: "Old Format Proposal",
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-19",
					labels: [],
					dependencies: [],
					rawContent: `## Description

## Acceptance Criteria

- [ ] Old format criterion 1
- [x] Old format criterion 2`,
				},
				false,
			);

			const result = execSync(
				`node --experimental-strip-types ${CLI_PATH} proposal edit 2 --ac "New criterion"`,
				{ cwd: TEST_DIR },
			);
			assert.strictEqual(result.exitCode, 0);

			const proposal = await core.filesystem.loadProposal("proposal-2");
			assert.ok(proposal?.rawContent?.includes("<!-- AC:BEGIN -->"));
			assert.ok(
				proposal?.rawContent?.includes("- [ ] #1 Old format criterion 1"),
			);
			assert.ok(
				proposal?.rawContent?.includes("- [x] #2 Old format criterion 2"),
			);
			assert.ok(proposal?.rawContent?.includes("- [ ] #3 New criterion"));
			assert.ok(proposal?.rawContent?.includes("<!-- AC:END -->"));
		});
	});
});

describe("AcceptanceCriteriaManager unit tests", () => {
	let TEST_DIR_UNIT: string;
	const CLI_PATH_UNIT = join(process.cwd(), "src", "cli.ts");

	beforeEach(async () => {
		TEST_DIR_UNIT = createUniqueTestDir("test-acceptance-criteria-unit");
		await rm(TEST_DIR_UNIT, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR_UNIT, { recursive: true });
		execSync(`git init -b main`, { cwd: TEST_DIR_UNIT });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR_UNIT });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR_UNIT });

		const core = new Core(TEST_DIR_UNIT);
		await core.initializeProject("AC Unit Test Project");
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR_UNIT);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	test("should parse criteria with stable markers", () => {
		const content = `## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 First criterion
- [x] #2 Second criterion
- [ ] #3 Third criterion
<!-- AC:END -->`;

		const criteria = AcceptanceCriteriaManager.parseAcceptanceCriteria(content);
		assert.strictEqual(criteria.length, 3);
		assert.deepStrictEqual(criteria[0], {
			checked: false,
			text: "First criterion",
			index: 1,
		});
		assert.deepStrictEqual(criteria[1], {
			checked: true,
			text: "Second criterion",
			index: 2,
		});
		assert.deepStrictEqual(criteria[2], {
			checked: false,
			text: "Third criterion",
			index: 3,
		});
	});

	test("should format criteria with proper numbering", () => {
		const criteria = [
			{ checked: false, text: "First", index: 1 },
			{ checked: true, text: "Second", index: 2 },
		];

		const formatted =
			AcceptanceCriteriaManager.formatAcceptanceCriteria(criteria);
		assert.ok(formatted.includes("## Acceptance Criteria"));
		assert.ok(formatted.includes("<!-- AC:BEGIN -->"));
		assert.ok(formatted.includes("- [ ] #1 First"));
		assert.ok(formatted.includes("- [x] #2 Second"));
		assert.ok(formatted.includes("<!-- AC:END -->"));
	});

	test("preserves markdown headings inside acceptance criteria when updating", () => {
		const base = `## Acceptance Criteria
<!-- AC:BEGIN -->
### Critical
- [ ] #1 Must pass authentication

### Optional
- [ ] #2 Show detailed logs
<!-- AC:END -->`;

		const updated = AcceptanceCriteriaManager.updateContent(base, [
			{ index: 1, text: "Must pass authentication", checked: true },
			{ index: 2, text: "Show detailed logs", checked: false },
			{ index: 3, text: "Document audit trail", checked: false },
		]);

		const bodyMatch = updated.match(
			/<!-- AC:BEGIN -->([\s\S]*?)<!-- AC:END -->/,
		);
		assert.notStrictEqual(bodyMatch, null);
		const body = bodyMatch?.[1] || "";
		assert.ok(body.includes("### Critical"));
		assert.ok(body.includes("### Optional"));
		assert.ok(body.includes("- [x] #1 Must pass authentication"));
		assert.ok(body.includes("- [ ] #2 Show detailed logs"));
		assert.ok(body.includes("- [ ] #3 Document audit trail"));
		const orderIndex = body.indexOf("- [ ] #3 Document audit trail");
		assert.ok(orderIndex > body.indexOf("### Optional"));

		const reduced = AcceptanceCriteriaManager.updateContent(updated, [
			{ index: 1, text: "Must pass authentication", checked: false },
		]);
		const reducedBody =
			reduced.match(/<!-- AC:BEGIN -->([\s\S]*?)<!-- AC:END -->/)?.[1] || "";
		assert.ok(reducedBody.includes("### Critical"));
		assert.ok(reducedBody.includes("### Optional"));
		assert.ok(reducedBody.includes("- [ ] #1 Must pass authentication"));
		assert.ok(!reducedBody.includes("Show detailed logs"));
	});

	describe("Multi-value CLI operations", () => {
		it("should support multiple --ac flags in proposal create", async () => {
			const result = execSync(
				`node --experimental-strip-types ${CLI_PATH_UNIT} proposal create "Multi AC Test" --ac "First" --ac "Second" --ac "Third"`,
				{ cwd: TEST_DIR_UNIT },
			);
			assert.strictEqual(result.exitCode, 0);

			// Parse proposal ID from output
			const proposalId = result
				.toString()
				.match(/(?:Created proposal|Proposal)\s+([a-zA-Z0-9.-]+)/)?.[1];
			assert.ok(proposalId);

			// Verify ACs were created
			const proposalResult = execSync(
				`node --experimental-strip-types ${CLI_PATH_UNIT} proposal ${proposalId} --plain`,
				{ cwd: TEST_DIR_UNIT },
			);
			expect(proposalResult.stdout.toString()).toContain("- [ ] #1 First");
			expect(proposalResult.stdout.toString()).toContain("- [ ] #2 Second");
			expect(proposalResult.stdout.toString()).toContain("- [ ] #3 Third");
		});

		it("should support multiple --check-ac flags in single command", async () => {
			// Create proposal with multiple ACs
			const createResult = execSync(
				`node --experimental-strip-types ${CLI_PATH_UNIT} proposal create "Check Test" --ac "First" --ac "Second" --ac "Third" --ac "Fourth"`,
				{ cwd: TEST_DIR_UNIT },
			);
			const proposalId = createResult
				.toString()
				.match(/(?:Created proposal|Proposal)\s+([a-zA-Z0-9.-]+)/)?.[1];

			// Check multiple ACs at once
			const checkResult = execSync(
				`node --experimental-strip-types ${CLI_PATH_UNIT} proposal edit ${proposalId} --check-ac 1 --check-ac 3`,
				{ cwd: TEST_DIR_UNIT },
			);
			assert.strictEqual(checkResult.exitCode, 0);

			// Verify correct ACs were checked
			const proposalResult = execSync(
				`node --experimental-strip-types ${CLI_PATH_UNIT} proposal ${proposalId} --plain`,
				{ cwd: TEST_DIR_UNIT },
			);
			expect(proposalResult.stdout.toString()).toContain("- [x] #1 First");
			expect(proposalResult.stdout.toString()).toContain("- [ ] #2 Second");
			expect(proposalResult.stdout.toString()).toContain("- [x] #3 Third");
			expect(proposalResult.stdout.toString()).toContain("- [ ] #4 Fourth");
		});

		it("should support mixed AC operations in single command", async () => {
			// Create proposal with multiple ACs
			const createResult = execSync(
				`node --experimental-strip-types ${CLI_PATH_UNIT} proposal create "Mixed Test" --ac "First" --ac "Second" --ac "Third" --ac "Fourth"`,
				{ cwd: TEST_DIR_UNIT },
			);
			const proposalId = createResult
				.toString()
				.match(/(?:Created proposal|Proposal)\s+([a-zA-Z0-9.-]+)/)?.[1];

			// Check some ACs first
			execSync(
				`node --experimental-strip-types ${CLI_PATH_UNIT} proposal edit ${proposalId} --check-ac 1 --check-ac 2 --check-ac 3`,
				{ cwd: TEST_DIR_UNIT },
			);

			// Now do mixed operations: uncheck 1, keep 2 checked, check 4
			const mixedResult = execSync(
				`node --experimental-strip-types ${CLI_PATH_UNIT} proposal edit ${proposalId} --uncheck-ac 1 --check-ac 4`,
				{ cwd: TEST_DIR_UNIT },
			);
			assert.strictEqual(mixedResult.exitCode, 0);

			// Verify final proposal
			const proposalResult = execSync(
				`node --experimental-strip-types ${CLI_PATH_UNIT} proposal ${proposalId} --plain`,
				{ cwd: TEST_DIR_UNIT },
			);
			expect(proposalResult.stdout.toString()).toContain("- [ ] #1 First"); // unchecked
			expect(proposalResult.stdout.toString()).toContain("- [x] #2 Second"); // remained checked
			expect(proposalResult.stdout.toString()).toContain("- [x] #3 Third"); // remained checked
			expect(proposalResult.stdout.toString()).toContain("- [x] #4 Fourth"); // newly checked
		});

		it("should support multiple --remove-ac flags with proper renumbering", async () => {
			// Create proposal with 5 ACs
			const createResult = execSync(
				`node --experimental-strip-types ${CLI_PATH_UNIT} proposal create "Remove Test" --ac "First" --ac "Second" --ac "Third" --ac "Fourth" --ac "Fifth"`,
				{ cwd: TEST_DIR_UNIT },
			);
			const proposalId = createResult
				.toString()
				.match(/(?:Created proposal|Proposal)\s+([a-zA-Z0-9.-]+)/)?.[1];

			// Remove ACs 2 and 4 (should be processed in descending order to avoid index shifting)
			const removeResult = execSync(
				`node --experimental-strip-types ${CLI_PATH_UNIT} proposal edit ${proposalId} --remove-ac 2 --remove-ac 4`,
				{ cwd: TEST_DIR_UNIT },
			);
			assert.strictEqual(removeResult.exitCode, 0);

			// Verify remaining ACs are properly renumbered
			const proposalResult = execSync(
				`node --experimental-strip-types ${CLI_PATH_UNIT} proposal ${proposalId} --plain`,
				{ cwd: TEST_DIR_UNIT },
			);
			expect(proposalResult.stdout.toString()).toContain("- [ ] #1 First"); // original #1
			expect(proposalResult.stdout.toString()).toContain("- [ ] #2 Third"); // original #3 -> #2
			expect(proposalResult.stdout.toString()).toContain("- [ ] #3 Fifth"); // original #5 -> #3
			expect(proposalResult.stdout.toString()).not.toContain("Second"); // removed
			expect(proposalResult.stdout.toString()).not.toContain("Fourth"); // removed
		});

		it("should handle invalid indices gracefully in multi-value operations", async () => {
			// Create proposal with 2 ACs
			const createResult = execSync(
				`node --experimental-strip-types ${CLI_PATH_UNIT} proposal create "Invalid Test" --ac "First" --ac "Second"`,
				{ cwd: TEST_DIR_UNIT },
			);
			const proposalId = createResult
				.toString()
				.match(/(?:Created proposal|Proposal)\s+([a-zA-Z0-9.-]+)/)?.[1];

			// Try to check valid and invalid indices
			const checkResult = execSync(
				`node --experimental-strip-types ${CLI_PATH_UNIT} proposal edit ${proposalId} --check-ac 1 --check-ac 5`,
				{ cwd: TEST_DIR_UNIT },
			);
			assert.strictEqual(checkResult.exitCode, 1);
			expect(checkResult.stderr.toString()).toMatch(
				/Acceptance criterion #\d+ not found/,
			);
		});
	});
});
