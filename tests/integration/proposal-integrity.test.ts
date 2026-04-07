/**
 * Tests for Frontmatter Checksum & Recovery (proposal-57)
 *
 * AC#1: Checksum computed on every proposal file write
 * AC#2: Corrupted files detected on read
 * AC#3: Atomic writes prevent partial updates
 * AC#4: Recovery from last known-good version
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import {
	computeChecksum,
	extractChecksum,
	formatIntegrityReport,
	injectChecksum,
	ProposalIntegrity,
	parseFrontmatter,
	verifyChecksum,
} from "../../src/core/proposal/proposal-integrity.ts";

describe("Checksum Utilities (proposal-57)", () => {
	it("computeChecksum should produce consistent SHA-256", () => {
		const content = "Hello, World!";
		const hash1 = computeChecksum(content);
		const hash2 = computeChecksum(content);

		assert.equal(hash1, hash2, "Same content should produce same checksum");
		assert.equal(hash1.length, 64, "SHA-256 should be 64 hex chars");
	});

	it("computeChecksum should differ for different content", () => {
		const hash1 = computeChecksum("content1");
		const hash2 = computeChecksum("content2");

		assert.notEqual(
			hash1,
			hash2,
			"Different content should produce different checksums",
		);
	});

	it("parseFrontmatter should extract frontmatter and body", () => {
		const content = `---
id: proposal-1
title: Test Proposal
status: Active
---

This is the body content.`;

		const result = parseFrontmatter(content);

		assert.ok(result.hasFrontmatter, "Should detect frontmatter");
		assert.ok(
			result.frontmatter.includes("id: proposal-1"),
			"Should extract frontmatter",
		);
		assert.ok(result.body.includes("This is the body"), "Should extract body");
	});

	it("parseFrontmatter should handle content without frontmatter", () => {
		const content = "Just some text without frontmatter";

		const result = parseFrontmatter(content);

		assert.equal(result.hasFrontmatter, false);
		assert.equal(result.body, content);
	});

	it("injectChecksum should add checksum to frontmatter", () => {
		const frontmatter = "id: proposal-1\ntitle: Test";
		const checksum = "abcdef1234567890";

		const result = injectChecksum(frontmatter, checksum);

		assert.ok(
			result.includes(`roadmap-checksum: "${checksum}"`),
			"Should include checksum",
		);
		assert.ok(
			result.includes("id: proposal-1"),
			"Should preserve original content",
		);
	});

	it("injectChecksum should replace existing checksum", () => {
		const frontmatter =
			'id: proposal-1\nroadmap-checksum: "old123"\ntitle: Test';
		const newChecksum = "newabcdef456";

		const result = injectChecksum(frontmatter, newChecksum);

		assert.ok(
			result.includes(`roadmap-checksum: "${newChecksum}"`),
			"Should have new checksum",
		);
		assert.ok(!result.includes("old123"), "Should not have old checksum");
	});

	it("extractChecksum should extract existing checksum", () => {
		const frontmatter = `id: proposal-1
title: Test
roadmap-checksum: "abcdef1234567890"`;

		const checksum = extractChecksum(frontmatter);

		assert.equal(checksum, "abcdef1234567890");
	});

	it("extractChecksum should return null if no checksum", () => {
		const frontmatter = "id: proposal-1\ntitle: Test";

		const checksum = extractChecksum(frontmatter);

		assert.equal(checksum, null);
	});

	it("verifyChecksum should validate correct content", () => {
		const body = "Test content";
		const checksum = computeChecksum(body);
		const content = `---
id: proposal-1
roadmap-checksum: "${checksum}"
---

${body}`;

		const result = verifyChecksum(content);

		assert.ok(result.valid, "Should be valid");
		assert.equal(result.stored, checksum);
		assert.equal(result.computed, checksum);
	});

	it("verifyChecksum should detect invalid content", () => {
		const content = `---
id: proposal-1
roadmap-checksum: "wrongchecksum"
---

Actual content`;

		const result = verifyChecksum(content);

		assert.equal(result.valid, false, "Should be invalid");
		assert.ok(
			result.stored !== result.computed,
			"Stored and computed should differ",
		);
	});
});

describe("ProposalIntegrity (proposal-57)", () => {
	let tempDir: string;
	let integrity: ProposalIntegrity;
	let proposalsDir: string;
	let backupDir: string;

	before(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "roadmap-integrity-test-"));
		proposalsDir = join(tempDir, "proposals");
		backupDir = join(tempDir, "backups");
		await mkdir(proposalsDir, { recursive: true });
	});

	beforeEach(async () => {
		integrity = new ProposalIntegrity({ proposalsDir, backupDir });
		await integrity.initialize();
	});

	after(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	// ─── AC#1: Checksum on Write ─────────────────────────────────────

	describe("AC#1: Checksum computed on write", () => {
		it("should add checksum to content", async () => {
			const content = `---
id: proposal-1
title: Test Proposal
status: Active
---

Body content here.`;

			const withChecksum = await integrity.addChecksum(content);

			assert.ok(
				withChecksum.includes("roadmap-checksum:"),
				"Should include checksum header",
			);
			assert.ok(
				withChecksum.includes("---"),
				"Should preserve frontmatter delimiters",
			);

			// Verify the checksum is valid
			const { valid } = verifyChecksum(withChecksum);
			assert.ok(valid, "Generated checksum should be valid");
		});

		it("should write proposal file with checksum", async () => {
			const filePath = join(proposalsDir, "proposal-1-test.md");
			const content = `---
id: proposal-1
title: Test
status: Active
---

Test body`;

			await integrity.writeProposalFile(filePath, content);

			const written = await readFile(filePath, "utf-8");
			assert.ok(
				written.includes("roadmap-checksum:"),
				"Written file should have checksum",
			);

			// Verify file
			const result = await integrity.verifyFile(filePath);
			assert.ok(result.isValid, "Written file should pass verification");
		});
	});

	// ─── AC#2: Corruption Detection ──────────────────────────────────

	describe("AC#2: Corrupted files detected on read", () => {
		it("should detect valid file", async () => {
			const filePath = join(proposalsDir, "proposal-valid.md");
			const content = `---
id: proposal-VALID
title: Valid Proposal
status: Active
---

Valid content`;

			await integrity.writeProposalFile(filePath, content);
			const result = await integrity.verifyFile(filePath);

			assert.equal(result.isValid, true);
			assert.equal(result.corruptionType, "none");
		});

		it("should detect missing checksum", async () => {
			const filePath = join(proposalsDir, "proposal-no-checksum.md");
			await writeFile(
				filePath,
				`---
id: proposal-NO-CS
title: No Checksum
status: Active
---

Content without checksum`,
			);

			const result = await integrity.verifyFile(filePath);

			assert.equal(result.isValid, false);
			assert.equal(result.corruptionType, "missing_checksum");
		});

		it("should detect checksum mismatch", async () => {
			const filePath = join(proposalsDir, "proposal-tampered.md");
			await writeFile(
				filePath,
				`---
id: proposal-TAMPERED
title: Tampered
status: Active
roadmap-checksum: "0000000000000000000000000000000000000000000000000000000000000000"
---

Tampered content`,
			);

			const result = await integrity.verifyFile(filePath);

			assert.equal(result.isValid, false);
			assert.equal(result.corruptionType, "checksum_mismatch");
			assert.ok(result.expectedChecksum, "Should provide expected checksum");
		});

		it("should detect missing file", async () => {
			const filePath = join(proposalsDir, "nonexistent.md");

			const result = await integrity.verifyFile(filePath);

			assert.equal(result.isValid, false);
			assert.equal(result.corruptionType, "file_not_found");
		});

		it("should detect malformed frontmatter", async () => {
			const filePath = join(proposalsDir, "proposal-no-frontmatter.md");
			await writeFile(filePath, "Just some text without frontmatter");

			const result = await integrity.verifyFile(filePath);

			assert.equal(result.isValid, false);
			assert.equal(result.corruptionType, "malformed_frontmatter");
		});
	});

	// ─── AC#3: Atomic Writes ─────────────────────────────────────────

	describe("AC#3: Atomic writes prevent partial updates", () => {
		it("should write file atomically", async () => {
			const filePath = join(proposalsDir, "proposal-atomic.md");
			const content = "Atomic write content";

			await integrity.atomicWrite(filePath, content);

			const written = await readFile(filePath, "utf-8");
			assert.equal(written, content);
		});

		it("should not leave temp files on success", async () => {
			const filePath = join(proposalsDir, "proposal-clean.md");
			await integrity.atomicWrite(filePath, "Clean content");

			// Check no .tmp files remain
			const dir = proposalsDir;
			const files = await (await import("node:fs/promises")).readdir(dir);
			const tempFiles = files.filter((f) => f.includes(".tmp-"));
			assert.equal(tempFiles.length, 0, "No temp files should remain");
		});
	});

	// ─── AC#4: Recovery ──────────────────────────────────────────────

	describe("AC#4: Recovery from last known-good version", () => {
		it("should create backups on write", async () => {
			const filePath = join(proposalsDir, "proposal-backup.md");
			const content1 = `---
id: proposal-BACKUP
title: Backup Test
status: Active
---

First version`;

			await integrity.writeProposalFile(filePath, content1);

			const result = await integrity.verifyFile(filePath);
			assert.ok(result.isValid);
		});

		it("should recover from backup", async () => {
			const filePath = join(proposalsDir, "proposal-recover.md");
			const content1 = `---
id: proposal-RECOVER
title: Recovery Test
status: Active
---

Original content`;

			const content2 = `---
id: proposal-RECOVER
title: Recovery Test
status: Active
---

Second version content`;

			// Write initial version (no backup yet - file doesn't exist)
			await integrity.writeProposalFile(filePath, content1);

			// Write second version (this creates backup of content1)
			await integrity.writeProposalFile(filePath, content2);

			// Verify it's valid
			const validResult = await integrity.verifyFile(filePath);
			assert.ok(validResult.isValid, "File should be valid after second write");

			// Corrupt the file
			await writeFile(
				filePath,
				`---
id: proposal-RECOVER
title: Recovery Test
status: Active
roadmap-checksum: "wrong"
---

Corrupted content`,
			);

			// Verify it's corrupted
			const corruptedResult = await integrity.verifyFile(filePath);
			assert.equal(corruptedResult.isValid, false);

			// Recover
			const repair = await integrity.recoverFile(filePath);
			assert.ok(repair, "Should be able to recover");
			assert.equal(repair.action, "restored_from_backup");

			// Verify recovery worked
			const recoveredResult = await integrity.verifyFile(filePath);
			assert.ok(recoveredResult.isValid, "Recovered file should be valid");
		});

		it("should return null if no good backup exists", async () => {
			const filePath = join(proposalsDir, "proposal-no-backup.md");

			const repair = await integrity.recoverFile(filePath);

			assert.equal(repair, null, "Should return null if no backup");
		});
	});

	// ─── Full Scan ───────────────────────────────────────────────────

	describe("Full directory scan", () => {
		it("should scan all proposal files", async () => {
			// Create test files
			const validPath = join(proposalsDir, "proposal-1-valid.md");
			const corruptedPath = join(proposalsDir, "proposal-2-corrupted.md");

			await integrity.writeProposalFile(
				validPath,
				`---
id: proposal-1
title: Valid
status: Active
---

Valid content`,
			);

			await writeFile(
				corruptedPath,
				`---
id: proposal-2
title: Corrupted
status: Active
roadmap-checksum: "bad"
---

Bad content`,
			);

			const report = await integrity.scanAll();

			assert.ok(report.totalFiles >= 2, "Should find files");
			assert.ok(report.scanTime, "Should have scan timestamp");

			const validResult = report.results.find((r) => r.path === validPath);
			assert.ok(validResult?.isValid, "Valid file should pass");

			const corruptedResult = report.results.find(
				(r) => r.path === corruptedPath,
			);
			assert.ok(!corruptedResult?.isValid, "Corrupted file should fail");
		});
	});

	// ─── Format Report ───────────────────────────────────────────────

	describe("Format integrity report", () => {
		it("should format report as text", () => {
			const report = {
				scanTime: "2026-03-24T02:00:00.000Z",
				totalFiles: 2,
				validFiles: 1,
				corruptedFiles: 1,
				repairs: [],
				results: [
					{
						path: "proposal-1.md",
						isValid: true,
						checksum: {
							version: "1.0",
							checksum: "abc123",
							algorithm: "sha256",
							createdAt: "",
							contentLength: 100,
						},
						expectedChecksum: "abc123",
						corruptionType: "none" as const,
						lastKnownGood: null,
					},
					{
						path: "proposal-2.md",
						isValid: false,
						checksum: null,
						expectedChecksum: "def456",
						corruptionType: "checksum_mismatch" as const,
						lastKnownGood: "backups/proposal-2.md/old.bak",
					},
				],
			};

			const text = formatIntegrityReport(report);

			assert.ok(
				text.includes("Proposal Integrity Report"),
				"Should have title",
			);
			assert.ok(text.includes("Total Files: 2"), "Should show total");
			assert.ok(
				text.includes("Corrupted Files: 1"),
				"Should show corrupted count",
			);
			assert.ok(text.includes("proposal-2.md"), "Should list corrupted files");
		});
	});
});
