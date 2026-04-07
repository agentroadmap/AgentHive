/**
 * STATE-58.1: Enhanced Product Documentation - Full Proposal Detail & GitHub Hosting
 *
 * Extends STATE-58's doc-generator to produce full-detail per-proposal pages
 * with all structured data, cross-referencing navigation, and GitHub Pages deployment.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ──────────────────────────────────────────
// AC#1: Full Proposal Detail Page Content
// ──────────────────────────────────────────

/** Parsed proposal data for documentation generation */
export interface ProposalDocData {
	id: string;
	title: string;
	status: string;
	assignee: string | string[];
	createdDate: string;
	updatedDate?: string;
	labels: string[];
	priority?: string;
	maturity?: string;
	dependencies: string[];
	parentProposalId?: string;
	description: string;
	acceptanceCriteria: AcceptanceCriterionDoc[];
	implementationNotes: string;
	auditNotes: string;
	proofOfArrival: string;
	finalSummary: string;
	implementationFiles: string[];
	testResults?: TestResultDoc;
	builder?: string;
	auditor?: string;
}

/** An acceptance criterion for documentation */
export interface AcceptanceCriterionDoc {
	number: number;
	text: string;
	status: "checked" | "unchecked";
}

/** Test results for documentation */
export interface TestResultDoc {
	total: number;
	passing: number;
	failing: number;
	skipped: number;
	duration?: string;
}

/**
 * Generate full proposal detail markdown for a single proposal.
 * Implements AC#1: ALL available data on the page.
 */
export function generateFullProposalDetail(proposal: ProposalDocData): string {
	const lines: string[] = [];

	// Header card
	const statusBadge = getStatusBadge(proposal.status);
	const priorityBadge = proposal.priority
		? getPriorityBadge(proposal.priority)
		: "";
	const maturityBadge = proposal.maturity
		? getMaturityBadge(proposal.maturity)
		: "";

	lines.push(`# ${proposal.id}: ${proposal.title}`);
	lines.push("");
	lines.push(`${statusBadge} ${priorityBadge} ${maturityBadge}`.trim());
	lines.push("");

	// Metadata row
	lines.push("## Metadata");
	lines.push("");
	const assigneeStr = Array.isArray(proposal.assignee)
		? proposal.assignee.join(", ")
		: proposal.assignee || "Unassigned";
	lines.push(`- **Assignee:** ${assigneeStr}`);
	if (proposal.builder) lines.push(`- **Builder:** ${proposal.builder}`);
	if (proposal.auditor) lines.push(`- **Auditor:** ${proposal.auditor}`);
	lines.push(`- **Created:** ${proposal.createdDate}`);
	if (proposal.updatedDate)
		lines.push(`- **Updated:** ${proposal.updatedDate}`);
	if (proposal.labels.length > 0)
		lines.push(
			`- **Labels:** ${proposal.labels.map((l) => `\`${l}\``).join(", ")}`,
		);
	lines.push("");

	// Dependencies
	if (proposal.dependencies.length > 0) {
		lines.push("## Dependencies");
		lines.push("");
		for (const dep of proposal.dependencies) {
			lines.push(`- [${dep}](./STATE-${dep}.md)`);
		}
		lines.push("");
	}

	// Description
	if (proposal.description) {
		lines.push("## Description");
		lines.push("");
		lines.push(proposal.description);
		lines.push("");
	}

	// Acceptance Criteria table
	if (proposal.acceptanceCriteria.length > 0) {
		lines.push("## Acceptance Criteria");
		lines.push("");
		lines.push("| Status | AC# | Criterion |");
		lines.push("|--------|-----|-----------|");
		for (const ac of proposal.acceptanceCriteria) {
			const icon = ac.status === "checked" ? "✅" : "⬜";
			lines.push(`| ${icon} | #${ac.number} | ${ac.text} |`);
		}
		lines.push("");

		const passed = proposal.acceptanceCriteria.filter(
			(a) => a.status === "checked",
		).length;
		const total = proposal.acceptanceCriteria.length;
		lines.push(
			`**Progress:** ${passed}/${total} ACs complete (${Math.round((passed / total) * 100)}%)`,
		);
		lines.push("");
	}

	// Implementation Notes
	if (proposal.implementationNotes) {
		lines.push("## Implementation Notes");
		lines.push("");
		lines.push(proposal.implementationNotes);
		lines.push("");
	}

	// Test Results
	if (proposal.testResults) {
		lines.push("## Test Results");
		lines.push("");
		lines.push(`- **Total:** ${proposal.testResults.total}`);
		lines.push(`- **Passing:** ${proposal.testResults.passing} ✅`);
		lines.push(
			`- **Failing:** ${proposal.testResults.failing} ${proposal.testResults.failing > 0 ? "❌" : ""}`,
		);
		if (proposal.testResults.skipped > 0)
			lines.push(`- **Skipped:** ${proposal.testResults.skipped} ⏭️`);
		if (proposal.testResults.duration)
			lines.push(`- **Duration:** ${proposal.testResults.duration}`);
		lines.push("");
	}

	// Audit Notes
	if (proposal.auditNotes) {
		lines.push("## Audit Notes");
		lines.push("");
		lines.push(proposal.auditNotes);
		lines.push("");
	}

	// Proof of Arrival
	if (proposal.proofOfArrival) {
		lines.push("## Proof of Arrival");
		lines.push("");
		lines.push(proposal.proofOfArrival);
		lines.push("");
	}

	// Final Summary
	if (proposal.finalSummary) {
		lines.push("## Final Summary");
		lines.push("");
		lines.push(proposal.finalSummary);
		lines.push("");
	}

	return lines.join("\n");
}

