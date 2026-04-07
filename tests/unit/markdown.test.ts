import assert from "node:assert";
import { describe, it } from "node:test";
import {
	parseDecision,
	parseDocument,
	parseMarkdown,
	parseProposal,
} from "../../src/markdown/parser.ts";
import {
	serializeDecision,
	serializeDocument,
	serializeProposal,
	updateProposalAcceptanceCriteria,
} from "../../src/markdown/serializer.ts";
import type { Decision, Document, Proposal } from "../../src/types/index.ts";
import { expect } from "../support/test-utils.ts";

describe("Markdown Parser", () => {
	describe("parseMarkdown", () => {
		it("should parse frontmatter and content", () => {
			const content = `---
title: "Test Proposal"
status: "Potential"
labels: ["bug", "urgent"]
---

This is the proposal description.

## Acceptance Criteria

- [ ] First criterion
- [ ] Second criterion`;

			const result = parseMarkdown(content);

			assert.strictEqual(result.frontmatter.title, "Test Proposal");
			assert.strictEqual(result.frontmatter.status, "Potential");
			assert.deepStrictEqual(result.frontmatter.labels, ["bug", "urgent"]);
			assert.ok(result.content.includes("This is the proposal description"));
		});

		it("should handle content without frontmatter", () => {
			const content = "Just some markdown content";
			const result = parseMarkdown(content);

			assert.deepStrictEqual(result.frontmatter, {});
			assert.strictEqual(result.content, "Just some markdown content");
		});

		it("should handle empty content", () => {
			const content = "";
			const result = parseMarkdown(content);

			assert.deepStrictEqual(result.frontmatter, {});
			assert.strictEqual(result.content, "");
		});
	});

	describe("parseProposal", () => {
		it("should parse a complete proposal", () => {
			const content = `---
id: proposal-1
title: "Fix login bug"
status: "Active"
assignee: "@developer"
reporter: "@manager"
created_date: "2025-06-03"
labels: ["bug", "frontend"]
directive: "v1.0"
dependencies: ["proposal-0"]
parent_proposal_id: "proposal-parent"
subproposals: ["proposal-1.1", "proposal-1.2"]
---

## Description

Fix the login bug that prevents users from signing in.

## Acceptance Criteria

- [ ] Login form validates correctly
- [ ] Error messages are displayed properly`;

			const proposal = parseProposal(content);

			assert.strictEqual(proposal.id, "proposal-1");
			assert.strictEqual(proposal.title, "Fix login bug");
			assert.strictEqual(proposal.status, "Active");
			assert.deepStrictEqual(proposal.assignee, ["@developer"]);
			assert.strictEqual(proposal.reporter, "@manager");
			assert.strictEqual(proposal.createdDate, "2025-06-03");
			assert.deepStrictEqual(proposal.labels, ["bug", "frontend"]);
			assert.strictEqual(proposal.directive, "v1.0");
			assert.deepStrictEqual(proposal.dependencies, ["proposal-0"]);
			assert.strictEqual(proposal.parentProposalId, "proposal-parent");
			assert.deepStrictEqual(proposal.subproposals, [
				"proposal-1.1",
				"proposal-1.2",
			]);
			expect(
				proposal.acceptanceCriteriaItems?.map((item) => item.text),
			).toEqual([
				"Login form validates correctly",
				"Error messages are displayed properly",
			]);
		});

		it("should parse a proposal with minimal fields", () => {
			const content = `---
id: proposal-2
title: "Simple proposal"
---

Just a basic proposal.`;

			const proposal = parseProposal(content);

			assert.strictEqual(proposal.id, "proposal-2");
			assert.strictEqual(proposal.title, "Simple proposal");
			assert.strictEqual(proposal.status, "");
			assert.deepStrictEqual(proposal.assignee, []);
			assert.strictEqual(proposal.reporter, undefined);
			assert.deepStrictEqual(proposal.labels, []);
			assert.deepStrictEqual(proposal.dependencies, []);
			assert.deepStrictEqual(proposal.acceptanceCriteriaItems, []);
			assert.strictEqual(proposal.parentProposalId, undefined);
			assert.strictEqual(proposal.subproposals, undefined);
		});

		it("should handle proposal with empty status", () => {
			const content = `---
id: proposal-3
title: "No status proposal"
created_date: "2025-06-07"
---

Proposal without status.`;

			const proposal = parseProposal(content);

			assert.strictEqual(proposal.status, "");
			assert.strictEqual(proposal.createdDate, "2025-06-07");
		});

		it("should parse unquoted created_date", () => {
			const content = `---
id: proposal-5
title: "Unquoted"
created_date: 2025-06-08
---`;

			const proposal = parseProposal(content);

			assert.strictEqual(proposal.createdDate, "2025-06-08");
		});

		it("should parse created_date in short format", () => {
			const content = `---
id: proposal-6
title: "Short"
created_date: 08-06-25
---`;

			const proposal = parseProposal(content);

			assert.strictEqual(proposal.createdDate, "2025-06-08");
		});

		it("should preserve frontmatter when title contains dollar-sign digit sequences", () => {
			const content = `---
id: proposal-112.11
title: 'Build ~$15,000 System (Magnepan 1.7x)'
status: Potential
assignee: []
created_date: "2026-02-10 18:24"
labels:
  - TLR
dependencies: []
priority: high
---

Proposal body.`;

			const proposal = parseProposal(content);

			assert.strictEqual(proposal.id, "proposal-112.11");
			assert.strictEqual(
				proposal.title,
				"Build ~$15,000 System (Magnepan 1.7x)",
			);
			assert.strictEqual(proposal.status, "Potential");
			assert.strictEqual(proposal.createdDate, "2026-02-10 18:24");
			assert.deepStrictEqual(proposal.labels, ["TLR"]);
			assert.strictEqual(proposal.priority, "high");
		});

		it("should extract acceptance criteria with checked items", () => {
			const content = `---
id: proposal-4
title: "Test with mixed criteria"
---

## Acceptance Criteria

- [ ] Todo item
- [x] Complete item
- [ ] Another todo`;

			const proposal = parseProposal(content);

			expect(
				proposal.acceptanceCriteriaItems?.map((item) => item.text),
			).toEqual(["Todo item", "Complete item", "Another todo"]);
		});

		it("should parse unquoted assignee names starting with @", () => {
			const content = `---
id: proposal-5
title: "Assignee Test"
assignee: @MrLesk
---

Test proposal.`;

			const proposal = parseProposal(content);

			assert.deepStrictEqual(proposal.assignee, ["@MrLesk"]);
		});

		it("should parse unquoted reporter names starting with @", () => {
			const content = `---
id: proposal-6
title: "Reporter Test"
assignee: []
reporter: @MrLesk
created_date: 2025-06-08
---

Test proposal with reporter.`;

			const proposal = parseProposal(content);

			assert.strictEqual(proposal.reporter, "@MrLesk");
		});

		it("should parse inline assignee lists with unquoted @ handles", () => {
			const content = `---
id: proposal-7
title: "Inline Assignees"
assignee: [@alice, "@bob"]
status: Potential
created_date: 2025-06-08
---

Test proposal with inline list.`;

			const proposal = parseProposal(content);

			assert.deepStrictEqual(proposal.assignee, ["@alice", "@bob"]);
		});

		it("should escape backslashes in inline @ lists", () => {
			const content = `---
id: proposal-8
title: "Backslash Inline Assignees"
assignee: [@domain\\\\user]
status: Potential
created_date: 2025-06-08
---

Test proposal with inline list containing backslash.`;

			const proposal = parseProposal(content);

			assert.deepStrictEqual(proposal.assignee, ["@domain\\\\user"]);
		});
	});

	describe("parseDecision", () => {
		it("should parse a decision log", () => {
			const content = `---
id: decision-1
title: "Use TypeScript for backend"
date: "2025-06-03"
status: "accepted"
---

## Context

We need to choose a language for the backend.

## Decision

We will use TypeScript for better type safety.

## Consequences

Better development experience but steeper learning curve.`;

			const decision = parseDecision(content);

			assert.strictEqual(decision.id, "decision-1");
			assert.strictEqual(decision.title, "Use TypeScript for backend");
			assert.strictEqual(decision.status, "accepted");
			assert.strictEqual(
				decision.context,
				"We need to choose a language for the backend.",
			);
			assert.strictEqual(
				decision.decision,
				"We will use TypeScript for better type safety.",
			);
			assert.strictEqual(
				decision.consequences,
				"Better development experience but steeper learning curve.",
			);
		});

		it("should parse decision log with alternatives", () => {
			const content = `---
id: decision-2
title: "Choose database"
date: "2025-06-03"
status: "proposed"
---

## Context

Need a database solution.

## Decision

Use PostgreSQL.

## Consequences

Good performance and reliability.

## Alternatives

Considered MongoDB and MySQL.`;

			const decision = parseDecision(content);

			assert.strictEqual(
				decision.alternatives,
				"Considered MongoDB and MySQL.",
			);
		});

		it("should handle missing sections", () => {
			const content = `---
id: decision-3
title: "Minimal decision"
date: "2025-06-03"
status: "proposed"
---

## Context

Some context.`;

			const decision = parseDecision(content);

			assert.strictEqual(decision.context, "Some context.");
			assert.strictEqual(decision.decision, "");
			assert.strictEqual(decision.consequences, "");
			assert.strictEqual(decision.alternatives, undefined);
		});
	});

	describe("parseDocument", () => {
		it("should parse a document", () => {
			const content = `---
id: doc-1
title: "API Guide"
type: "guide"
created_date: 2025-06-07
tags: [api]
---

Document body.`;

			const doc = parseDocument(content);

			assert.strictEqual(doc.id, "doc-1");
			assert.strictEqual(doc.title, "API Guide");
			assert.strictEqual(doc.type, "guide");
			assert.strictEqual(doc.createdDate, "2025-06-07");
			assert.deepStrictEqual(doc.tags, ["api"]);
			assert.strictEqual(doc.rawContent, "Document body.");
		});
	});
});

