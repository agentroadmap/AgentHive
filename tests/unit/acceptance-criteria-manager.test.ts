import assert from "node:assert";
import { describe, it } from "node:test";
import { AcceptanceCriteriaManager } from "../../src/markdown/structured-sections.ts";

describe("AcceptanceCriteriaManager", () => {
	it("does not insert blank lines when adding new criteria (BACK-365)", () => {
		// Start with existing content that has 2 criteria
		const existingContent = `## Description

Some description

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 First criterion
- [ ] #2 Second criterion
<!-- AC:END -->
`;
		// Add a third criterion
		const updatedCriteria = [
			{ checked: false, text: "First criterion", index: 1 },
			{ checked: false, text: "Second criterion", index: 2 },
			{ checked: false, text: "Third criterion", index: 3 },
		];
		const result = AcceptanceCriteriaManager.updateContent(
			existingContent,
			updatedCriteria,
		);

		// Extract the AC section and verify no blank lines between criteria
		const acSection =
			result.match(/<!-- AC:BEGIN -->([\s\S]*?)<!-- AC:END -->/)?.[1] || "";
		const lines = acSection.split("\n").filter((line) => line.trim() !== "");

		assert.strictEqual(lines.length, 3);
		assert.strictEqual(lines[0], "- [ ] #1 First criterion");
		assert.strictEqual(lines[1], "- [ ] #2 Second criterion");
		assert.strictEqual(lines[2], "- [ ] #3 Third criterion");

		// Also verify no double newlines in the AC section (which would indicate blank lines)
		assert.ok(!acSection.includes("\n\n"));
	});

	it("removes a single criterion without affecting other sections", () => {
		const base = AcceptanceCriteriaManager.formatAcceptanceCriteria([
			{ checked: false, text: "First", index: 1 },
			{ checked: false, text: "Second", index: 2 },
			{ checked: false, text: "Third", index: 3 },
		]);
		const content = `## Description\n\nSomething\n\n${base}\n\n## Notes\nExtra`;
		const updated = AcceptanceCriteriaManager.removeCriterionByIndex(
			content,
			2,
		);
		assert.ok(updated.includes("- [ ] #1 First"));
		assert.ok(updated.includes("- [ ] #2 Third"));
		assert.ok(updated.includes("## Notes"));
		assert.ok(!updated.includes("Second"));
	});

	it("toggles a criterion and persists proposal", () => {
		const base = AcceptanceCriteriaManager.formatAcceptanceCriteria([
			{ checked: false, text: "Only", index: 1 },
		]);
		const updated = AcceptanceCriteriaManager.checkCriterionByIndex(
			base,
			1,
			true,
		);
		assert.ok(updated.includes("- [x] #1 Only"));
	});
});
