import assert from "node:assert";
import { describe, it } from "node:test";
import { parseProposal } from "../../src/markdown/parser.ts";
import { serializeProposal } from "../../src/markdown/serializer.ts";
import type { Proposal } from "../../src/types/index.ts";

describe("Priority functionality", () => {
	describe("parseProposal", () => {
		it("should parse proposal with priority field", () => {
			const content = `---
id: proposal-1
title: "High priority proposal"
status: "Potential"
priority: high
assignee: []
created_date: "2025-06-20"
labels: []
dependencies: []
---

## Description

This is a high priority proposal.`;

			const proposal = parseProposal(content);

			assert.strictEqual(proposal.id, "proposal-1");
			assert.strictEqual(proposal.title, "High priority proposal");
			assert.strictEqual(proposal.priority, "high");
		});

		it("should handle all priority levels", () => {
			const priorities = ["high", "medium", "low"] as const;

			for (const priority of priorities) {
				const content = `---
id: proposal-${priority}
title: "${priority} priority proposal"
status: "Potential"
priority: ${priority}
assignee: []
created_date: "2025-06-20"
labels: []
dependencies: []
---

## Description

This is a ${priority} priority proposal.`;

				const proposal = parseProposal(content);
				assert.strictEqual(proposal.priority, priority);
			}
		});

		it("should handle invalid priority values gracefully", () => {
			const content = `---
id: proposal-1
title: "Invalid priority proposal"
status: "Potential"
priority: invalid
assignee: []
created_date: "2025-06-20"
labels: []
dependencies: []
---

## Description

This proposal has an invalid priority.`;

			const proposal = parseProposal(content);

			assert.strictEqual(proposal.priority, undefined);
		});

		it("should handle proposal without priority field", () => {
			const content = `---
id: proposal-1
title: "No priority proposal"
status: "Potential"
assignee: []
created_date: "2025-06-20"
labels: []
dependencies: []
---

## Description

This proposal has no priority.`;

			const proposal = parseProposal(content);

			assert.strictEqual(proposal.priority, undefined);
		});

		it("should handle case-insensitive priority values", () => {
			const content = `---
id: proposal-1
title: "Mixed case priority"
status: "Potential"
priority: HIGH
assignee: []
created_date: "2025-06-20"
labels: []
dependencies: []
---

## Description

This proposal has mixed case priority.`;

			const proposal = parseProposal(content);

			assert.strictEqual(proposal.priority, "high");
		});
	});

	describe("serializeProposal", () => {
		it("should serialize proposal with priority", () => {
			const proposal: Proposal = {
				id: "proposal-1",
				title: "High priority proposal",
				status: "Potential",
				assignee: [],
				createdDate: "2025-06-20",
				labels: [],
				dependencies: [],
				rawContent: "## Description\n\nThis is a high priority proposal.",
				priority: "high",
			};

			const serialized = serializeProposal(proposal);

			assert.ok(serialized.includes("priority: high"));
		});

		it("should not include priority field when undefined", () => {
			const proposal: Proposal = {
				id: "proposal-1",
				title: "No priority proposal",
				status: "Potential",
				assignee: [],
				createdDate: "2025-06-20",
				labels: [],
				dependencies: [],
				rawContent: "## Description\n\nThis proposal has no priority.",
			};

			const serialized = serializeProposal(proposal);

			assert.ok(!serialized.includes("priority:"));
		});

		it("should round-trip priority values correctly", () => {
			const priorities: Array<"high" | "medium" | "low"> = [
				"high",
				"medium",
				"low",
			];

			for (const priority of priorities) {
				const originalProposal: Proposal = {
					id: "proposal-1",
					title: `${priority} priority proposal`,
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-20",
					labels: [],
					dependencies: [],
					rawContent: `## Description\n\nThis is a ${priority} priority proposal.`,
					priority,
				};

				const serialized = serializeProposal(originalProposal);
				const parsed = parseProposal(serialized);

				assert.strictEqual(parsed.priority, priority);
			}
		});
	});
});
