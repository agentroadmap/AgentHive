import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	CLI_MESSAGES,
	formatProposalId,
	formatProposalRef,
	formatStatus,
	generateMigrationGuide,
	isActiveStatus,
	isCompleteStatus,
	isNewStatus,
	isReviewStatus,
	migrateAllProposals,
	migrateProposalFile,
	normalizeStatus,
	parseFrontmatter,
	STATUS_DISPLAY,
	STATUS_EMOJI,
	TERMINOLOGY_MAP,
	TUI_LABELS,
} from "../../src/core/infrastructure/terminology.ts";

describe("AgentHive terminology", () => {
	let testDir: string;
	let proposalsDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "terminology-test-"));
		proposalsDir = join(testDir, "proposals");
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("normalizes legacy statuses into canonical AgentHive stages", () => {
		assert.equal(normalizeStatus("Draft"), "Draft");
		assert.equal(normalizeStatus("potential"), "Draft");
		assert.equal(normalizeStatus("Review"), "Review");
		assert.equal(normalizeStatus("Building"), "Develop");
		assert.equal(normalizeStatus("Active"), "Develop");
		assert.equal(normalizeStatus("Accepted"), "Merge");
		assert.equal(normalizeStatus("Reached"), "Complete");
		assert.equal(normalizeStatus("Abandoned"), "Discard");
		assert.equal(normalizeStatus("Unknown"), "Draft");
	});

	it("exposes canonical display names and emojis", () => {
		assert.equal(STATUS_DISPLAY.Draft, "Draft");
		assert.equal(STATUS_DISPLAY.Develop, "Develop");
		assert.equal(STATUS_DISPLAY.Merge, "Merge");
		assert.equal(STATUS_DISPLAY.Complete, "Complete");
		assert.equal(STATUS_DISPLAY.Discard, "Discard");

		assert.equal(STATUS_EMOJI.Draft, "⚪");
		assert.equal(STATUS_EMOJI.Review, "🟡");
		assert.equal(STATUS_EMOJI.Develop, "🔵");
		assert.equal(STATUS_EMOJI.Merge, "🧩");
		assert.equal(STATUS_EMOJI.Complete, "✅");
		assert.equal(STATUS_EMOJI.Discard, "🗑");
	});

	it("formats status and status predicates around canonical stages", () => {
		assert.ok(formatStatus("Building").includes("Develop"));
		assert.ok(formatStatus("Accepted").includes("Merge"));
		assert.equal(isCompleteStatus("Complete"), true);
		assert.equal(isActiveStatus("Develop"), true);
		assert.equal(isActiveStatus("Accepted"), false);
		assert.equal(isReviewStatus("Review"), true);
		assert.equal(isNewStatus("Draft"), true);
	});

	it("keeps proposal-centric terminology", () => {
		assert.equal(TERMINOLOGY_MAP.proposal, "proposal");
		assert.equal(TUI_LABELS.boardTitle, "Proposal Board");
		assert.ok(CLI_MESSAGES.proposalCreated("proposal-1").includes("Proposal 1"));
		assert.equal(formatProposalId("proposal-42"), "Proposal 42");
		assert.equal(
			formatProposalRef("proposal-42", "Refactor queue"),
			"Proposal 42: Refactor queue",
		);
	});

	it("parses frontmatter with canonical status normalization", () => {
		const fm = parseFrontmatter(`---
id: proposal-1
status: Accepted
---
Body`);
		assert.equal(fm.id, "proposal-1");
		assert.equal(fm.status, "Merge");
	});

	it("migrates legacy status labels in proposal files", () => {
		mkdirSync(proposalsDir, { recursive: true });
		const filePath = join(proposalsDir, "proposal-1.md");
		writeFileSync(
			filePath,
			`---
id: proposal-1
status: Building
---
Body`,
		);
		const result = migrateProposalFile(filePath);
		assert.ok(result.changes.includes("Legacy status: Building → Develop"));
		assert.ok(result.migrated.includes("status: Develop"));
	});

	it("migrates legacy statuses across a directory", () => {
		mkdirSync(proposalsDir, { recursive: true });
		writeFileSync(
			join(proposalsDir, "proposal-1.md"),
			`---
id: proposal-1
status: Reached
---
Done`,
		);
		writeFileSync(
			join(proposalsDir, "proposal-2.md"),
			`---
id: proposal-2
status: Accepted
---
Ready`,
		);
		writeFileSync(
			join(proposalsDir, "proposal-3.md"),
			`---
id: proposal-3
status: Draft
---
Fresh`,
		);

		const result = migrateAllProposals(proposalsDir);
		assert.equal(result.totalFiles, 3);
		assert.equal(result.changedFiles, 2);
	});

	it("describes the AgentHive migration path", () => {
		const guide = generateMigrationGuide();
		assert.ok(guide.includes("AgentHive Proposal Workflow"));
		assert.ok(guide.includes("Draft -> Review -> Develop -> Merge -> Complete"));
		assert.ok(guide.includes("Accepted | Merge"));
		assert.ok(guide.includes('Do not rewrite proposal language to "component"'));
	});
});
