/**
 * proposal-58.1: Enhanced Product Documentation - Full Proposal Detail & GitHub Hosting
 *
 * Tests for full proposal detail page generation and GitHub Pages workflow.
 */

import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	buildStatusSummary,
	generateDocs,
	generateFullProposalDetail,
	generateGitHubPagesWorkflow,
	generateProposalDetailPages,
	generateProposalIndex,
	generateStatusIndexPages,
	loadProposals,
	parseProposalFileFullDetail,
} from "../../src/core/infrastructure/doc-generator.ts";

const TEST_STATES_DIR = join(tmpdir(), `roadmap-test-proposals-${Date.now()}`);
const TEST_OUTPUT_DIR = join(tmpdir(), `roadmap-test-docs-${Date.now()}`);

// Sample proposal file content with all sections
const SAMPLE_STATE_FULL = `---
id: proposal-TEST-1
title: Test Proposal Full Detail
status: Active
assignee:
  - '@testuser'
created_date: '2026-03-24 10:00'
updated_date: '2026-03-24 15:30'
labels:
  - core
  - testing
priority: high
maturity: contracted
builder: test-builder
auditor: test-auditor
dependencies:
  - proposal-10
  - proposal-20
parent_proposal_id: proposal-58
directive: m-1
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
This is a test proposal with full detail content. It describes what needs to be built.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 First criterion that should be marked as passed
- [ ] #2 Second criterion that is pending
- [x] #3 Third criterion that passed
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. First step in the plan
2. Second step in the plan
3. Third step in the plan
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
✅ Implementation complete
✅ Created \`src/core/test-module.ts\`
✅ Updated \`docs/guide.md\`
✅ Modified \`roadmap/config.yml\`
<!-- SECTION:NOTES:END -->

## Audit Notes

<!-- SECTION:AUDIT_NOTES:BEGIN -->
- All criteria verified
- No blocking issues found
- Ready for Complete transition
<!-- SECTION:AUDIT_NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Proposal fully implemented and verified. All acceptance criteria met.
<!-- SECTION:FINAL_SUMMARY:END -->

## Proof of Arrival

<!-- SECTION:PROOF_OF_ARRIVAL:BEGIN -->
✅ 3/3 acceptance criteria passed
✅ Tests passing: 10/10
<!-- SECTION:PROOF_OF_ARRIVAL:END -->
`;

// Minimal proposal file content
const SAMPLE_STATE_MINIMAL = `---
id: proposal-TEST-2
title: Minimal Test Proposal
status: Potential
priority: medium
maturity: contracted
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A minimal proposal with only required fields.
<!-- SECTION:DESCRIPTION:END -->
`;