describe("Markdown Serializer", () => {
	describe("serializeProposal", () => {
		it("should serialize a proposal correctly", () => {
			const proposal: Proposal = {
				id: "proposal-1",
				title: "Test Proposal",
				status: "Potential",
				assignee: ["@developer"],
				reporter: "@manager",
				createdDate: "2025-06-03",
				labels: ["bug", "frontend"],
				directive: "v1.0",
				dependencies: ["proposal-0"],
				description: "This is a test proposal description.",
			};

			const result = serializeProposal(proposal);

			assert.ok(result.includes("id: proposal-1"));
			assert.ok(result.includes("title: Test Proposal"));
			assert.ok(result.includes("status: Potential"));
			assert.ok(result.includes("created_date: '2025-06-03'"));
			assert.ok(result.includes("labels:"));
			assert.ok(result.includes("- bug"));
			assert.ok(result.includes("- frontend"));
			assert.ok(result.includes("## Description"));
			assert.ok(result.includes("This is a test proposal description."));
		});

		it("should serialize proposal with subproposals", () => {
			const proposal: Proposal = {
				id: "proposal-parent",
				title: "Parent Proposal",
				status: "Active",
				assignee: [],
				createdDate: "2025-06-03",
				labels: [],
				dependencies: [],
				description: "A parent proposal with subproposals.",
				subproposals: ["proposal-parent.1", "proposal-parent.2"],
			};

			const result = serializeProposal(proposal);

			assert.ok(result.includes("subproposals:"));
			assert.ok(result.includes("- proposal-parent.1"));
			assert.ok(result.includes("- proposal-parent.2"));
		});

		it("should serialize proposal with parent", () => {
			const proposal: Proposal = {
				id: "proposal-1.1",
				title: "Subproposal",
				status: "Potential",
				assignee: [],
				createdDate: "2025-06-03",
				labels: [],
				dependencies: [],
				description: "A subproposal.",
				parentProposalId: "proposal-1",
			};

			const result = serializeProposal(proposal);

			assert.ok(result.includes("parent_proposal_id: proposal-1"));
		});

		it("should serialize minimal proposal", () => {
			const proposal: Proposal = {
				id: "proposal-minimal",
				title: "Minimal Proposal",
				status: "Draft",
				assignee: [],
				createdDate: "2025-06-03",
				labels: [],
				dependencies: [],
				description: "Minimal proposal.",
			};

			const result = serializeProposal(proposal);

			assert.ok(result.includes("id: proposal-minimal"));
			assert.ok(result.includes("title: Minimal Proposal"));
			assert.ok(result.includes("assignee: []"));
			assert.ok(!result.includes("reporter:"));
			assert.ok(!result.includes("updated_date:"));
		});

		it("removes acceptance criteria section when list becomes empty", () => {
			const proposal: Proposal = {
				id: "proposal-clean",
				title: "Cleanup Proposal",
				status: "Potential",
				assignee: [],
				createdDate: "2025-06-10",
				labels: [],
				dependencies: [],
				description: "Some details",
				acceptanceCriteriaItems: [],
			};

			const result = serializeProposal(proposal);

			assert.ok(!result.includes("## Acceptance Criteria"));
			assert.ok(!result.includes("<!-- AC:BEGIN -->"));
			assert.ok(result.includes("## Description"));
			assert.ok(result.includes("Some details"));
		});

		it("serializes acceptance criteria when structured items exist", () => {
			const proposal: Proposal = {
				id: "proposal-freeform",
				title: "Legacy Criteria Proposal",
				status: "Potential",
				assignee: [],
				createdDate: "2025-06-11",
				labels: [],
				dependencies: [],
				description: "Some details",
				acceptanceCriteriaItems: [
					{ index: 1, text: "Criterion A", checked: false },
				],
			};

			const result = serializeProposal(proposal);

			assert.ok(result.includes("## Acceptance Criteria"));
			assert.ok(result.includes("- [ ] #1 Criterion A"));
		});
	});

	describe("serializeDecision", () => {
		it("should serialize a decision log correctly", () => {
			const decision: Decision = {
				id: "decision-1",
				title: "Use TypeScript",
				date: "2025-06-03",
				status: "accepted",
				context: "We need type safety",
				decision: "Use TypeScript",
				consequences: "Better DX",
				rawContent: "",
			};

			const result = serializeDecision(decision);

			assert.ok(result.includes("id: decision-1"));
			assert.ok(result.includes("## Context"));
			assert.ok(result.includes("We need type safety"));
			assert.ok(result.includes("## Decision"));
			assert.ok(result.includes("Use TypeScript"));
		});

		it("should serialize decision log with alternatives", () => {
			const decision: Decision = {
				id: "decision-2",
				title: "Database Choice",
				date: "2025-06-03",
				status: "accepted",
				context: "Need database",
				decision: "PostgreSQL",
				consequences: "Good performance",
				alternatives: "Considered MongoDB",
				rawContent: "",
			};

			const result = serializeDecision(decision);

			assert.ok(result.includes("## Alternatives"));
			assert.ok(result.includes("Considered MongoDB"));
		});
	});

	describe("serializeDocument", () => {
		it("should serialize a document correctly", () => {
			const document: Document = {
				id: "doc-1",
				title: "API Documentation",
				type: "specification",
				createdDate: "2025-06-07",
				updatedDate: "2025-06-08",
				rawContent: "This document describes the API endpoints.",
				tags: ["api", "docs"],
			};

			const result = serializeDocument(document);

			assert.ok(result.includes("id: doc-1"));
			assert.ok(result.includes("title: API Documentation"));
			assert.ok(result.includes("type: specification"));
			assert.ok(result.includes("created_date: '2025-06-07'"));
			assert.ok(result.includes("updated_date: '2025-06-08'"));
			assert.ok(result.includes("tags:"));
			assert.ok(result.includes("- api"));
			assert.ok(result.includes("- docs"));
			assert.ok(result.includes("This document describes the API endpoints."));
		});

		it("should serialize document without optional fields", () => {
			const document: Document = {
				id: "doc-2",
				title: "Simple Doc",
				type: "guide",
				createdDate: "2025-06-07",
				rawContent: "Simple content.",
			};

			const result = serializeDocument(document);

			assert.ok(result.includes("id: doc-2"));
			assert.ok(!result.includes("updated_date:"));
			assert.ok(!result.includes("tags:"));
		});
	});

	describe("updateProposalAcceptanceCriteria", () => {
		it("should add acceptance criteria to content without existing section", () => {
			const content = "# Proposal Description\n\nThis is a simple proposal.";
			const criteria = ["Login works correctly", "Error handling is proper"];

			const result = updateProposalAcceptanceCriteria(content, criteria);

			assert.ok(result.includes("## Acceptance Criteria"));
			assert.ok(result.includes("- [ ] Login works correctly"));
			assert.ok(result.includes("- [ ] Error handling is proper"));
		});

		it("should replace existing acceptance criteria section", () => {
			const content = `# Proposal Description

This is a proposal with existing criteria.

## Acceptance Criteria

- [ ] Old criterion 1
- [ ] Old criterion 2

## Notes

Some additional notes.`;

			const criteria = ["New criterion 1", "New criterion 2"];

			const result = updateProposalAcceptanceCriteria(content, criteria);

			assert.ok(result.includes("- [ ] New criterion 1"));
			assert.ok(result.includes("- [ ] New criterion 2"));
			assert.ok(!result.includes("Old criterion 1"));
			assert.ok(result.includes("## Notes"));
		});

		it("should handle empty criteria array", () => {
			const content = "# Proposal Description\n\nSimple proposal.";
			const criteria: string[] = [];

			const result = updateProposalAcceptanceCriteria(content, criteria);

			assert.ok(result.includes("## Acceptance Criteria"));
			assert.ok(!result.includes("- [ ]"));
		});
	});
});
