/**
 * Tests for proposal-58: Live Product Documentation Auto-Generated
 *
 * AC#1: Documentation auto-generated on every proposal change
 * AC#2: Includes what's built, in progress, and planned
 * AC#3: Published to accessible location on git push
 * AC#4: Includes architecture diagrams from DAG
 * AC#5: No manual maintenance required — source of truth is roadmap
 */

import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	buildArchitectureSection,
	buildChangelogSection,
	buildDagNodes,
	buildStatusSummary,
	formatMarkdown,
	formatStatusSection,
	generateDocs,
	loadProposals,
	parseFrontmatter,
	type StatusSummary,
} from "../../src/core/infrastructure/doc-generator.ts";
import type { Proposal } from "../../src/types/index.ts";

describe("proposal-58: Live Product Documentation Auto-Generated", () => {
	let testDir: string;
	let roadmapDir: string;
	let proposalsDir: string;
	let outputDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "docgen-test-"));
		roadmapDir = join(testDir, "roadmap");
		proposalsDir = join(roadmapDir, "proposals");
		outputDir = join(testDir, "docs");
		mkdirSync(proposalsDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	// Helper to create a proposal file
	const createProposalFile = (
		id: string,
		status: string,
		title: string,
		deps: string[] = [],
	) => {
		const content = `---
id: ${id}
title: ${title}
status: ${status}
assignee: []
created_date: '2026-03-22'
updatedDate: '2026-03-23'
labels: []
dependencies: ${JSON.stringify(deps)}
priority: medium
---

## Description
Test proposal description.
`;
		writeFileSync(
			join(
				proposalsDir,
				`proposal-${id.replace("proposal-", "")} - ${title.replace(/ /g, "-")}.md`,
			),
			content,
		);
	};

	describe("AC#1: Documentation auto-generated on every proposal change", () => {
		it("should generate documentation from roadmap proposal", async () => {
			createProposalFile("proposal-1", "Complete", "First Proposal");
			createProposalFile("proposal-2", "Active", "Second Proposal");
			createProposalFile("proposal-3", "Potential", "Third Proposal", [
				"proposal-1",
			]);

			const result = await generateDocs(testDir, {
				outputDir: "docs",
				includeDAG: true,
				includeChangelog: true,
				format: "markdown",
			});

			assert.equal(result.success, true);
			assert.ok(result.files.length > 0);
			assert.equal(existsSync(join(outputDir, "README.md")), true);
		});

		it("should include timestamp in output", async () => {
			createProposalFile("proposal-1", "Complete", "Test Proposal");

			const result = await generateDocs(testDir, {
				outputDir: "docs",
				includeDAG: false,
				includeChangelog: false,
				format: "markdown",
			});

			assert.ok(result.timestamp !== undefined);
			assert.ok(result.files.some((f) => f.content.includes(result.timestamp)));
		});
	});

	describe("AC#2: Includes what's built, in progress, and planned", () => {
		it("should categorize proposals by status", () => {
			const proposals: Proposal[] = [
				{
					id: "proposal-1",
					title: "Built",
					status: "Complete",
					dependencies: [],
					assignee: [],
					createdDate: "2024-01-01",
					labels: [],
				},
				{
					id: "proposal-2",
					title: "Active",
					status: "Active",
					dependencies: [],
					assignee: [],
					createdDate: "2024-01-01",
					labels: [],
				},
				{
					id: "proposal-3",
					title: "Review",
					status: "Review",
					dependencies: [],
					assignee: [],
					createdDate: "2024-01-01",
					labels: [],
				},
				{
					id: "proposal-4",
					title: "Planned",
					status: "Potential",
					dependencies: [],
					assignee: [],
					createdDate: "2024-01-01",
					labels: [],
				},
			];

			const summary = buildStatusSummary(proposals);

			assert.equal(summary.reached.length, 1);
			assert.equal(summary.active.length, 1);
			assert.equal(summary.review.length, 1);
			assert.equal(summary.new.length, 1);
			assert.equal(summary.total, 4);
		});

		it("should handle 'Complete' status as synonym for 'Complete'", () => {
			const proposals: Proposal[] = [
				{
					id: "proposal-1",
					title: "Done",
					status: "Complete",
					dependencies: [],
					assignee: [],
					createdDate: "2024-01-01",
					labels: [],
				},
			];

			const summary = buildStatusSummary(proposals);

			assert.equal(summary.reached.length, 1);
		});

		it("should generate markdown with status sections", () => {
			const summary: StatusSummary = {
				reached: [
					{
						id: "proposal-1",
						title: "Built",
						status: "Complete",
						dependencies: [],
						assignee: [],
						createdDate: "2024-01-01",
						labels: [],
					},
				],
				active: [
					{
						id: "proposal-2",
						title: "In Progress",
						status: "Active",
						dependencies: [],
						assignee: [],
						createdDate: "2024-01-01",
						labels: [],
					},
				],
				review: [],
				new: [
					{
						id: "proposal-3",
						title: "Planned",
						status: "Potential",
						dependencies: [],
						assignee: [],
						createdDate: "2024-01-01",
						labels: [],
					},
				],
				abandoned: [],
				total: 3,
			};

			const markdown = formatMarkdown(
				summary,
				"Test Project",
				{
					outputDir: "docs",
					includeDAG: false,
					includeChangelog: false,
					format: "markdown",
				},
				[],
			);

			assert.ok(markdown.includes("Complete (Completed)"));
			assert.ok(markdown.includes("Active (In Progress)"));
			assert.ok(markdown.includes("New (Backlog)"));
			assert.ok(markdown.includes("proposal-1"));
			assert.ok(markdown.includes("proposal-2"));
			assert.ok(markdown.includes("proposal-3"));
		});
	});

	describe("AC#3: Published to accessible location on git push", () => {
		it("should generate files in specified output directory", async () => {
			createProposalFile("proposal-1", "Complete", "Test");

			await generateDocs(testDir, {
				outputDir: "docs",
				includeDAG: false,
				includeChangelog: false,
				format: "markdown",
			});

			assert.equal(existsSync(join(outputDir, "README.md")), true);
			assert.equal(existsSync(join(outputDir, "INDEX.md")), true);
			assert.equal(existsSync(join(outputDir, "STATUS.md")), true);
		});

		it("should create output directory if it doesn't exist", async () => {
			createProposalFile("proposal-1", "Complete", "Test");
			const customOutput = join(testDir, "custom", "docs");

			await generateDocs(testDir, {
				outputDir: "custom/docs",
				includeDAG: false,
				includeChangelog: false,
				format: "markdown",
			});

			assert.equal(existsSync(customOutput), true);
			assert.equal(existsSync(join(customOutput, "README.md")), true);
		});

		it("should generate index file with links", async () => {
			createProposalFile("proposal-1", "Complete", "Test");

			await generateDocs(testDir, {
				outputDir: "docs",
				includeDAG: true,
				includeChangelog: false,
				format: "markdown",
			});

			const indexContent = readFileSync(join(outputDir, "INDEX.md"), "utf-8");
			assert.ok(indexContent.includes("README.md"));
			assert.ok(indexContent.includes("STATUS.md"));
			assert.ok(indexContent.includes("DAG.md"));
		});
	});

	describe("AC#4: Includes architecture diagrams from DAG", () => {
		it("should build DAG nodes from proposals", () => {
			const proposals: Proposal[] = [
				{
					id: "proposal-1",
					title: "First",
					status: "Complete",
					dependencies: [],
					assignee: [],
					createdDate: "2024-01-01",
					labels: [],
				},
				{
					id: "proposal-2",
					title: "Second",
					status: "Active",
					dependencies: ["proposal-1"],
					assignee: [],
					createdDate: "2024-01-01",
					labels: [],
				},
			];

			const nodes = buildDagNodes(proposals);

			assert.equal(nodes.length, 2);
			assert.equal(nodes[0]?.id, "proposal-1");
			assert.ok(nodes[1]?.dependencies.includes("proposal-1"));
		});

		it("should generate PlantUML architecture diagram", () => {
			const proposals: Proposal[] = [
				{
					id: "proposal-1",
					title: "Base",
					status: "Complete",
					dependencies: [],
					assignee: [],
					createdDate: "2024-01-01",
					labels: [],
				},
				{
					id: "proposal-2",
					title: "Dependent",
					status: "Active",
					dependencies: ["proposal-1"],
					assignee: [],
					createdDate: "2024-01-01",
					labels: [],
				},
			];

			const diagram = buildArchitectureSection(proposals);

			assert.ok(diagram.includes("@startuml"));
			assert.ok(diagram.includes("@enduml"));
			assert.ok(diagram.includes("proposal-1"));
			assert.ok(diagram.includes("proposal-2"));
			assert.ok(diagram.includes("-->"));
		});

		it("should include DAG in documentation when enabled", async () => {
			createProposalFile("proposal-1", "Complete", "Base");

			await generateDocs(testDir, {
				outputDir: "docs",
				includeDAG: true,
				includeChangelog: false,
				format: "markdown",
			});

			const content = readFileSync(join(outputDir, "README.md"), "utf-8");
			assert.ok(content.includes("@startuml"));
		});

		it("should exclude DAG when disabled", async () => {
			createProposalFile("proposal-1", "Complete", "Base");

			await generateDocs(testDir, {
				outputDir: "docs",
				includeDAG: false,
				includeChangelog: false,
				format: "markdown",
			});

			const content = readFileSync(join(outputDir, "README.md"), "utf-8");
			assert.ok(!content.includes("@startuml"));
		});
	});

	describe("AC#5: No manual maintenance required — source of truth is roadmap", () => {
		it("should load all proposals from proposals directory", () => {
			createProposalFile("proposal-1", "Complete", "One");
			createProposalFile("proposal-2", "Active", "Two");
			createProposalFile("proposal-3", "Potential", "Three");

			const proposals = loadProposals(proposalsDir);

			assert.equal(proposals.length, 3);
		});

		it("should parse frontmatter correctly", () => {
			const content = `---
id: proposal-1
title: Test
status: Complete
priority: high
---
Body`;

			const frontmatter = parseFrontmatter(content);

			assert.equal(frontmatter.id, "proposal-1");
			assert.equal(frontmatter.title, "Test");
			assert.equal(frontmatter.status, "Complete");
			assert.equal(frontmatter.priority, "high");
		});

		it("should handle missing proposals directory gracefully", () => {
			const nonExistentDir = join(testDir, "nonexistent");

			const proposals = loadProposals(nonExistentDir);

			assert.deepEqual(proposals, []);
		});

		it("should generate documentation from actual roadmap files", async () => {
			// Create a config file
			writeFileSync(
				join(roadmapDir, "config.yml"),
				'project_name: "Test Project"\n',
			);

			// Create some proposals
			createProposalFile("proposal-1", "Complete", "Completed Feature");
			createProposalFile("proposal-2", "Active", "Work in Progress");
			createProposalFile("proposal-3", "Review", "Needs Review");
			createProposalFile("proposal-4", "Potential", "Backlog Item");

			const result = await generateDocs(testDir, {
				outputDir: "docs",
				includeDAG: true,
				includeChangelog: true,
				format: "markdown",
			});

			assert.equal(result.success, true);

			const readme = readFileSync(join(outputDir, "README.md"), "utf-8");
			assert.ok(readme.includes("Test Project"));
			assert.ok(readme.includes("proposal-1"));
			assert.ok(readme.includes("proposal-2"));
			assert.ok(readme.includes("proposal-3"));
			assert.ok(readme.includes("proposal-4"));
		});
	});

	describe("Additional features", () => {
		it("should format status section correctly", () => {
			const proposals: Proposal[] = [
				{
					id: "proposal-1",
					title: "One",
					status: "Complete",
					dependencies: [],
					assignee: [],
					createdDate: "2024-01-01",
					labels: [],
				},
				{
					id: "proposal-2",
					title: "Two",
					status: "Complete",
					dependencies: [],
					assignee: [],
					createdDate: "2024-01-01",
					labels: [],
				},
			];

			const section = formatStatusSection("Completed", proposals, "✅");

			assert.ok(section.includes("✅ Completed (2)"));
			assert.ok(section.includes("proposal-1"));
			assert.ok(section.includes("proposal-2"));
		});

		it("should handle empty status section", () => {
			const section = formatStatusSection("Abandoned", [], "❌");

			assert.ok(section.includes("❌ Abandoned (0)"));
			assert.ok(section.includes("_No proposals in this category._"));
		});

		it("should generate changelog from recent changes", () => {
			const proposals: Proposal[] = [
				{
					id: "proposal-1",
					title: "Recent",
					status: "Complete",
					dependencies: [],
					updatedDate: "2026-03-24",
					assignee: [],
					createdDate: "2024-01-01",
					labels: [],
				},
				{
					id: "proposal-2",
					title: "Older",
					status: "Active",
					dependencies: [],
					updatedDate: "2026-03-22",
					assignee: [],
					createdDate: "2024-01-01",
					labels: [],
				},
			];

			const changelog = buildChangelogSection(proposals, 10);

			assert.ok(changelog.includes("Recent Changes"));
			assert.ok(changelog.includes("2026-03-24"));
			assert.ok(changelog.includes("2026-03-22"));
		});

		it("should include assignee information in output", () => {
			const summary: StatusSummary = {
				reached: [],
				active: [
					{
						id: "proposal-1",
						title: "Assigned",
						status: "Active",
						dependencies: [],
						assignee: ["alice", "bob"],
						createdDate: "2024-01-01",
						labels: [],
					},
				],
				review: [],
				new: [],
				abandoned: [],
				total: 1,
			};

			const markdown = formatMarkdown(
				summary,
				"Test",
				{
					outputDir: "docs",
					includeDAG: false,
					includeChangelog: false,
					format: "markdown",
				},
				[],
			);

			assert.ok(markdown.includes("alice, bob"));
		});
	});
});
