import assert from "node:assert";
import { describe, it } from "node:test";
import { upsertProposalUpdatedDate } from "../../src/utils/proposal-updated-date.ts";

describe("upsertProposalUpdatedDate", () => {
	it("replaces existing updated_date value", () => {
		const input = `---
id: proposal-1
title: Test Proposal
created_date: '2026-01-01 10:00'
updated_date: '2026-01-01 10:30'
labels: []
---

## Description

Body`;
		const output = upsertProposalUpdatedDate(input, "2026-02-11 22:15");

		assert.ok(output.includes("updated_date: '2026-02-11 22:15'"));
		assert.ok(!output.includes("updated_date: '2026-01-01 10:30'"));
		assert.ok(output.includes("## Description"));
	});

	it("inserts updated_date after created_date when missing", () => {
		const input = `---
id: proposal-1
title: Test Proposal
created_date: '2026-01-01 10:00'
labels: []
---

## Description

Body`;
		const output = upsertProposalUpdatedDate(input, "2026-02-11 22:15");

		assert.ok(
			output.includes(
				"created_date: '2026-01-01 10:00'\nupdated_date: '2026-02-11 22:15'\nlabels: []",
			),
		);
	});

	it("inserts updated_date before frontmatter close when created_date is absent", () => {
		const input = `---
id: proposal-1
title: Test Proposal
labels: []
---

## Description

Body`;
		const output = upsertProposalUpdatedDate(input, "2026-02-11 22:15");

		assert.ok(
			output.includes("labels: []\nupdated_date: '2026-02-11 22:15'\n---"),
		);
	});

	it("preserves CRLF line endings", () => {
		const input =
			"---\r\nid: proposal-1\r\ntitle: Test Proposal\r\ncreated_date: '2026-01-01 10:00'\r\nlabels: []\r\n---\r\n\r\n## Description\r\n\r\nBody";
		const output = upsertProposalUpdatedDate(input, "2026-02-11 22:15");

		assert.ok(output.includes("\r\nupdated_date: '2026-02-11 22:15'\r\n"));
		assert.ok(output.includes("\r\n## Description\r\n"));
	});
});