// ──────────────────────────────────────────
// AC#2: Documentation Dashboard with Filtering
// ──────────────────────────────────────────

/** Dashboard section grouping */
export interface DashboardSection {
	title: string;
	proposals: ProposalDocData[];
	count: number;
}

/**
 * Generate a documentation index/dashboard with filtering.
 * Implements AC#2: grouping by status, label, priority, assignee.
 */
export function generateDashboard(proposals: ProposalDocData[]): string {
	const lines: string[] = [];

	// Summary header
	const summary = buildStatusSummary(proposals);
	lines.push("# 📊 agentRoadmap.md Dashboard");
	lines.push("");
	lines.push(
		`> **${summary.total} proposals** | ${summary.complete} Complete | ${summary.active} Active | ${summary.accepted} Accepted | ${summary.abandoned} Abandoned`,
	);
	lines.push("");

	// Status overview with badges
	lines.push("## Status Overview");
	lines.push("");
	lines.push(`| Status | Count |`);
	lines.push(`|--------|-------|`);
	lines.push(`| ✅ Complete | ${summary.complete} |`);
	lines.push(`| 🔨 Active | ${summary.active} |`);
	lines.push(`| 📋 Accepted | ${summary.accepted} |`);
	lines.push(`| 🗑️ Abandoned | ${summary.abandoned} |`);
	lines.push("");

	// Proposals by status
	const byStatus = groupByStatus(proposals);
	for (const [status, group] of Object.entries(byStatus)) {
		if (group.length === 0) continue;
		lines.push(
			`## ${getStatusEmoji(status)} ${capitalize(status)} (${group.length})`,
		);
		lines.push("");
		for (const proposal of group) {
			const dep =
				proposal.dependencies.length > 0
					? ` — deps: ${proposal.dependencies.join(", ")}`
					: "";
			lines.push(`- **${proposal.id}**: ${proposal.title}${dep}`);
		}
		lines.push("");
	}

	// Proposals by label
	const byLabel = groupByLabel(proposals);
	if (Object.keys(byLabel).length > 0) {
		lines.push("## By Label");
		lines.push("");
		for (const [label, group] of Object.entries(byLabel).sort(
			(a, b) => b[1].length - a[1].length,
		)) {
			lines.push(`- **\`${label}\`**: ${group.length} proposals`);
		}
		lines.push("");
	}

	// Proposals by priority
	const byPriority = groupByPriority(proposals);
	if (Object.keys(byPriority).length > 0) {
		lines.push("## By Priority");
		lines.push("");
		for (const [priority, group] of Object.entries(byPriority)) {
			lines.push(`- ${getPriorityBadge(priority)}: ${group.length} proposals`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

/** Build status summary counts */
export function buildStatusSummary(proposals: ProposalDocData[]): {
	total: number;
	complete: number;
	active: number;
	accepted: number;
	abandoned: number;
} {
	return {
		total: proposals.length,
		complete: proposals.filter(
			(s) => s.status === "Complete" || s.status === "Reached",
		).length,
		active: proposals.filter((s) => s.status === "Active").length,
		accepted: proposals.filter((s) => s.status === "Accepted").length,
		abandoned: proposals.filter((s) => s.status === "Abandoned").length,
	};
}

/** Group proposals by status */
export function groupByStatus(
	proposals: ProposalDocData[],
): Record<string, ProposalDocData[]> {
	const groups: Record<string, ProposalDocData[]> = {};
	for (const proposal of proposals) {
		const key = proposal.status.toLowerCase();
		if (!groups[key]) groups[key] = [];
		groups[key].push(proposal);
	}
	return groups;
}

/** Group proposals by labels */
export function groupByLabel(
	proposals: ProposalDocData[],
): Record<string, ProposalDocData[]> {
	const groups: Record<string, ProposalDocData[]> = {};
	for (const proposal of proposals) {
		for (const label of proposal.labels) {
			if (!groups[label]) groups[label] = [];
			groups[label].push(proposal);
		}
	}
	return groups;
}

/** Group proposals by priority */
export function groupByPriority(
	proposals: ProposalDocData[],
): Record<string, ProposalDocData[]> {
	const groups: Record<string, ProposalDocData[]> = {};
	for (const proposal of proposals) {
		const p = proposal.priority || "none";
		if (!groups[p]) groups[p] = [];
		groups[p].push(proposal);
	}
	return groups;
}

// ──────────────────────────────────────────
// AC#3: GitHub Pages Deployment Config
// ──────────────────────────────────────────

/** GitHub Actions workflow for docs deployment */
export function generateGitHubPagesWorkflow(): string {
	return `name: Deploy Documentation

on:
  push:
    branches: [main]
    paths:
      - 'roadmap/proposals/**'
      - 'src/**'
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - run: npm ci

      - name: Generate documentation
        run: node --experimental-strip-types scripts/generate-full-docs.ts --output docs/generated

      - uses: actions/configure-pages@v4
        id: pages

      - uses: actions/upload-pages-artifact@v3
        with:
          path: docs/generated

  deploy:
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - uses: actions/deploy-pages@v4
        id: deployment
`;
}

/** Generate mkdocs.yml or equivalent config */
export function generateDocsConfig(projectName: string): string {
	return `site_name: "${projectName} - Documentation"
site_description: "Product development roadmap and proposal documentation"
repo_url: "https://github.com/org/repo"
repo_name: "org/repo"

theme:
  name: material
  palette:
    - scheme: default
      primary: indigo
      accent: indigo
  features:
    - navigation.instant
    - navigation.tabs
    - navigation.sections
    - search.highlight
    - search.suggest

nav:
  - Home: index.md
  - Proposals:
    - Overview: proposals/index.md
    - Complete: proposals/by-status/complete.md
    - Active: proposals/by-status/active.md
    - Accepted: proposals/by-status/accepted.md
  - Architecture: architecture.md

plugins:
  - search

markdown_extensions:
  - tables
  - attr_list
  - md_in_html
  - pymdownx.details
  - pymdownx.superfences
`;
}

// ──────────────────────────────────────────
// AC#4: Cross-Referencing Navigation
// ──────────────────────────────────────────

/** Build cross-reference links between proposals */
export function buildCrossReferences(
	proposals: ProposalDocData[],
): Map<string, string[]> {
	const refs = new Map<string, string[]>();

	for (const proposal of proposals) {
		const links: string[] = [];

		// Dependency links
		for (const dep of proposal.dependencies) {
			const depProposal = proposals.find((s) => s.id === dep);
			if (depProposal) {
				links.push(`depends-on:${dep}`);
			}
		}

		// Reverse dependency links (what depends on this proposal)
		for (const other of proposals) {
			if (other.dependencies.includes(proposal.id)) {
				links.push(`depended-by:${other.id}`);
			}
		}

		// Parent-child links
		if (proposal.parentProposalId) {
			links.push(`child-of:${proposal.parentProposalId}`);
		}

		refs.set(proposal.id, links);
	}

	return refs;
}

/** Generate navigation sidebar config */
export interface SidebarEntry {
	title: string;
	path?: string;
	children?: SidebarEntry[];
}

export function generateNavigation(
	proposals: ProposalDocData[],
): SidebarEntry[] {
	const nav: SidebarEntry[] = [{ title: "Dashboard", path: "index.md" }];

	// Proposals by status
	const statusGroups = groupByStatus(proposals);
	for (const [status, group] of Object.entries(statusGroups)) {
		if (group.length === 0) continue;
		nav.push({
			title: `${capitalize(status)} (${group.length})`,
			children: group.map((s) => ({
				title: `${s.id}: ${s.title}`,
				path: `proposals/${s.id}.md`,
			})),
		});
	}

	return nav;
}

// ──────────────────────────────────────────
// AC#7: Incremental Generation
// ──────────────────────────────────────────

/** Generate a content hash for change detection */
export function contentHash(content: string): string {
	// Simple hash using string.charCodeAt
	let hash = 0;
	for (let i = 0; i < content.length; i++) {
		const char = content.charCodeAt(i);
		hash = ((hash << 5) - hash + char) | 0;
	}
	return hash.toString(16);
}

/** Check if a proposal file has changed since last generation */
export function hasProposalChanged(
	proposalId: string,
	currentContent: string,
	cacheDir: string,
): boolean {
	const cacheFile = join(cacheDir, `${proposalId}.hash`);
	if (!existsSync(cacheFile)) return true;

	const previousHash = readFileSync(cacheFile, "utf-8").trim();
	const currentHash = contentHash(currentContent);

	return previousHash !== currentHash;
}

/** Save the content hash for future comparison */
export function saveContentHash(
	proposalId: string,
	content: string,
	cacheDir: string,
): void {
	if (!existsSync(cacheDir)) {
		mkdirSync(cacheDir, { recursive: true });
	}
	const hash = contentHash(content);
	writeFileSync(join(cacheDir, `${proposalId}.hash`), hash);
}

// ──────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────

function getStatusBadge(status: string): string {
	const badges: Record<string, string> = {
		Complete: "✅ Complete",
		Reached: "✅ Complete",
		Active: "🔨 Active",
		Accepted: "📋 Accepted",
		New: "💡 New",
		Abandoned: "🗑️ Abandoned",
		Review: "👀 Review",
	};
	return badges[status] || status;
}

function getStatusEmoji(status: string): string {
	const emojis: Record<string, string> = {
		complete: "✅",
		reached: "✅",
		active: "🔨",
		accepted: "📋",
		potential: "💡",
		abandoned: "🗑️",
		review: "👀",
	};
	return emojis[status.toLowerCase()] || "📌";
}

function getPriorityBadge(priority: string): string {
	const badges: Record<string, string> = {
		high: "🔴 High",
		medium: "🟡 Medium",
		low: "🟢 Low",
	};
	return badges[priority.toLowerCase()] || priority;
}

function getMaturityBadge(maturity: string): string {
	const badges: Record<string, string> = {
		contracted: "📝 Contracted",
		audited: "🔍 Audited",
		reviewed: "👀 Reviewed",
	};
	return badges[maturity.toLowerCase()] || maturity;
}

function capitalize(str: string): string {
	return str.charAt(0).toUpperCase() + str.slice(1);
}
