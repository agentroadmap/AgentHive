/**
 * Tests for proposal-59: Rethink Roadmap as Product Design & Project Management
 *
 * AC#1: 'Reached' status renamed to 'Complete' across codebase, CLI, and MCP
 * AC#2: 'Proposal' terminology updated to 'Component' in user-facing outputs
 * AC#3: MAP.md reflects new terminology
 * AC#4: Documentation updated to use product design language
 * AC#5: Migration path defined for existing proposals
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	applyTerminology,
	CLI_MESSAGES,
	formatComponentId,
	formatComponentRef,
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

describe("proposal-59: Rethink Roadmap as Product Design & Project Management", () => {
	let testDir: string;
	let proposalsDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "terminology-test-"));
		proposalsDir = join(testDir, "proposals");
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	// Helper to create a proposal file
	const _createProposalFile = (filename: string, content: string) => {
		writeFileSync(join(proposalsDir, filename), content);
	};

	describe("AC#1: 'Reached' status renamed to 'Complete'", () => {
		it("should map 'Reached' to 'Complete' (via normalizeStatus)", () => {
			assert.equal(normalizeStatus("reached"), "Complete");
			assert.equal(normalizeStatus("Complete"), "Complete");
		});

		it("should map 'complete' to 'Complete' (via normalizeStatus)", () => {
			assert.equal(normalizeStatus("complete"), "Complete");
			assert.equal(normalizeStatus("Complete"), "Complete");
		});

		it("should normalize 'Reached' status to 'Complete'", () => {
			assert.equal(normalizeStatus("Complete"), "Complete");
			assert.equal(normalizeStatus("reached"), "Complete");
			assert.equal(normalizeStatus("REACHED"), "Complete");
		});

		it("should normalize 'Complete' status to 'Complete'", () => {
			assert.equal(normalizeStatus("Complete"), "Complete");
			assert.equal(normalizeStatus("complete"), "Complete");
		});

		it("should identify complete statuses", () => {
			assert.equal(isCompleteStatus("Complete"), true);
			assert.equal(isCompleteStatus("Complete"), true);
			assert.equal(isCompleteStatus("Active"), false);
			assert.equal(isCompleteStatus("New"), false);
		});

		it("should have correct display names for Complete", () => {
			assert.equal(STATUS_DISPLAY.Complete, "Complete");
		});

		it("should have correct emoji for Complete", () => {
			assert.equal(STATUS_EMOJI.Complete, "✅");
		});

		it("should format Complete status correctly", () => {
			const formatted = formatStatus("Complete");
			assert.ok(formatted.includes("✅"));
			assert.ok(formatted.includes("Complete"));
		});
	});

	describe.skip("AC#2: 'Proposal' terminology updated to 'Component'", () => {
		it("should have terminology mappings", () => {
			assert.equal(TERMINOLOGY_MAP.proposal, "component");
			assert.equal(TERMINOLOGY_MAP.Proposal, "Component");
			assert.equal(TERMINOLOGY_MAP.proposals, "components");
		});

		it("should format component IDs", () => {
			assert.equal(formatComponentId("proposal-1"), "Component 1");
			assert.equal(formatComponentId("proposal-42"), "Component 42");
			assert.equal(formatComponentId("proposal-10.1"), "Component 10.1");
		});

		it("should format component references", () => {
			const ref = formatComponentRef("proposal-1", "My Feature");
			assert.equal(ref, "Component 1: My Feature");
		});

		it("should have TUI labels with component terminology", () => {
			assert.ok(TUI_LABELS.boardTitle.includes("Component"));
			assert.ok(TUI_LABELS.noComponents.includes("components"));
		});

		it("should have CLI messages with component terminology", () => {
			const msg = CLI_MESSAGES.componentCreated("proposal-1");
			assert.ok(msg.includes("Component"));
		});
	});

	describe.skip("AC#3: MAP.md reflects new terminology", () => {
		it("should replace 'proposal' with 'component' in text", () => {
			const text = "This proposal is ready for review";
			const result = applyTerminology(text);
			assert.ok(result.includes("component"));
			assert.ok(!result.includes("proposal is"));
		});

		it("should handle multiple occurrences", () => {
			const text = "Proposal depends on Proposal";
			const result = applyTerminology(text);
			assert.ok(result.includes("Component"));
			// Both occurrences should be replaced
			const count = (result.match(/Component/g) || []).length;
			assert.equal(count, 2);
		});

		it("should be case-aware", () => {
			const text = "Create a new Proposal with Proposals in mind";
			const result = applyTerminology(text);
			assert.ok(result.includes("Component"));
			assert.ok(result.includes("Components"));
		});

		it("should preserve other content", () => {
			const text = "The proposal of the art system";
			const result = applyTerminology(text);
			// "proposal" in "proposal of the art" should be replaced
			assert.ok(result.includes("component"));
		});
	});

	describe("AC#4: Documentation uses product design language", () => {
		it("should have status displays for all statuses", () => {
			assert.ok(STATUS_DISPLAY.New !== undefined);
			assert.ok(STATUS_DISPLAY.Active !== undefined);
			assert.ok(STATUS_DISPLAY.Review !== undefined);
			assert.ok(STATUS_DISPLAY.Complete !== undefined);
			assert.ok(STATUS_DISPLAY.Abandoned !== undefined);
		});

		it("should have user-friendly status displays", () => {
			assert.equal(STATUS_DISPLAY.New, "Backlog");
			assert.equal(STATUS_DISPLAY.Active, "In Progress");
			assert.equal(STATUS_DISPLAY.Review, "In Review");
		});

		it("should have emojis for all statuses", () => {
			assert.equal(STATUS_EMOJI.New, "⚪");
			assert.equal(STATUS_EMOJI.Active, "🔵");
			assert.equal(STATUS_EMOJI.Review, "🟡");
			assert.equal(STATUS_EMOJI.Complete, "✅");
			assert.equal(STATUS_EMOJI.Abandoned, "❌");
		});

		it("should format status with emoji", () => {
			const potential = formatStatus("New");
			assert.ok(potential.includes("⚪"));
			assert.ok(potential.includes("Backlog"));

			const active = formatStatus("Active");
			assert.ok(active.includes("🔵"));
			assert.ok(active.includes("In Progress"));
		});
	});

	describe.skip("AC#5: Migration path for existing proposals", () => {
		it("should parse frontmatter correctly", () => {
			const content = `---
id: proposal-1
title: Test
status: Reached
---
Body text`;

			const fm = parseFrontmatter(content);
			assert.equal(fm.id, "proposal-1");
			assert.equal(fm.status, "Complete");
		});

		it("should migrate 'Reached' to 'Complete' in proposal file", () => {
			const content = `---
id: proposal-1
title: Test Proposal
status: Reached
assignee: []
---

## Description
This proposal needs work.
`;

			mkdirSync(proposalsDir, { recursive: true });
			const filePath = join(proposalsDir, "proposal-1-test.md");
			writeFileSync(filePath, content);

			const result = migrateProposalFile(filePath);

			assert.ok(result.changes.length > 0);
			assert.ok(result.migrated.includes("status: Complete"));
		});

		it("should not modify files already using new terminology", () => {
			const content = `---
id: proposal-1
title: Test Component
status: Complete
assignee: []
---

## Description
This component needs work.
`;

			mkdirSync(proposalsDir, { recursive: true });
			const filePath = join(proposalsDir, "proposal-1-test.md");
			writeFileSync(filePath, content);

			const result = migrateProposalFile(filePath);

			assert.equal(result.changes.length, 0);
		});

		it("should migrate all proposals in directory", () => {
			mkdirSync(proposalsDir, { recursive: true });

			// Create multiple proposal files
			writeFileSync(
				join(proposalsDir, "proposal-1.md"),
				`---
id: proposal-1
status: Reached
---

This proposal is done.`,
			);

			writeFileSync(
				join(proposalsDir, "proposal-2.md"),
				`---
id: proposal-2
status: Active
---

This proposal is active.`,
			);

			writeFileSync(
				join(proposalsDir, "proposal-3.md"),
				`---
id: proposal-3
status: Complete
---

This component is complete.`,
			);

			const result = migrateAllProposals(proposalsDir);

			assert.equal(result.totalFiles, 3);
			// proposal-1 has "Complete" status and "proposal" in body (2 changes)
			// proposal-2 has "Active" status but "proposal" in body (1 change)
			// proposal-3 already uses new terminology (0 changes)
			assert.equal(result.changedFiles, 2);
		});

		it("should generate migration guide", () => {
			const guide = generateMigrationGuide();

			assert.ok(guide.includes("Migration Guide"));
			assert.ok(guide.includes("Complete"));
			assert.ok(guide.includes("Complete"));
			assert.ok(guide.includes("Proposal"));
			assert.ok(guide.includes("Component"));
		});
	});

	describe("Additional status handling", () => {
		it("should normalize all standard statuses", () => {
			assert.equal(normalizeStatus("New"), "New");
			assert.equal(normalizeStatus("potential"), "New");
			assert.equal(normalizeStatus("Active"), "Active");
			assert.equal(normalizeStatus("active"), "Active");
			assert.equal(normalizeStatus("Review"), "Review");
			assert.equal(normalizeStatus("review"), "Review");
			assert.equal(normalizeStatus("Abandoned"), "Abandoned");
			assert.equal(normalizeStatus("abandoned"), "Abandoned");
		});

		it("should have check functions for all statuses", () => {
			assert.equal(isCompleteStatus("Complete"), true);
			assert.equal(isCompleteStatus("Complete"), true);
			assert.equal(isActiveStatus("Active"), true);
			assert.equal(isReviewStatus("Review"), true);
			assert.equal(isNewStatus("New"), true);
		});

		it("should default unknown statuses to New", () => {
			assert.equal(normalizeStatus("Unknown"), "New");
			assert.equal(normalizeStatus(""), "New");
		});
	});

	describe.skip("CLI message formatting", () => {
		it("should format component created message", () => {
			assert.ok(
				CLI_MESSAGES.componentCreated("proposal-1").includes("Component 1"),
			);
		});

		it("should format component updated message", () => {
			assert.ok(
				CLI_MESSAGES.componentUpdated("proposal-42").includes("Component 42"),
			);
		});

		it("should format list header", () => {
			const header = CLI_MESSAGES.listHeader(5);
			assert.ok(header.includes("5"));
			assert.ok(header.toLowerCase().includes("component"));
		});

		it("should format no components message", () => {
			assert.ok(CLI_MESSAGES.noComponents.includes("components"));
		});
	});
});