describe("proposal-58.1: Enhanced Product Documentation", () => {
	// Setup: Create test proposal files
	it.before(() => {
		if (!existsSync(TEST_STATES_DIR)) {
			mkdirSync(TEST_STATES_DIR, { recursive: true });
		}
		if (!existsSync(TEST_OUTPUT_DIR)) {
			mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
		}

		writeFileSync(
			join(TEST_STATES_DIR, "proposal-test-1-full-detail.md"),
			SAMPLE_STATE_FULL,
		);
		writeFileSync(
			join(TEST_STATES_DIR, "proposal-test-2-minimal.md"),
			SAMPLE_STATE_MINIMAL,
		);
	});

	// Cleanup: Remove test files
	it.after(() => {
		try {
			rmSync(TEST_STATES_DIR, { recursive: true, force: true });
			rmSync(TEST_OUTPUT_DIR, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("AC#1: Full description and structured data extraction", () => {
		it("should extract all frontmatter fields", () => {
			const detail = parseProposalFileFullDetail(
				join(TEST_STATES_DIR, "proposal-test-1-full-detail.md"),
			);

			assert.ok(detail, "Should parse proposal file");
			assert.equal(detail.id, "proposal-TEST-1");
			assert.equal(detail.title, "Test Proposal Full Detail");
			assert.equal(detail.status, "Active");
			assert.equal(detail.priority, "high");
			assert.equal(detail.maturity, "contracted");
			assert.equal(detail.builder, "test-builder");
			assert.equal(detail.auditor, "test-auditor");
			assert.equal(detail.created_date, "2026-03-24 10:00");
			assert.equal(detail.updated_date, "2026-03-24 15:30");
			assert.deepEqual(detail.labels, ["core", "testing"]);
			assert.deepEqual(detail.dependencies, ["proposal-10", "proposal-20"]);
			assert.equal(detail.parent_proposal_id, "proposal-58");
			assert.equal(detail.directive, "m-1");
		});

		it("should extract description section", () => {
			const detail = parseProposalFileFullDetail(
				join(TEST_STATES_DIR, "proposal-test-1-full-detail.md"),
			);

			assert.ok(detail, "Should parse proposal file");
			assert.ok(detail.description.includes("test proposal with full detail"));
			assert.ok(!detail.description.includes("<!--"));
		});

		it("should parse acceptance criteria with status", () => {
			const detail = parseProposalFileFullDetail(
				join(TEST_STATES_DIR, "proposal-test-1-full-detail.md"),
			);

			assert.ok(detail, "Should parse proposal file");
			assert.equal(detail.acceptanceCriteria.length, 3);
			assert.equal(detail.acceptanceCriteria[0]?.number, 1);
			assert.equal(detail.acceptanceCriteria[0]?.passed, true);
			assert.equal(detail.acceptanceCriteria[1]?.passed, false);
			assert.equal(detail.acceptanceCriteria[2]?.passed, true);
		});

		it("should handle minimal proposal with missing optional fields", () => {
			const detail = parseProposalFileFullDetail(
				join(TEST_STATES_DIR, "proposal-test-2-minimal.md"),
			);

			assert.ok(detail, "Should parse proposal file");
			assert.equal(detail.id, "proposal-TEST-2");
			assert.equal(detail.status, "Potential");
			assert.equal(detail.builder, undefined);
			assert.equal(detail.auditor, undefined);
			assert.equal(detail.labels.length, 0);
			assert.equal(detail.dependencies.length, 0);
			assert.equal(detail.acceptanceCriteria.length, 0);
		});
	});

	describe("AC#2: Implementation notes and files created", () => {
		it("should extract implementation notes", () => {
			const detail = parseProposalFileFullDetail(
				join(TEST_STATES_DIR, "proposal-test-1-full-detail.md"),
			);

			assert.ok(detail, "Should parse proposal file");
			assert.ok(detail.implementationNotes.includes("Implementation complete"));
		});

		it("should extract file references from notes", () => {
			const detail = parseProposalFileFullDetail(
				join(TEST_STATES_DIR, "proposal-test-1-full-detail.md"),
			);

			assert.ok(detail, "Should parse proposal file");
			assert.ok(
				detail.files.includes("src/core/test-module.ts"),
				"Should find src files",
			);
			assert.ok(
				detail.files.includes("docs/guide.md"),
				"Should find docs files",
			);
			assert.ok(
				detail.files.includes("roadmap/config.yml"),
				"Should find roadmap files",
			);
		});

		it("should extract implementation plan", () => {
			const detail = parseProposalFileFullDetail(
				join(TEST_STATES_DIR, "proposal-test-1-full-detail.md"),
			);

			assert.ok(detail, "Should parse proposal file");
			assert.ok(detail.implementationPlan.includes("First step"));
			assert.ok(detail.implementationPlan.includes("Second step"));
		});
	});

	describe("AC#3: Dependencies and blockers", () => {
		it("should extract dependencies list", () => {
			const detail = parseProposalFileFullDetail(
				join(TEST_STATES_DIR, "proposal-test-1-full-detail.md"),
			);

			assert.ok(detail, "Should parse proposal file");
			assert.deepEqual(detail.dependencies, ["proposal-10", "proposal-20"]);
		});

		it("should extract parent proposal reference", () => {
			const detail = parseProposalFileFullDetail(
				join(TEST_STATES_DIR, "proposal-test-1-full-detail.md"),
			);

			assert.ok(detail, "Should parse proposal file");
			assert.equal(detail.parent_proposal_id, "proposal-58");
		});
	});

	describe("AC#4: Test results and proof of arrival", () => {
		it("should extract audit notes", () => {
			const detail = parseProposalFileFullDetail(
				join(TEST_STATES_DIR, "proposal-test-1-full-detail.md"),
			);

			assert.ok(detail, "Should parse proposal file");
			assert.ok(detail.auditNotes.includes("All criteria verified"));
			assert.ok(detail.auditNotes.includes("No blocking issues"));
		});

		it("should extract proof of arrival", () => {
			const detail = parseProposalFileFullDetail(
				join(TEST_STATES_DIR, "proposal-test-1-full-detail.md"),
			);

			assert.ok(detail, "Should parse proposal file");
			assert.ok(
				detail.proofOfArrival.includes("3/3 acceptance criteria passed"),
			);
			assert.ok(detail.proofOfArrival.includes("Tests passing: 10/10"));
		});

		it("should extract final summary", () => {
			const detail = parseProposalFileFullDetail(
				join(TEST_STATES_DIR, "proposal-test-1-full-detail.md"),
			);

			assert.ok(detail, "Should parse proposal file");
			assert.ok(detail.finalSummary.includes("fully implemented and verified"));
		});
	});

	describe("AC#5: Assignee and timeline", () => {
		it("should extract assignee information", () => {
			const detail = parseProposalFileFullDetail(
				join(TEST_STATES_DIR, "proposal-test-1-full-detail.md"),
			);

			assert.ok(detail, "Should parse proposal file");
			assert.deepEqual(detail.assignee, ["@testuser"]);
		});

		it("should extract timeline information", () => {
			const detail = parseProposalFileFullDetail(
				join(TEST_STATES_DIR, "proposal-test-1-full-detail.md"),
			);

			assert.ok(detail, "Should parse proposal file");
			assert.equal(detail.created_date, "2026-03-24 10:00");
			assert.equal(detail.updated_date, "2026-03-24 15:30");
		});
	});

	describe("AC#6: Full proposal detail markdown generation", () => {
		it("should generate complete markdown page", () => {
			const detail = parseProposalFileFullDetail(
				join(TEST_STATES_DIR, "proposal-test-1-full-detail.md"),
			);
			assert.ok(detail, "Should parse proposal file");

			const markdown = generateFullProposalDetail(detail);

			// Header
			assert.ok(
				markdown.includes("# proposal-TEST-1 - Test Proposal Full Detail"),
			);

			// Metadata table
			assert.ok(markdown.includes("## 📋 Metadata"));
			assert.ok(markdown.includes("@testuser"));
			assert.ok(markdown.includes("test-builder"));
			assert.ok(markdown.includes("test-auditor"));

			// Dependencies
			assert.ok(markdown.includes("## 🔗 Dependencies (Prerequisites)"));
			assert.ok(markdown.includes("[proposal-10](../proposal-10.md)"));
			assert.ok(markdown.includes("[proposal-20](../proposal-20.md)"));

			// Description
			assert.ok(markdown.includes("## 📝 Description"));

			// Acceptance Criteria with status
			assert.ok(markdown.includes("## ✅ Acceptance Criteria"));
			assert.ok(markdown.includes("**2/3** criteria passed"));
			assert.ok(markdown.includes("✅"));
			assert.ok(markdown.includes("⬜"));

			// Implementation sections
			assert.ok(markdown.includes("## 📋 Implementation Plan"));
			assert.ok(markdown.includes("## 🔧 Implementation Notes"));
			assert.ok(markdown.includes("## 📁 Files"));

			// Audit
			assert.ok(markdown.includes("## 🔍 Audit Notes"));

			// Proof of Arrival
			assert.ok(markdown.includes("## 🎯 Proof of Arrival"));

			// Final Summary
			assert.ok(markdown.includes("## 📊 Final Summary"));
		});

		it("should generate compact page for minimal proposal", () => {
			const detail = parseProposalFileFullDetail(
				join(TEST_STATES_DIR, "proposal-test-2-minimal.md"),
			);
			assert.ok(detail, "Should parse proposal file");

			const markdown = generateFullProposalDetail(detail);

			assert.ok(markdown.includes("# proposal-TEST-2 - Minimal Test Proposal"));
			assert.ok(markdown.includes("## 📝 Description"));
			assert.ok(!markdown.includes("## 🔗 Dependencies"));
		});
	});

	describe("AC#7: Per-proposal detail page generation", () => {
		it("should generate detail pages for all proposals", () => {
			const docs = generateProposalDetailPages(
				TEST_STATES_DIR,
				TEST_OUTPUT_DIR,
			);

			assert.ok(
				docs.length >= 2,
				"Should generate pages for both test proposals",
			);

			// Check that files were written
			const proposalsOutputDir = join(TEST_OUTPUT_DIR, "proposals");
			assert.ok(existsSync(join(proposalsOutputDir, "proposal-TEST-1.md")));
			assert.ok(existsSync(join(proposalsOutputDir, "proposal-TEST-2.md")));

			// Verify content
			const proposal1Content = readFileSync(
				join(proposalsOutputDir, "proposal-TEST-1.md"),
				"utf-8",
			);
			assert.ok(proposal1Content.includes("Test Proposal Full Detail"));
			assert.ok(proposal1Content.includes("@testuser"));
		});
	});

	describe("AC#8: Proposal index with navigation", () => {
		it("should generate comprehensive index", () => {
			const proposals = loadProposals(TEST_STATES_DIR);
			const summary = buildStatusSummary(proposals);

			const index = generateProposalIndex(summary, "Test Project");

			// Should link to main docs
			assert.ok(index.includes("README.md"));
			assert.ok(index.includes("STATUS.md"));
			assert.ok(index.includes("DAG.md"));

			// Should have status overview
			assert.ok(index.includes("## 📈 Status Overview"));
			assert.ok(index.includes("✅ Complete"));
			assert.ok(index.includes("🔵 Active"));

			// Should have proposal table
			assert.ok(index.includes("## 📋 All Proposals"));
			assert.ok(index.includes("proposal-TEST-1"));
			assert.ok(index.includes("proposal-TEST-2"));
			assert.ok(index.includes("proposals/proposal-TEST-1.md"));
		});
	});

	describe("AC#9: Per-status index pages", () => {
		it("should generate status-specific pages", () => {
			const proposals = loadProposals(TEST_STATES_DIR);
			const summary = buildStatusSummary(proposals);

			const _docs = generateStatusIndexPages(summary, TEST_OUTPUT_DIR);

			// Should generate pages for each status
			const statusDir = join(TEST_OUTPUT_DIR, "status");
			assert.ok(existsSync(join(statusDir, "active.md")));
			assert.ok(existsSync(join(statusDir, "potential.md")));

			// Check active page content
			const activeContent = readFileSync(join(statusDir, "active.md"), "utf-8");
			assert.ok(activeContent.includes("# 🔵 Active Proposals"));
			assert.ok(activeContent.includes("proposal-TEST-1"));

			// Check potential page content
			const potentialContent = readFileSync(
				join(statusDir, "potential.md"),
				"utf-8",
			);
			assert.ok(potentialContent.includes("# ⚪ Potential Proposals"));
			assert.ok(potentialContent.includes("proposal-TEST-2"));
		});
	});

	describe("AC#10: GitHub Pages workflow generation", () => {
		it("should generate valid GitHub Actions workflow", () => {
			const workflow = generateGitHubPagesWorkflow();

			assert.equal(workflow.path, ".github/workflows/deploy-docs.yml");

			const content = workflow.content;
			assert.ok(content.includes("name: Deploy Documentation to GitHub Pages"));
			assert.ok(content.includes("on:"));
			assert.ok(content.includes("push:"));
			assert.ok(content.includes("branches: [main]"));
			assert.ok(content.includes("jobs:"));
			assert.ok(content.includes("generate-docs:"));
			assert.ok(content.includes("deploy:"));
			assert.ok(content.includes("actions/upload-pages-artifact@v3"));
			assert.ok(content.includes("actions/deploy-pages@v4"));
			assert.ok(content.includes("npx roadmap docs generate"));
		});
	});

	describe("AC#11: Integration with existing doc generator", () => {
		it("should generate enhanced docs alongside existing docs", async () => {
			// Create a temporary project structure
			const projectRoot = join(tmpdir(), `roadmap-project-${Date.now()}`);
			const proposalsDir = join(projectRoot, "roadmap", "proposals");
			const _outputDir = join(projectRoot, "docs");

			mkdirSync(proposalsDir, { recursive: true });

			// Copy test proposals
			writeFileSync(
				join(proposalsDir, "proposal-test-1.md"),
				SAMPLE_STATE_FULL,
			);
			writeFileSync(
				join(proposalsDir, "proposal-test-2.md"),
				SAMPLE_STATE_MINIMAL,
			);

			// Run the full doc generator
			const result = await generateDocs(projectRoot, {
				outputDir: "docs",
				includeDAG: true,
				includeChangelog: true,
				format: "markdown",
			});

			assert.ok(result.success, "Generation should succeed");

			// Should include existing docs
			const readmeFile = result.files.find((f) => f.path.endsWith("README.md"));
			assert.ok(readmeFile, "Should generate README.md");

			// Should include new per-proposal pages
			const proposal1Page = result.files.find((f) =>
				f.path.includes("proposal-TEST-1.md"),
			);
			assert.ok(
				proposal1Page,
				"Should generate per-proposal detail page for proposal-TEST-1",
			);

			const proposal2Page = result.files.find((f) =>
				f.path.includes("proposal-TEST-2.md"),
			);
			assert.ok(
				proposal2Page,
				"Should generate per-proposal detail page for proposal-TEST-2",
			);

			// Should include status index pages
			const activePage = result.files.find((f) =>
				f.path.includes("status/active.md"),
			);
			assert.ok(activePage, "Should generate active status page");

			// Cleanup
			try {
				rmSync(projectRoot, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		});
	});
});
