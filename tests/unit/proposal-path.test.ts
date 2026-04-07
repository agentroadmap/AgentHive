import assert from "node:assert";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import {
	getProposalFilename,
	getProposalPath,
	normalizeProposalId,
	proposalFileExists,
	proposalIdsEqual,
} from "../../src/utils/proposal-path.ts";
import {
	createUniqueTestDir,
	execSync,
	expect,
	safeCleanup,
} from "../support/test-utils.ts";

describe("Proposal path utilities", () => {
	let TEST_DIR: string;
	let core: Core;

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-proposal-path");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });

		// Configure git for tests - required for CI
		execSync(`git init`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });

		core = new Core(TEST_DIR);
		await core.initializeProject("Test Project");

		// Create some test proposal files
		const proposalsDir = core.filesystem.proposalsDir;
		await writeFile(
			join(proposalsDir, "proposal-123 - Test Proposal.md"),
			"# Test Proposal 123",
		);
		await writeFile(
			join(proposalsDir, "proposal-456 - Another Proposal.md"),
			"# Another Proposal 456",
		);
		await writeFile(
			join(proposalsDir, "proposal-789 - Final Proposal.md"),
			"# Final Proposal 789",
		);
		// Additional: padded and dotted ids
		await writeFile(
			join(proposalsDir, "proposal-0001 - Padded One.md"),
			"# Padded One",
		);
		await writeFile(
			join(proposalsDir, "proposal-3.01 - Subproposal Padded.md"),
			"# Subproposal Padded 3.01",
		);
		await writeFile(
			join(proposalsDir, "RFC-20260401-MESSAGING.md"),
			"# Messaging RFC",
		);
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	describe("normalizeProposalId", () => {
		it("should add uppercase proposal- prefix if missing", () => {
			expect(normalizeProposalId("123")).toBe("proposal-123");
			expect(normalizeProposalId("456")).toBe("proposal-456");
		});

		it("should normalize existing prefix to uppercase", () => {
			expect(normalizeProposalId("proposal-123")).toBe("proposal-123");
			expect(normalizeProposalId("proposal-456")).toBe("proposal-456");
		});

		it("should preserve non-default prefixes when present (lowercase)", () => {
			expect(normalizeProposalId("JIRA-456")).toBe("jira-456");
			expect(normalizeProposalId("jira-789")).toBe("jira-789");
		});

		it("should handle empty strings", () => {
			expect(normalizeProposalId("")).toBe("proposal-");
		});

		it("should normalize mixed-case prefixes to uppercase", () => {
			expect(normalizeProposalId("proposal-001")).toBe("proposal-001");
			expect(normalizeProposalId("Proposal-42")).toBe("proposal-42");
			expect(normalizeProposalId("proposal-99")).toBe("proposal-99");
		});

		it("should work with custom prefixes (lowercase output)", () => {
			expect(normalizeProposalId("123", "JIRA")).toBe("jira-123");
			expect(normalizeProposalId("JIRA-456", "JIRA")).toBe("jira-456");
			expect(normalizeProposalId("jira-789", "JIRA")).toBe("jira-789");
		});

		it("should work with draft prefix (uppercase output)", () => {
			expect(normalizeProposalId("1", "draft")).toBe("draft-1");
			expect(normalizeProposalId("draft-5", "draft")).toBe("draft-5");
		});
	});

	describe("proposalIdsEqual", () => {
		it("should compare IDs case-insensitively", () => {
			expect(proposalIdsEqual("proposal-123", "proposal-123")).toBe(true);
			expect(proposalIdsEqual("Proposal-456", "proposal-456")).toBe(true);
		});

		it("should handle numeric comparison (leading zeros)", () => {
			expect(proposalIdsEqual("proposal-1", "proposal-01")).toBe(true);
			expect(proposalIdsEqual("proposal-001", "proposal-1")).toBe(true);
		});

		it("should compare subproposal IDs correctly", () => {
			expect(proposalIdsEqual("proposal-1.2", "proposal-1.2")).toBe(true);
			expect(proposalIdsEqual("proposal-1.2", "proposal-1.02")).toBe(true);
			expect(proposalIdsEqual("proposal-1.2", "proposal-1.3")).toBe(false);
		});

		it("should work with custom prefixes", () => {
			expect(proposalIdsEqual("JIRA-100", "jira-100", "JIRA")).toBe(true);
			expect(proposalIdsEqual("100", "JIRA-100", "JIRA")).toBe(true);
		});

		it("should return false for different IDs", () => {
			expect(proposalIdsEqual("proposal-1", "proposal-2")).toBe(false);
			expect(proposalIdsEqual("proposal-1.1", "proposal-1.2")).toBe(false);
		});

		it("should NOT match IDs with non-numeric suffixes (prevent parseInt coercion)", () => {
			// IDs with trailing letters should NOT match the numeric portion
			// This tests the extractProposalBody regex validation
			expect(proposalIdsEqual("proposal-123a", "proposal-123")).toBe(false);
			expect(proposalIdsEqual("proposal-1.2x", "proposal-1.2")).toBe(false);
			expect(proposalIdsEqual("123a", "proposal-123")).toBe(false);
		});
	});

	describe("getProposalPath", () => {
		it("should return full path for existing proposal", async () => {
			const path = await getProposalPath("123", core);
			assert.ok(path);
			assert.ok(path.includes("proposal-123 - Test Proposal.md"));
			assert.ok(path.includes(core.filesystem.proposalsDir));
		});

		it("should NOT match when input has non-numeric characters (e.g., typos)", async () => {
			// "123a" should NOT match proposal-123 (prevent parseInt coercion bugs)
			const path = await getProposalPath("123a", core);
			assert.strictEqual(path, null);

			// "456x" should NOT match proposal-456
			const path2 = await getProposalPath("456x", core);
			assert.strictEqual(path2, null);

			// "1.2x" should NOT match any subproposal
			const path3 = await getProposalPath("1.2x", core);
			assert.strictEqual(path3, null);

			// Leading non-numeric characters
			const path4 = await getProposalPath("a123", core);
			assert.strictEqual(path4, null);

			// Mixed non-numeric in dotted segments
			const path5 = await getProposalPath("3.a1", core);
			assert.strictEqual(path5, null);

			// Hex-like input should not match decimal
			const path6 = await getProposalPath("0x123", core);
			assert.strictEqual(path6, null);
		});

		it("should work with proposal- prefix", async () => {
			const path = await getProposalPath("proposal-456", core);
			assert.ok(path);
			assert.ok(path.includes("proposal-456 - Another Proposal.md"));
		});

		it("should resolve RFC-style filenames without title suffixes", async () => {
			const path = await getProposalPath("RFC-20260401-MESSAGING", core);
			assert.ok(path);
			assert.ok(path.includes("RFC-20260401-MESSAGING.md"));
		});

		it("should resolve zero-padded numeric IDs to the same proposal", async () => {
			// File exists as proposal-0001; query with 1
			const path1 = await getProposalPath("1", core);
			assert.ok(path1);
			assert.ok(path1.includes("proposal-0001 - Padded One.md"));

			// Query with zero-padded input for non-padded file (123)
			const path2 = await getProposalPath("0123", core);
			assert.ok(path2);
			assert.ok(path2.includes("proposal-123 - Test Proposal.md"));
		});

		it("should resolve case-insensitive proposal IDs", async () => {
			const uppercase = await getProposalPath("proposal-0001", core);
			assert.ok(uppercase);
			assert.ok(uppercase.includes("proposal-0001 - Padded One.md"));

			const mixedCase = await getProposalPath("Proposal-456", core);
			assert.ok(mixedCase);
			assert.ok(mixedCase.includes("proposal-456 - Another Proposal.md"));
		});

		it("should return null for non-existent proposal", async () => {
			const path = await getProposalPath("999", core);
			assert.strictEqual(path, null);
		});

		it("should handle errors gracefully", async () => {
			// Pass invalid core to trigger error
			const path = await getProposalPath("123", null as unknown as Core);
			assert.strictEqual(path, null);
		});
	});

	describe("getProposalFilename", () => {
		it("should return filename for existing proposal", async () => {
			const filename = await getProposalFilename("789", core);
			assert.strictEqual(filename, "proposal-789 - Final Proposal.md");
		});

		it("should resolve dotted IDs ignoring leading zeros in segments", async () => {
			const filename = await getProposalFilename("3.1", core);
			assert.strictEqual(filename, "proposal-3.01 - Subproposal Padded.md");
		});

		it("should resolve case-insensitive IDs when fetching filenames", async () => {
			const filename = await getProposalFilename("proposal-789", core);
			assert.strictEqual(filename, "proposal-789 - Final Proposal.md");
		});

		it("should return RFC-style filenames without title suffixes", async () => {
			const filename = await getProposalFilename(
				"RFC-20260401-MESSAGING",
				core,
			);
			assert.strictEqual(filename, "RFC-20260401-MESSAGING.md");
		});

		it("should return null for non-existent proposal", async () => {
			const filename = await getProposalFilename("999", core);
			assert.strictEqual(filename, null);
		});
	});

	describe("proposalFileExists", () => {
		it("should return true for existing proposals", async () => {
			const exists = await proposalFileExists("123", core);
			assert.strictEqual(exists, true);
		});

		it("should return false for non-existent proposals", async () => {
			const exists = await proposalFileExists("999", core);
			assert.strictEqual(exists, false);
		});

		it("should work with proposal- prefix", async () => {
			const exists = await proposalFileExists("proposal-456", core);
			assert.strictEqual(exists, true);
		});
	});

	describe("integration with Core default", () => {
		it("should work without explicit core parameter when in valid project", async () => {
			// Change to test directory to use default Core
			const originalCwd = process.cwd();
			process.chdir(TEST_DIR);

			try {
				const path = await getProposalPath("123");
				assert.ok(path);
				assert.ok(path.includes("proposal-123 - Test Proposal.md"));
			} finally {
				process.chdir(originalCwd);
			}
		});
	});

	describe("numeric ID lookup with custom prefix", () => {
		beforeEach(async () => {
			// Create proposals with custom prefix (simulating configured prefix)
			const proposalsDir = core.filesystem.proposalsDir;
			await writeFile(
				join(proposalsDir, "back-358 - Custom Prefix Proposal.md"),
				"# Custom Prefix Proposal",
			);
			await writeFile(
				join(proposalsDir, "back-5.1 - Custom Subproposal.md"),
				"# Custom Subproposal",
			);
		});

		it("should find proposal by numeric ID when file has custom prefix", async () => {
			// Numeric-only lookup should find "back-358" when searching all files
			const path = await getProposalPath("358", core);
			assert.ok(path);
			assert.ok(path.includes("back-358 - Custom Prefix Proposal.md"));
		});

		it("should find subproposal by dotted numeric ID with custom prefix", async () => {
			const path = await getProposalPath("5.1", core);
			assert.ok(path);
			assert.ok(path.includes("back-5.1 - Custom Subproposal.md"));
		});

		it("should NOT match numeric ID with typo even when custom prefix exists", async () => {
			// "358a" should NOT match "back-358" (the core parseInt coercion bug)
			const path = await getProposalPath("358a", core);
			assert.strictEqual(path, null);

			// "5.1x" should NOT match "back-5.1"
			const path2 = await getProposalPath("5.1x", core);
			assert.strictEqual(path2, null);
		});

		it("should find proposal when using full prefixed ID", async () => {
			const path = await getProposalPath("back-358", core);
			assert.ok(path);
			assert.ok(path.includes("back-358 - Custom Prefix Proposal.md"));
		});

		it("should be case-insensitive for prefixed lookups", async () => {
			const path = await getProposalPath("BACK-358", core);
			assert.ok(path);
			assert.ok(path.includes("back-358 - Custom Prefix Proposal.md"));
		});
	});

	describe("getProposalFilename with non-numeric input", () => {
		it("should NOT match filenames when input has non-numeric characters", async () => {
			// Same validation as getProposalPath applies to getProposalFilename
			const filename = await getProposalFilename("789x", core);
			assert.strictEqual(filename, null);

			const filename2 = await getProposalFilename("3.a1", core);
			assert.strictEqual(filename2, null);
		});
	});
});
