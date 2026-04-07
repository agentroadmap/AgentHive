/**
 * Tests for proposal-058.1: Enhanced Product Documentation
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
	buildCrossReferences,
	buildStatusSummary,
	contentHash,
	generateDashboard,
	generateDocsConfig,
	generateFullProposalDetail,
	generateGitHubPagesWorkflow,
	generateNavigation,
	groupByLabel,
	groupByPriority,
	groupByStatus,
	hasProposalChanged,
	type ProposalDocData,
	saveContentHash,
} from "../../src/core/infrastructure/enhanced-docs.ts";

// Helper to create test proposal data
function makeProposal(
	overrides: Partial<ProposalDocData> = {},
): ProposalDocData {
	return {
		id: "proposal-042",
		title: "Test Proposal",
		status: "Complete",
		assignee: ["dev-1"],
		createdDate: "2026-03-24",
		labels: ["core", "test"],
		dependencies: [],
		description: "A test proposal for documentation",
		acceptanceCriteria: [
			{ number: 1, text: "First criterion", status: "checked" },
			{ number: 2, text: "Second criterion", status: "unchecked" },
		],
		implementationNotes: "Implemented using TypeScript",
		auditNotes: "",
		proofOfArrival: "26/26 tests passing",
		finalSummary: "All ACs implemented",
		implementationFiles: ["src/core/test.ts"],
		...overrides,
	};
}

describe("proposal-058.1: Enhanced Product Documentation", () => {
	// AC#1: Full Proposal Detail
	describe("AC#1: Full Proposal Detail", () => {
		it("generates header with id and title", () => {
			const proposal = makeProposal();
			const md = generateFullProposalDetail(proposal);
			assert.ok(md.includes("# proposal-042: Test Proposal"));
		});

		it("includes metadata section", () => {
			const proposal = makeProposal({
				assignee: ["dev-1", "dev-2"],
				builder: "dev-1",
			});
			const md = generateFullProposalDetail(proposal);
			assert.ok(md.includes("**Assignee:** dev-1, dev-2"));
			assert.ok(md.includes("**Builder:** dev-1"));
		});

		it("includes acceptance criteria table", () => {
			const proposal = makeProposal();
			const md = generateFullProposalDetail(proposal);
			assert.ok(md.includes("✅"));
			assert.ok(md.includes("⬜"));
			assert.ok(md.includes("First criterion"));
			assert.ok(md.includes("Second criterion"));
		});

		it("calculates AC progress", () => {
			const proposal = makeProposal();
			const md = generateFullProposalDetail(proposal);
			assert.ok(md.includes("1/2 ACs complete (50%)"));
		});

		it("includes dependencies with links", () => {
			const proposal = makeProposal({
				dependencies: ["proposal-040", "proposal-041"],
			});
			const md = generateFullProposalDetail(proposal);
			assert.ok(md.includes("[proposal-040](./proposal-proposal-040.md)"));
			assert.ok(md.includes("[proposal-041](./proposal-proposal-041.md)"));
		});

		it("includes test results section", () => {
			const proposal = makeProposal({
				testResults: {
					total: 26,
					passing: 26,
					failing: 0,
					skipped: 0,
					duration: "1.2s",
				},
			});
			const md = generateFullProposalDetail(proposal);
			assert.ok(md.includes("**Total:** 26"));
			assert.ok(md.includes("**Passing:** 26"));
			assert.ok(md.includes("**Duration:** 1.2s"));
		});

		it("includes proof of arrival", () => {
			const proposal = makeProposal({ proofOfArrival: "All tests green" });
			const md = generateFullProposalDetail(proposal);
			assert.ok(md.includes("All tests green"));
		});
	});

	// AC#2: Dashboard with Filtering
	describe("AC#2: Dashboard with Filtering", () => {
		it("generates dashboard with summary", () => {
			const proposals = [
				makeProposal({ id: "proposal-001", status: "Complete" }),
				makeProposal({ id: "proposal-002", status: "Active" }),
				makeProposal({ id: "proposal-003", status: "Accepted" }),
				makeProposal({ id: "proposal-004", status: "Active" }),
			];
			const md = generateDashboard(proposals);
			assert.ok(md.includes("4 proposals"));
			assert.ok(md.includes("Complete"));
			assert.ok(md.includes("Active"));
		});

		it("groups proposals by status", () => {
			const proposals = [
				makeProposal({ id: "proposal-001", status: "Complete" }),
				makeProposal({ id: "proposal-002", status: "Complete" }),
				makeProposal({ id: "proposal-003", status: "Active" }),
			];
			const md = generateDashboard(proposals);
			assert.ok(md.includes("Complete (2)"));
			assert.ok(md.includes("Active (1)"));
		});

		it("groups proposals by label", () => {
			const proposals = [
				makeProposal({ id: "proposal-001", labels: ["core", "cubic"] }),
				makeProposal({ id: "proposal-002", labels: ["core", "test"] }),
				makeProposal({ id: "proposal-003", labels: ["cubic"] }),
			];
			const md = generateDashboard(proposals);
			assert.ok(md.includes("core"));
			assert.ok(md.includes("2 proposals"));
		});

		it("groups proposals by priority", () => {
			const proposals = [
				makeProposal({ id: "proposal-001", priority: "high" }),
				makeProposal({ id: "proposal-002", priority: "high" }),
				makeProposal({ id: "proposal-003", priority: "low" }),
			];
			const md = generateDashboard(proposals);
			assert.ok(md.includes("High"));
			assert.ok(md.includes("Low"));
		});

		it("buildStatusSummary counts correctly", () => {
			const proposals = [
				makeProposal({ status: "Complete" }),
				makeProposal({ status: "Complete" }),
				makeProposal({ status: "Active" }),
				makeProposal({ status: "Accepted" }),
				makeProposal({ status: "Abandoned" }),
			];
			const summary = buildStatusSummary(proposals);
			assert.equal(summary.total, 5);
			assert.equal(summary.complete, 2); // Complete + Complete
			assert.equal(summary.active, 1);
			assert.equal(summary.accepted, 1);
			assert.equal(summary.abandoned, 1);
		});

		it("groupByStatus works", () => {
			const proposals = [
				makeProposal({ status: "Complete" }),
				makeProposal({ status: "Active" }),
				makeProposal({ status: "Complete" }),
			];
			const groups = groupByStatus(proposals);
			assert.equal(groups.complete.length, 2);
			assert.equal(groups.active.length, 1);
		});

		it("groupByLabel works", () => {
			const proposals = [
				makeProposal({ labels: ["core", "test"] }),
				makeProposal({ labels: ["core"] }),
			];
			const groups = groupByLabel(proposals);
			assert.equal(groups.core.length, 2);
			assert.equal(groups.test.length, 1);
		});

		it("groupByPriority works", () => {
			const proposals = [
				makeProposal({ priority: "high" }),
				makeProposal({ priority: "high" }),
				makeProposal({ priority: "low" }),
			];
			const groups = groupByPriority(proposals);
			assert.equal(groups.high.length, 2);
			assert.equal(groups.low.length, 1);
		});
	});

	// AC#3: GitHub Pages Deployment
	describe("AC#3: GitHub Pages Deployment", () => {
		it("generates valid GitHub Actions workflow", () => {
			const wf = generateGitHubPagesWorkflow();
			assert.ok(wf.includes("name: Deploy Documentation"));
			assert.ok(wf.includes("branches: [main]"));
			assert.ok(wf.includes("actions/checkout@v4"));
			assert.ok(wf.includes("actions/deploy-pages@v4"));
			assert.ok(wf.includes("generate-full-docs.ts"));
		});

		it("workflow triggers on proposal changes", () => {
			const wf = generateGitHubPagesWorkflow();
			assert.ok(wf.includes("roadmap/proposals/**"));
		});

		it("generates docs config", () => {
			const config = generateDocsConfig("agentRoadmap.md");
			assert.ok(
				config.includes('site_name: "agentRoadmap.md - Documentation"'),
			);
			assert.ok(config.includes("material"));
			assert.ok(config.includes("search"));
			assert.ok(config.includes("index.md"));
		});
	});

	// AC#4: Cross-Referencing Navigation
	describe("AC#4: Cross-Referencing", () => {
		it("builds dependency links", () => {
			const proposals = [
				makeProposal({ id: "proposal-001", dependencies: ["proposal-002"] }),
				makeProposal({ id: "proposal-002", dependencies: [] }),
			];
			const refs = buildCrossReferences(proposals);

			assert.ok(refs.get("proposal-001")?.includes("depends-on:proposal-002"));
			assert.ok(refs.get("proposal-002")?.includes("depended-by:proposal-001"));
		});

		it("builds parent-child links", () => {
			const proposals = [
				makeProposal({ id: "proposal-058", parentProposalId: undefined }),
				makeProposal({
					id: "proposal-058.1",
					parentProposalId: "proposal-058",
				}),
			];
			const refs = buildCrossReferences(proposals);

			assert.ok(refs.get("proposal-058.1")?.includes("child-of:proposal-058"));
		});

		it("generates navigation sidebar", () => {
			const proposals = [
				makeProposal({
					id: "proposal-001",
					title: "First",
					status: "Complete",
				}),
				makeProposal({ id: "proposal-002", title: "Second", status: "Active" }),
			];
			const nav = generateNavigation(proposals);

			// Should have dashboard entry
			assert.equal(nav[0].title, "Dashboard");
			assert.equal(nav[0].path, "index.md");

			// Should have status groups
			const completeSection = nav.find((n) => n.title.includes("Complete"));
			assert.ok(completeSection);
			assert.ok((completeSection?.children?.length ?? 0) >= 1);
		});
	});

	// AC#7: Incremental Generation
	describe("AC#7: Incremental Generation", () => {
		it("contentHash produces consistent hash", () => {
			const hash1 = contentHash("hello world");
			const hash2 = contentHash("hello world");
			const hash3 = contentHash("hello world!");

			assert.equal(hash1, hash2);
			assert.notEqual(hash1, hash3);
		});

		it("hasProposalChanged detects changes", () => {
			const cacheDir = mkdtempSync(`${tmpdir()}/docs-test-`);

			try {
				const content = "test content v1";
				saveContentHash("proposal-001", content, cacheDir);

				// Same content should not be changed
				assert.equal(
					hasProposalChanged("proposal-001", content, cacheDir),
					false,
				);

				// Different content should be changed
				assert.equal(
					hasProposalChanged("proposal-001", "test content v2", cacheDir),
					true,
				);

				// New proposal should always be changed
				assert.equal(
					hasProposalChanged("proposal-999", "new proposal", cacheDir),
					true,
				);
			} finally {
				rmSync(cacheDir, { recursive: true, force: true });
			}
		});

		it("saveContentHash persists hash", () => {
			const cacheDir = mkdtempSync(`${tmpdir()}/docs-test-`);

			try {
				const content = "test content";
				saveContentHash("proposal-001", content, cacheDir);
				const hash = readFileSync(
					`${cacheDir}/proposal-001.hash`,
					"utf-8",
				).trim();
				assert.equal(hash, contentHash(content));
			} finally {
				rmSync(cacheDir, { recursive: true, force: true });
			}
		});
	});
});
