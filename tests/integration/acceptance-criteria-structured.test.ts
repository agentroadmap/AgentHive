import assert from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { parseProposal } from "../../src/markdown/parser.ts";
import { expect } from "../support/test-utils.ts";

const TEMP_DIR = join(process.cwd(), ".tmp-structured-ac-test");

describe("Structured Acceptance Criteria parsing", () => {
	before(() => {
		try {
			rmSync(TEMP_DIR, { recursive: true, force: true });
		} catch {}
		mkdirSync(TEMP_DIR, { recursive: true });
	});

	after(() => {
		try {
			rmSync(TEMP_DIR, { recursive: true, force: true });
		} catch {}
	});

	it("parses acceptance criteria items with checked proposal and index", () => {
		const content = `---
id: proposal-999
title: Demo
status: Potential
assignee: []
created_date: 2025-01-01
labels: []
dependencies: []
---

## Description

X

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 First
- [x] #2 Second
<!-- AC:END -->
`;

		const proposal = parseProposal(content);
		assert.strictEqual(proposal.acceptanceCriteriaItems?.length, 2);
		assert.deepStrictEqual(proposal.acceptanceCriteriaItems?.[0], {
			index: 1,
			text: "First",
			checked: false,
		});
		assert.deepStrictEqual(proposal.acceptanceCriteriaItems?.[1], {
			index: 2,
			text: "Second",
			checked: true,
		});

		// Derived legacy-friendly text remains accessible by mapping items
		expect(
			proposal.acceptanceCriteriaItems?.map(
				(item) => `#${item.index} ${item.text}`,
			),
		).toEqual(["#1 First", "#2 Second"]);
	});
});
