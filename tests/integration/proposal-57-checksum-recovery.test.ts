/**
 * proposal-57: Frontmatter Checksum Recovery - Tests
 *
 * AC#1: Checksum computed on every proposal file write
 * AC#2: Corrupted files detected on read
 * AC#3: Atomic writes prevent partial updates
 * AC#4: Recovery from last known-good version
 */

import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	addChecksum,
	atomicWrite,
	computeChecksum,
	extractChecksum,
	getRecoveryPath,
	injectChecksum,
	parseAndValidate,
	readProposalWithIntegrity,
	recoverFromFile,
	stripChecksum,
	verifyChecksum,
} from "../../src/core/infrastructure/checksum.ts";

let TEST_DIR: string;

describe("proposal-57: Frontmatter Checksum Recovery", () => {
	beforeEach(() => {
		TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "checksum-test-"));
	});

	afterEach(() => {
		if (TEST_DIR && fs.existsSync(TEST_DIR)) {
			fs.rmSync(TEST_DIR, { recursive: true, force: true });
		}
	});

	describe("computeChecksum", () => {
		it("produces consistent SHA-256 hash", () => {
			const content = "test content";
			const hash1 = computeChecksum(content);
			const hash2 = computeChecksum(content);

			assert.strictEqual(hash1, hash2);
			assert.match(hash1, /^[a-f0-9]{64}$/);
		});

		it("different content produces different hashes", () => {
			const hash1 = computeChecksum("content A");
			const hash2 = computeChecksum("content B");

			assert.notStrictEqual(hash1, hash2);
		});

		it("empty string produces valid hash", () => {
			const hash = computeChecksum("");
			assert.match(hash, /^[a-f0-9]{64}$/);
		});

		it("handles unicode content", () => {
			const hash = computeChecksum("test unicode content");
			assert.match(hash, /^[a-f0-9]{64}$/);
		});
	});

	describe("extractChecksum", () => {
		it("extracts checksum from frontmatter", () => {
			const hash64 =
				"a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
			const fm = `id: proposal-57\ntitle: Test\nchecksum: "${hash64}"`;
			const checksum = extractChecksum(fm);
			assert.strictEqual(checksum, hash64);
		});

		it("extracts 64-char hex checksum", () => {
			const hash = "a".repeat(64);
			const fm = `checksum: "${hash}"`;
			assert.strictEqual(extractChecksum(fm), hash);
		});

		it("returns null when no checksum present", () => {
			const fm = "id: proposal-57\ntitle: Test";
			assert.strictEqual(extractChecksum(fm), null);
		});

		it("handles unquoted checksum", () => {
			const hash = "b".repeat(64);
			const fm = `checksum: ${hash}`;
			assert.strictEqual(extractChecksum(fm), hash);
		});
	});

	describe("stripChecksum", () => {
		it("removes checksum line from frontmatter", () => {
			const hash64 = "c".repeat(64);
			const fm = `id: proposal-57\ntitle: Test\nchecksum: "${hash64}"\npriority: high`;
			const stripped = stripChecksum(fm);
			assert.ok(!stripped.includes("checksum:"));
			assert.ok(stripped.includes("id: proposal-57"));
			assert.ok(stripped.includes("priority: high"));
		});

		it("handles frontmatter without checksum", () => {
			const fm = "id: proposal-57\ntitle: Test";
			assert.strictEqual(stripChecksum(fm), fm);
		});
	});

	describe("addChecksum", () => {
		it("adds checksum to frontmatter", () => {
			const fm = "id: proposal-57\ntitle: Test";
			const result = addChecksum(fm, "abc123");
			assert.ok(result.includes('checksum: "abc123"'));
			assert.ok(result.includes("id: proposal-57"));
		});
	});

	describe("verifyChecksum", () => {
		it("validates correct checksum", () => {
			const frontmatter = "id: proposal-57\ntitle: Test";
			const body = "This is the content body";
			const fullContent = `---\n${frontmatter}\n---\n${body}`;
			const checksum = computeChecksum(fullContent);

			const fmWithChecksum = addChecksum(frontmatter, checksum);
			const result = verifyChecksum(fmWithChecksum, body);

			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.expected, checksum);
		});

		it("detects invalid checksum", () => {
			const frontmatter = "id: proposal-57\ntitle: Test";
			const body = "Content";
			const fmWithChecksum = addChecksum(
				frontmatter,
				"invalid_checksum_12345678901234567890123456789012345678901234567890",
			);

			const result = verifyChecksum(fmWithChecksum, body);
			assert.strictEqual(result.valid, false);
		});

		it("returns false when no checksum present", () => {
			const result = verifyChecksum("id: proposal-57", "body");
			assert.strictEqual(result.valid, false);
		});
	});

	describe("injectChecksum", () => {
		it("injects checksum into serialized proposal content", () => {
			const content = `---
id: proposal-57
title: Test Checksum
status: Potential
---
## Description
Test content here`;

			const withChecksum = injectChecksum(content);

			assert.ok(withChecksum.includes("checksum:"));
			assert.match(withChecksum, /checksum: "[a-f0-9]{64}"/);
		});

		it("produces verifiable checksum", () => {
			const content = `---
id: proposal-57
title: Test
---
Body content`;

			const withChecksum = injectChecksum(content);
			const parsed = parseAndValidate(withChecksum);

			assert.strictEqual(parsed.hasChecksum, true);
			assert.strictEqual(parsed.checksumValid, true);
		});

		it("handles content without frontmatter", () => {
			const content = "Just plain content without frontmatter";
			const result = injectChecksum(content);
			assert.strictEqual(result, content);
		});

		it("replaces existing checksum with new one", () => {
			const content = `---
id: proposal-57
checksum: "old_checksum_12345678901234567890123456789012345678901234567890"
---
Body`;

			const withNewChecksum = injectChecksum(content);
			assert.ok(
				!withNewChecksum.includes(
					"old_checksum_12345678901234567890123456789012345678901234567890",
				),
			);
			assert.match(withNewChecksum, /checksum: "[a-f0-9]{64}"/);
		});
	});

	describe("parseAndValidate", () => {
		it("correctly parses valid proposal content", () => {
			const content = `---
id: proposal-57
title: Test
---
## Description
Content here`;

			const parsed = parseAndValidate(content);
			assert.strictEqual(parsed.hasChecksum, false);
			assert.ok(parsed.body.includes("## Description"));
		});

		it("validates content with checksum", () => {
			const rawContent = `---
id: proposal-57
title: Test
---
Body`;
			const withChecksum = injectChecksum(rawContent);
			const parsed = parseAndValidate(withChecksum);

			assert.strictEqual(parsed.hasChecksum, true);
			assert.strictEqual(parsed.checksumValid, true);
		});

		it("detects corrupted content", () => {
			const rawContent = `---
id: proposal-57
title: Test
---
Original body`;
			const withChecksum = injectChecksum(rawContent);

			// Corrupt the body
			const corrupted = withChecksum.replace("Original body", "Corrupted body");
			const parsed = parseAndValidate(corrupted);

			assert.strictEqual(parsed.hasChecksum, true);
			assert.strictEqual(parsed.checksumValid, false);
		});

		it("handles content without frontmatter delimiters", () => {
			const parsed = parseAndValidate("No frontmatter here");
			assert.strictEqual(parsed.hasChecksum, false);
			assert.strictEqual(parsed.body, "No frontmatter here");
		});
	});

	describe("atomicWrite", () => {
		it("writes file successfully", async () => {
			const filePath = path.join(TEST_DIR, "test-proposal.md");
			const content = "# Test Proposal\nContent here";

			await atomicWrite(filePath, content, TEST_DIR);

			const written = fs.readFileSync(filePath, "utf-8");
			assert.strictEqual(written, content);
		});

		it("creates directories if needed", async () => {
			const filePath = path.join(TEST_DIR, "subdir", "nested", "test.md");

			await atomicWrite(filePath, "content", TEST_DIR);

			const written = fs.readFileSync(filePath, "utf-8");
			assert.strictEqual(written, "content");
		});

		it("saves recovery copy before overwrite", async () => {
			const filePath = path.join(TEST_DIR, "proposal.md");
			const originalContent = "Original content";

			// First write
			await atomicWrite(filePath, originalContent, TEST_DIR);

			// Second write should backup the first
			await atomicWrite(filePath, "New content", TEST_DIR);

			const recoveryPath = getRecoveryPath(filePath, TEST_DIR);
			const recovered = fs.readFileSync(recoveryPath, "utf-8");
			assert.strictEqual(recovered, originalContent);
		});

		it("file exists and is complete after write", async () => {
			const filePath = path.join(TEST_DIR, "test.md");

			// Successful write
			await atomicWrite(filePath, "Complete content", TEST_DIR);

			// Verify file exists and is complete
			const content = fs.readFileSync(filePath, "utf-8");
			assert.strictEqual(content, "Complete content");
		});
	});

	describe("readProposalWithIntegrity", () => {
		it("reads valid proposal file with checksum", async () => {
			const filePath = path.join(TEST_DIR, "valid-proposal.md");
			const rawContent = `---
id: proposal-57
title: Valid Proposal
---
Body content`;

			const withChecksum = injectChecksum(rawContent);
			fs.writeFileSync(filePath, withChecksum, "utf-8");

			const result = await readProposalWithIntegrity(filePath, TEST_DIR);

			assert.strictEqual(result.verified, true);
			assert.strictEqual(result.recovered, false);
			assert.match(result.checksum ?? "", /^[a-f0-9]{64}$/);
		});

		it("reads legacy file without checksum", async () => {
			const filePath = path.join(TEST_DIR, "legacy-proposal.md");
			const content = `---
id: proposal-57
title: Legacy Proposal
---
No checksum here`;

			fs.writeFileSync(filePath, content, "utf-8");

			const result = await readProposalWithIntegrity(filePath, TEST_DIR);

			assert.strictEqual(result.verified, true); // Pass-through for legacy
			assert.strictEqual(result.checksum, null);
		});

		it("recovers corrupted file from backup", async () => {
			const filePath = path.join(TEST_DIR, "recoverable.md");
			const initialContent = "Initial content before good content";
			const goodContent = injectChecksum(`---
id: proposal-57
title: Good Content
---
Original body`);

			// Write initial content first
			fs.writeFileSync(filePath, initialContent, "utf-8");

			// Write good content (this backs up initial content and writes good)
			await atomicWrite(filePath, goodContent, TEST_DIR);

			// Write good content again to ensure we have a backup of it
			await atomicWrite(filePath, goodContent, TEST_DIR);

			// Corrupt the file
			const corrupted = goodContent.replace("Original body", "CORRUPTED");
			fs.writeFileSync(filePath, corrupted, "utf-8");

			// Read with integrity check should recover
			const result = await readProposalWithIntegrity(filePath, TEST_DIR);

			assert.strictEqual(result.recovered, true);
			assert.strictEqual(result.verified, true);
		});

		it("returns empty for non-existent file", async () => {
			const result = await readProposalWithIntegrity(
				path.join(TEST_DIR, "does-not-exist.md"),
				TEST_DIR,
			);

			assert.strictEqual(result.content, "");
			assert.strictEqual(result.verified, false);
		});
	});

	describe("recoverFromFile", () => {
		it("recovers from backup file", async () => {
			const filePath = path.join(TEST_DIR, "test.md");
			const backupContent = "Backup content";

			// Create a backup manually
			const recoveryPath = getRecoveryPath(filePath, TEST_DIR);
			fs.mkdirSync(path.join(TEST_DIR, ".recovery"), { recursive: true });
			fs.writeFileSync(recoveryPath, backupContent, "utf-8");

			const recovered = await recoverFromFile(filePath, TEST_DIR);
			assert.strictEqual(recovered, backupContent);
		});

		it("returns null when no backup exists", async () => {
			const filePath = path.join(TEST_DIR, "no-backup.md");
			const recovered = await recoverFromFile(filePath, TEST_DIR);
			assert.strictEqual(recovered, null);
		});
	});

	describe("getRecoveryPath", () => {
		it("generates deterministic recovery path", () => {
			const filePath = path.join(TEST_DIR, "proposals/test-proposal.md");
			const path1 = getRecoveryPath(filePath, TEST_DIR);
			const path2 = getRecoveryPath(filePath, TEST_DIR);

			assert.strictEqual(path1, path2);
			assert.ok(path1.includes(".recovery"));
			assert.ok(path1.includes(".bak"));
		});

		it("handles nested paths", () => {
			const filePath = path.join(TEST_DIR, "deep/nested/path/proposal.md");
			const recPath = getRecoveryPath(filePath, TEST_DIR);

			assert.ok(recPath.includes("deep__nested__path__proposal.md.bak"));
		});
	});

	describe("End-to-End Integrity Flow", () => {
		it("complete write-read-recovery cycle", async () => {
			const filePath = path.join(TEST_DIR, "e2e-proposal.md");
			const proposalContent = `---
id: proposal-57
title: E2E Test Proposal
status: Potential
created_date: '2026-03-24'
---
## Description
E2E test content for checksum recovery`;

			// Write initial content first so we have something to backup
			fs.writeFileSync(filePath, "Initial placeholder", "utf-8");

			// 1. Inject checksum and write (backs up initial, writes good content)
			const withChecksum = injectChecksum(proposalContent);
			await atomicWrite(filePath, withChecksum, TEST_DIR);

			// Write again to ensure backup of good content exists
			await atomicWrite(filePath, withChecksum, TEST_DIR);

			// 2. Read and verify
			let result = await readProposalWithIntegrity(filePath, TEST_DIR);
			assert.strictEqual(result.verified, true);
			assert.strictEqual(result.recovered, false);

			// 3. Corrupt the file
			const corrupted = withChecksum.replace("E2E test", "CORRUPTED test");
			fs.writeFileSync(filePath, corrupted, "utf-8");

			// 4. Read should detect corruption and recover
			result = await readProposalWithIntegrity(filePath, TEST_DIR);
			assert.strictEqual(result.recovered, true);
			assert.strictEqual(result.verified, true);
			assert.ok(result.content.includes("E2E test"));
		});

		it("multiple writes maintain recovery chain", async () => {
			const filePath = path.join(TEST_DIR, "chain.md");
			const versions = ["v1", "v2", "v3"];

			for (const version of versions) {
				const content = injectChecksum(`---\nid: TEST\n---\n${version}`);
				await atomicWrite(filePath, content, TEST_DIR);
			}

			// Recovery should have the v2 backup (from v3 write)
			const recoveryPath = getRecoveryPath(filePath, TEST_DIR);
			const backup = fs.readFileSync(recoveryPath, "utf-8");
			assert.ok(backup.includes("v2"));
		});
	});
});
