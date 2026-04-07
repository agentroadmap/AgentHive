import assert from "node:assert";
import { describe, it } from "node:test";
import { updateProposalDescription } from "../../src/markdown/serializer.ts";
import { extractStructuredSection } from "../../src/markdown/structured-sections.ts";
import { expect } from "../support/test-utils.ts";

describe("updateProposalDescription", () => {
	it("should replace existing description section", () => {
		const content = `---
id: proposal-1
title: Test proposal
---

## Description

Old description

## Acceptance Criteria

- [ ] Test criterion

## Implementation Plan

Test plan`;

		const result = updateProposalDescription(content, "New description");

		assert.ok(result.includes("<!-- SECTION:DESCRIPTION:BEGIN -->"));
		expect(extractStructuredSection(result, "description")).toBe(
			"New description",
		);
		expect(extractStructuredSection(result, "implementationPlan")).toBe(
			"Test plan",
		);
		assert.ok(!result.includes("Old description"));
	});

	it("should add description section if none exists and preserve other sections", () => {
		const content = `---
id: proposal-1
title: Test proposal
---

## Acceptance Criteria

- [ ] Test criterion`;

		const result = updateProposalDescription(content, "New description");

		expect(extractStructuredSection(result, "description")).toBe(
			"New description",
		);
		assert.ok(result.includes("## Acceptance Criteria"));
		// Description should come before acceptance criteria
		expect(result.indexOf("## Description")).toBeLessThan(
			result.indexOf("## Acceptance Criteria"),
		);
	});

	it("should handle content without frontmatter and preserve other sections", () => {
		const content = `## Acceptance Criteria

- [ ] Test criterion`;

		const result = updateProposalDescription(content, "New description");

		expect(extractStructuredSection(result, "description")).toBe(
			"New description",
		);
		assert.ok(result.includes("## Acceptance Criteria"));
		// Description should come first
		expect(result.indexOf("## Description")).toBeLessThan(
			result.indexOf("## Acceptance Criteria"),
		);
	});

	it("should handle empty content", () => {
		const content = `---
id: proposal-1
title: Test proposal
---

`;

		const result = updateProposalDescription(content, "New description");

		expect(extractStructuredSection(result, "description")).toBe(
			"New description",
		);
	});

	it("should preserve complex sections", () => {
		const content = `---
id: proposal-1
title: Test proposal
---

## Description

Old description

## Acceptance Criteria

- [x] Completed criterion
- [ ] Pending criterion

## Implementation Plan

1. Step one
2. Step two

## Implementation Notes

These are notes with **bold** and *italic* text.

### Subsection

More detailed notes.`;

		const result = updateProposalDescription(content, "Updated description");

		expect(extractStructuredSection(result, "description")).toBe(
			"Updated description",
		);
		assert.ok(result.includes("- [x] Completed criterion"));
		assert.ok(result.includes("- [ ] Pending criterion"));
		expect(extractStructuredSection(result, "implementationPlan")).toContain(
			"1. Step one",
		);
		expect(extractStructuredSection(result, "implementationPlan")).toContain(
			"2. Step two",
		);
		expect(extractStructuredSection(result, "implementationNotes")).toContain(
			"**bold** and *italic*",
		);
		expect(extractStructuredSection(result, "implementationNotes")).toContain(
			"### Subsection",
		);
		assert.ok(!result.includes("Old description"));
	});
});
