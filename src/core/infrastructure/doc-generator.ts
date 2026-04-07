/**
 * STATE-58: Live Product Documentation Auto-Generated
 *
 * Generates documentation from roadmap proposal on every change.
 * AC#1: Documentation auto-generated on every proposal change
 * AC#2: Includes what's built, in progress, and planned
 * AC#3: Published to accessible location on git push
 * AC#4: Includes architecture diagrams from DAG
 * AC#5: No manual maintenance required — source of truth is roadmap
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { FileSystem } from "../../infra/file-system/operations.ts";
import type { Proposal } from "../../types/index.ts";

export interface DocGeneratorOptions {
	outputDir: string;
	includeDAG: boolean;
	includeChangelog: boolean;
	format: "markdown" | "html";
	projectName?: string;
	maxChangelogEntries?: number;
	fullDetail?: boolean; // STATE-58.1: Generate full per-proposal detail pages
	incremental?: boolean; // STATE-58.1: Only regenerate changed proposals
}

export interface GeneratedDoc {
	path: string;
	content: string;
	size: number;
}

export interface GenerationResult {
	success: boolean;
	files: GeneratedDoc[];
	errors: string[];
	timestamp: string;
}

export interface StatusSummary {
	reached: Proposal[];
	active: Proposal[];
	review: Proposal[];
	new: Proposal[];
	abandoned: Proposal[];
	total: number;
}

export interface DagNode {
	id: string;
	title: string;
	status: string;
	dependencies: string[];
}

/**
 * Parse frontmatter from markdown file
 */
export function parseFrontmatter(content: string): Record<string, unknown> {
	const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---/;
	const match = content.match(frontmatterRegex);

	if (!match) {
		return {};
	}

	const yaml = match[1];
	const result: Record<string, unknown> = {};

	// Track current key for multi-line values
	let currentKey: string | null = null;
	let inArray = false;
	let currentArray: string[] = [];
	const _inMultilineString = false;
	const _multilineContent = "";
	const _indentLevel = 0;

	const lines = yaml?.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line?.trim();

		// Skip empty lines
		if (!trimmed) {
			continue;
		}

		// Check for list item
		if (trimmed.startsWith("- ") && currentKey) {
			inArray = true;
			const value = trimmed.slice(2).trim();
			// Remove surrounding quotes
			const cleanValue = value.replace(/^['"]|['"]$/g, "");
			currentArray.push(cleanValue);
			continue;
		}

		// If we were in an array and hit a non-array line, save the array
		if (inArray && !trimmed.startsWith("- ") && currentKey) {
			result[currentKey] = currentArray;
			inArray = false;
			currentArray = [];
			currentKey = null;
		}

		// Check for key-value pair
		const colonIndex = line?.indexOf(":");
		if (colonIndex > 0) {
			// Save previous array if exists
			if (inArray && currentKey) {
				result[currentKey] = currentArray;
				inArray = false;
				currentArray = [];
			}

			const key = line?.slice(0, colonIndex).trim();
			let value: unknown = line?.slice(colonIndex + 1).trim();

			// Handle empty value (may be followed by array or multiline)
			if (!value) {
				currentKey = key;
				// Check if next line is an array
				if (i + 1 < lines.length && lines[i + 1]?.trim().startsWith("- ")) {
					currentArray = [];
					inArray = true;
					continue;
				}
				// Otherwise set empty string
				result[key] = "";
				currentKey = null;
				continue;
			}

			// Remove surrounding quotes
			if (typeof value === "string") {
				if (
					(value.startsWith("'") && value.endsWith("'")) ||
					(value.startsWith('"') && value.endsWith('"'))
				) {
					value = value.slice(1, -1);
				}

				// Handle JSON arrays inline
				if (
					(value as string).startsWith("[") &&
					(value as string).endsWith("]")
				) {
					try {
						value = JSON.parse(value as string);
					} catch {
						// Keep as string
					}
				}
			}

			result[key] = value;
			currentKey = null;
		}
	}

	// Handle trailing array
	if (inArray && currentKey) {
		result[currentKey] = currentArray;
	}

	return result;
}

/**
 * Parse a proposal file and extract proposal information
 */
export function parseProposalFile(filePath: string): Proposal | null {
	try {
		const content = readFileSync(filePath, "utf-8");
		const frontmatter = parseFrontmatter(content);

		if (!frontmatter.id) {
			return null;
		}

		// Extract title from filename or frontmatter
		const filename = filePath.split("/").pop() || "";
		const titleMatch = filename.match(/proposal-[\d.]+\s*-\s*(.+?)\.md$/);
		const title =
			(frontmatter.title as string) ||
			(titleMatch ? titleMatch[1]?.replace(/-/g, " ") : "Unknown");

		return {
			id: frontmatter.id as string,
			title,
			status: (frontmatter.status as string) || "New",
			assignee: (frontmatter.assignee as string[] | undefined) ?? [],
			priority: ((frontmatter.priority as string) || "medium") as
				| "high"
				| "medium"
				| "low",
			dependencies: (frontmatter.dependencies as string[]) || [],
			labels: (frontmatter.labels as string[]) || [],
			createdDate: (frontmatter.created_date as string) || "",
			updatedDate: (frontmatter.updatedDate as string) || "",
		};
	} catch {
		return null;
	}
}

/**
 * Load all proposals from the roadmap
 */
export function loadProposals(proposalsDir: string): Proposal[] {
	const proposals: Proposal[] = [];

	if (!existsSync(proposalsDir)) {
		return proposals;
	}

	const files = readdirSync(proposalsDir).filter((f) => f.endsWith(".md"));

	for (const file of files) {
		const filePath = join(proposalsDir, file);
		const proposal = parseProposalFile(filePath);
		if (proposal) {
			proposals.push(proposal);
		}
	}

	return proposals;
}

/**
 * Build status summary from proposals
 */
export function buildStatusSummary(proposals: Proposal[]): StatusSummary {
	const summary: StatusSummary = {
		reached: [],
		active: [],
		review: [],
		new: [],
		abandoned: [],
		total: proposals.length,
	};

	for (const proposal of proposals) {
		const status = proposal.status.toLowerCase();
		if (status === "reached" || status === "complete") {
			summary.reached.push(proposal);
		} else if (status === "active") {
			summary.active.push(proposal);
		} else if (status === "review") {
			summary.review.push(proposal);
		} else if (status === "new") {
			summary.new.push(proposal);
		} else if (status === "abandoned") {
			summary.abandoned.push(proposal);
		}
	}

	// Sort each category by ID
	const sortById = (a: Proposal, b: Proposal) => a.id.localeCompare(b.id);
	summary.reached.sort(sortById);
	summary.active.sort(sortById);
	summary.review.sort(sortById);
	summary.new.sort(sortById);
	summary.abandoned.sort(sortById);

	return summary;
}

/**
 * Build DAG nodes from proposals
 */
export function buildDagNodes(proposals: Proposal[]): DagNode[] {
	return proposals.map((proposal) => ({
		id: proposal.id,
		title: proposal.title,
		status: proposal.status,
		dependencies: proposal.dependencies || [],
	}));
}

/**
 * Generate PlantUML DAG diagram
 */
export function buildArchitectureSection(proposals: Proposal[]): string {
	const nodes = buildDagNodes(proposals);

	let plantuml = "```plantuml\n@startuml\n";
	plantuml += "title Architecture DAG\n\n";
	plantuml += "skinparam proposal {\n";
	plantuml += "  BackgroundColor<<reached>> #00c853\n";
	plantuml += "  BackgroundColor<<active>> #2196f3\n";
	plantuml += "  BackgroundColor<<review>> #ff9800\n";
	plantuml += "  BackgroundColor<<new>> #ffffff\n";
	plantuml += "  BackgroundColor<<abandoned>> #9e9e9e\n";
	plantuml += "}\n\n";

	// Generate proposal nodes
	for (const node of nodes) {
		const status = node.status.toLowerCase();
		const stereotype =
			status === "reached" || status === "complete" ? "reached" : status;
		plantuml += `proposal "${node.id}\\n${node.title}" as ${node.id.replace(/[-.]/g, "_")} <<${stereotype}>>\n`;
	}

	plantuml += "\n";

	// Generate dependencies
	for (const node of nodes) {
		if (node.dependencies && node.dependencies.length > 0) {
			for (const dep of node.dependencies) {
				plantuml += `${dep.replace(/[-.]/g, "_")} --> ${node.id.replace(/[-.]/g, "_")}\n`;
			}
		}
	}

	plantuml += "@enduml\n```";

	return plantuml;
}

/**
 * Format a status section
 */
export function formatStatusSection(
	title: string,
	proposals: Proposal[],
	emoji: string,
): string {
	if (proposals.length === 0) {
		return `## ${emoji} ${title} (0)\n\n_No proposals in this category._\n`;
	}

	let section = `## ${emoji} ${title} (${proposals.length})\n\n`;

	for (const proposal of proposals) {
		section += `- **${proposal.id}**: ${proposal.title}`;
		if (proposal.assignee) {
			const assignees = Array.isArray(proposal.assignee)
				? proposal.assignee.join(", ")
				: proposal.assignee;
			section += ` (${assignees})`;
		}
		section += "\n";
	}

	return `${section}\n`;
}

/**
 * Build changelog section from recent proposal changes
 */
export function buildChangelogSection(
	proposals: Proposal[],
	maxEntries: number = 20,
): string {
	// Sort by updated_date descending
	const sorted = [...proposals]
		.filter((s) => s.updatedDate)
		.sort((a, b) =>
			(b.updatedDate ?? "").localeCompare(a.updatedDate ?? ""),
		)
		.slice(0, maxEntries);

	if (sorted.length === 0) {
		return "## 📝 Recent Changes\n\n_No recent changes._\n";
	}

	let section = "## 📝 Recent Changes\n\n";

	for (const proposal of sorted) {
		section += `- **${proposal.updatedDate}**: ${proposal.id} - ${proposal.title} (${proposal.status})\n`;
	}

	return `${section}\n`;
}

/**
 * Generate quick start section
 */
export function buildQuickStartSection(_projectName: string): string {
	return `## 🚀 Quick Start

\`\`\`bash
# Clone the repository
git clone <repo-url>

# Install dependencies
npm install

# Start development
npm run dev

# Run tests
npm test
\`\`\`

## 📖 Documentation

- **[roadmap/MAP.md](roadmap/MAP.md)** - Architecture and roadmap
- **[roadmap/DNA.md](roadmap/DNA.md)** - Project vision and principles
- **[docs/](docs/)** - Additional documentation

## 🤝 Contributing

1. Pick a New proposal from the roadmap
2. Claim it using \`roadmap proposal claim <id>\`
3. Implement and test
4. Submit for review
`;
}

/**
 * Format the complete documentation
 */
export function formatMarkdown(
	summary: StatusSummary,
	projectName: string,
	options: DocGeneratorOptions,
	proposals: Proposal[],
): string {
	const timestamp = new Date().toISOString();

	let doc = `# 📊 Product Documentation - ${projectName}\n\n`;
	doc += `_Auto-generated from roadmap proposal on ${timestamp}_\n\n`;

	// Status overview
	doc += "## 📈 Status Overview\n\n";
	doc += `| Status | Count |\n|--------|-------|\n`;
	doc += `| ✅ Reached | ${summary.reached.length} |\n`;
	doc += `| 🔵 Active | ${summary.active.length} |\n`;
	doc += `| 🟡 Review | ${summary.review.length} |\n`;
	doc += `| ⚪ New | ${summary.new.length} |\n`;
	doc += `| ❌ Abandoned | ${summary.abandoned.length} |\n`;
	doc += `| **Total** | **${summary.total}** |\n\n`;

	// Status sections
	doc += "---\n\n";
	doc += formatStatusSection("Reached (Completed)", summary.reached, "✅");
	doc += formatStatusSection("Active (In Progress)", summary.active, "🔵");
	doc += formatStatusSection("Review (Testing)", summary.review, "🟡");
	doc += formatStatusSection("New (Backlog)", summary.new, "⚪");
	doc += formatStatusSection("Abandoned", summary.abandoned, "❌");

	// Architecture DAG
	if (options.includeDAG) {
		doc += "---\n\n## 🏗️ Architecture (DAG)\n\n";
		doc += buildArchitectureSection(proposals);
		doc += "\n";
	}

	// Changelog
	if (options.includeChangelog) {
		doc += "---\n\n";
		doc += buildChangelogSection(proposals, options.maxChangelogEntries);
	}

	// Quick start
	doc += "---\n\n";
	doc += buildQuickStartSection(projectName);

	return doc;
}

/**
 * Full proposal detail for per-proposal documentation pages
 */
export interface ProposalFullDetail {
	id: string;
	title: string;
	status: string;
	priority: string;
	maturity: string;
	assignee: string | string[];
	builder?: string;
	auditor?: string;
	created_date?: string;
	updated_date?: string;
	labels: string[];
	dependencies: string[];
	parent_proposal_id?: string;
	directive?: string;
	description: string;
	acceptanceCriteria: Array<{
		number: number;
		text: string;
		passed: boolean;
	}>;
	implementationNotes: string;
	implementationPlan: string;
	auditNotes: string;
	finalSummary: string;
	proofOfArrival: string;
	files: string[];
}

/**
 * Extract section content between markers
 */
function extractSection(content: string, sectionName: string): string {
	const patterns = [
		// Format: <!-- SECTION:NAME:BEGIN --> ... <!-- SECTION:NAME:END -->
		new RegExp(
			`<!-- SECTION:${sectionName}:BEGIN -->\\s*([\\s\\S]*?)\\s*<!-- SECTION:${sectionName}:END -->`,
			"i",
		),
		// Format: <!-- NAME:BEGIN --> ... <!-- NAME:END --> (without SECTION prefix)
		new RegExp(
			`<!-- ${sectionName}:BEGIN -->\\s*([\\s\\S]*?)\\s*<!-- ${sectionName}:END -->`,
			"i",
		),
		// Format: ## Name followed by content until next ##
		new RegExp(`## ${sectionName}\\s*\\n\\n([\\s\\S]*?)(?=\\n## |$)`, "i"),
	];

	for (const pattern of patterns) {
		const match = content.match(pattern);
		if (match) {
			return match[1]?.trim();
		}
	}
	return "";
}

/**
 * Parse acceptance criteria from proposal content
 */
function parseAcceptanceCriteria(
	content: string,
): Array<{ number: number; text: string; passed: boolean }> {
	const acSection = extractSection(content, "AC");
	const criteria: Array<{ number: number; text: string; passed: boolean }> = [];

	const lines = acSection.split("\n");
	for (const line of lines) {
		const match = line.match(/- \[([ x])\] #(\d+) (.+)/);
		if (match) {
			criteria.push({
				number: Number.parseInt(match[2]!, 10),
				text: match[3]?.trim(),
				passed: match[1] === "x",
			});
		}
	}

	return criteria;
}

/**
 * Extract file references from implementation notes
 */
function extractFiles(notes: string): string[] {
	const files: string[] = [];
	const patterns = [
		/(?:Create|Update|Modify|Extend|Add)\s+(?:`([^`]+)`|(\S+\.(?:ts|js|md|yml|json)))/gi,
		/`(src\/[^`]+|docs\/[^`]+|roadmap\/[^`]+)`/gi,
	];

	for (const pattern of patterns) {
		let match;
		while ((match = pattern.exec(notes)) !== null) {
			const file = match[1] || match[2];
			if (file && !files.includes(file)) {
				files.push(file);
			}
		}
	}

	return files;
}

/**
 * Parse a proposal file for full detail
 */
export function parseProposalFileFullDetail(
	filePath: string,
): ProposalFullDetail | null {
	try {
		const content = readFileSync(filePath, "utf-8");
		const frontmatter = parseFrontmatter(content);

		if (!frontmatter.id) {
			return null;
		}

		const filename = filePath.split("/").pop() || "";
		const titleMatch = filename.match(/proposal-[\d.]+\s*-\s*(.+?)\.md$/);
		const title =
			(frontmatter.title as string) ||
			(titleMatch ? titleMatch[1]?.replace(/-/g, " ") : "Unknown");

		const description = extractSection(content, "DESCRIPTION");
		const implementationNotes = extractSection(content, "NOTES");
		const implementationPlan = extractSection(content, "PLAN");
		const auditNotes = extractSection(content, "AUDIT_NOTES");
		const finalSummary = extractSection(content, "FINAL_SUMMARY");
		const proofOfArrival = extractSection(content, "PROOF_OF_ARRIVAL");

		return {
			id: frontmatter.id as string,
			title,
			status: (frontmatter.status as string) || "New",
			priority: (frontmatter.priority as string) || "medium",
			maturity: (frontmatter.maturity as string) || "contracted",
			assignee: (frontmatter.assignee as string[] | string) || "",
			builder: frontmatter.builder as string | undefined,
			auditor: frontmatter.auditor as string | undefined,
			created_date: frontmatter.created_date as string | undefined,
			updated_date: frontmatter.updatedDate as string | undefined,
			labels: (frontmatter.labels as string[]) || [],
			dependencies: (frontmatter.dependencies as string[]) || [],
			parent_proposal_id: frontmatter.parent_proposal_id as string | undefined,
			directive: frontmatter.directive as string | undefined,
			description,
			acceptanceCriteria: parseAcceptanceCriteria(content),
			implementationNotes,
			implementationPlan,
			auditNotes,
			finalSummary,
			proofOfArrival,
			files: extractFiles(implementationNotes),
		};
	} catch {
		return null;
	}
}

/**
 * Build reverse dependency map (which proposals depend on each proposal)
 */
export function buildReverseDependencies(
	proposals: ProposalFullDetail[],
): Map<string, string[]> {
	const reverseDeps = new Map<string, string[]>();

	// Initialize all proposals
	for (const proposal of proposals) {
		if (!reverseDeps.has(proposal.id)) {
			reverseDeps.set(proposal.id, []);
		}
	}

	// Build reverse links
	for (const proposal of proposals) {
		for (const dep of proposal.dependencies) {
			if (!reverseDeps.has(dep)) {
				reverseDeps.set(dep, []);
			}
			const dependents = reverseDeps.get(dep)!;
			if (!dependents.includes(proposal.id)) {
				dependents.push(proposal.id);
			}
		}
	}

	return reverseDeps;
}

/**
 * Generate dependency chain visualization
 */
export function generateDependencyChain(
	proposalId: string,
	allProposals: ProposalFullDetail[],
): string {
	const proposalMap = new Map(allProposals.map((s) => [s.id, s]));
	const visited = new Set<string>();
	const chains: string[] = [];

	function buildChain(id: string, path: string[]): void {
		if (visited.has(id)) return;
		visited.add(id);

		const proposal = proposalMap.get(id);
		if (!proposal || proposal.dependencies.length === 0) {
			chains.push(path.join(" → "));
			return;
		}

		for (const dep of proposal.dependencies) {
			buildChain(dep, [...path, dep]);
		}
	}

	buildChain(proposalId, [proposalId]);
	return chains.join("\n");
}

/**
 * Generate full proposal detail markdown page
 */
export function generateFullProposalDetail(
	proposal: ProposalFullDetail,
	reverseDeps?: Map<string, string[]>,
	allProposals?: ProposalFullDetail[],
): string {
	const timestamp = new Date().toISOString();

	let page = `# ${proposal.id} - ${proposal.title}\n\n`;
	page += `_Documentation generated on ${timestamp}_\n\n`;

	// Status badges
	const statusEmoji: Record<string, string> = {
		reached: "✅",
		active: "🔵",
		review: "🟡",
		new: "⚪",
		abandoned: "❌",
	};
	const priorityColor: Record<string, string> = {
		high: "🔴",
		medium: "🟡",
		low: "🟢",
	};

	page += `| Status | Priority | Maturity | Priority |\n`;
	page += `|--------|----------|----------|----------|\n`;
	page += `| ${statusEmoji[proposal.status.toLowerCase()] || "⚪"} ${capitalize(proposal.status)} | ${priorityColor[proposal.priority.toLowerCase()] || "⚪"} ${capitalize(proposal.priority)} | ${capitalize(proposal.maturity)} |\n\n`;

	// Metadata
	page += "## 📋 Metadata\n\n";
	page += `| Field | Value |\n|-------|-------|\n`;

	const assignees = Array.isArray(proposal.assignee)
		? proposal.assignee.join(", ")
		: proposal.assignee;
	if (assignees) {
		page += `| **Assignee** | ${assignees} |\n`;
	}
	if (proposal.builder) {
		page += `| **Builder** | ${proposal.builder} |\n`;
	}
	if (proposal.auditor) {
		page += `| **Auditor** | ${proposal.auditor} |\n`;
	}
	if (proposal.created_date) {
		page += `| **Created** | ${proposal.created_date} |\n`;
	}
	if (proposal.updated_date) {
		page += `| **Updated** | ${proposal.updated_date} |\n`;
	}
	if (proposal.directive) {
		page += `| **Directive** | ${proposal.directive} |\n`;
	}
	if (proposal.parent_proposal_id) {
		page += `| **Parent** | [${proposal.parent_proposal_id}](${proposal.parent_proposal_id}.md) |\n`;
	}
	if (proposal.labels.length > 0) {
		page += `| **Labels** | ${proposal.labels.map((l) => `\`${l}\``).join(", ")} |\n`;
	}
	page += "\n";

	// Dependencies (prerequisites)
	if (proposal.dependencies.length > 0) {
		page += "## 🔗 Dependencies (Prerequisites)\n\n";
		page +=
			"_This proposal depends on the following proposals being completed first:_\n\n";
		for (const dep of proposal.dependencies) {
			const depProposal = allProposals?.find((s) => s.id === dep);
			const statusEmoji = depProposal
				? {
						reached: "✅",
						active: "🔵",
						review: "🟡",
						new: "⚪",
						abandoned: "❌",
					}[depProposal.status.toLowerCase()] || "⚪"
				: "⚪";
			page += `- ${statusEmoji} [${dep}](../${dep}.md)\n`;
		}
		page += "\n";
	}

	// Dependents (reverse dependencies)
	if (reverseDeps) {
		const dependents = reverseDeps.get(proposal.id);
		if (dependents && dependents.length > 0) {
			page += "## ⬇️ Dependents (Proposals that depend on this)\n\n";
			page += "_The following proposals depend on this proposal:_\n\n";
			for (const dependent of dependents) {
				const depProposal = allProposals?.find((s) => s.id === dependent);
				const statusEmoji = depProposal
					? {
							reached: "✅",
							active: "🔵",
							review: "🟡",
							new: "⚪",
							abandoned: "❌",
						}[depProposal.status.toLowerCase()] || "⚪"
					: "⚪";
				page += `- ${statusEmoji} [${dependent}](../${dependent}.md)\n`;
			}
			page += "\n";
		}
	}

	// Description
	if (proposal.description) {
		page += "## 📝 Description\n\n";
		page += `${proposal.description}\n\n`;
	}

	// Acceptance Criteria
	if (proposal.acceptanceCriteria.length > 0) {
		page += "## ✅ Acceptance Criteria\n\n";
		const passed = proposal.acceptanceCriteria.filter((ac) => ac.passed).length;
		page += `**${passed}/${proposal.acceptanceCriteria.length}** criteria passed\n\n`;

		page += `| # | Criterion | Status |\n`;
		page += `|---|-----------|--------|\n`;
		for (const ac of proposal.acceptanceCriteria) {
			page += `| ${ac.number} | ${ac.text} | ${ac.passed ? "✅" : "⬜"} |\n`;
		}
		page += "\n";
	}

	// Implementation Plan
	if (proposal.implementationPlan) {
		page += "## 📋 Implementation Plan\n\n";
		page += `${proposal.implementationPlan}\n\n`;
	}

	// Implementation Notes
	if (proposal.implementationNotes) {
		page += "## 🔧 Implementation Notes\n\n";
		page += `${proposal.implementationNotes}\n\n`;
	}

	// Files Created
	if (proposal.files.length > 0) {
		page += "## 📁 Files\n\n";
		for (const file of proposal.files) {
			page += `- \`${file}\`\n`;
		}
		page += "\n";
	}

	// Audit Notes
	if (proposal.auditNotes) {
		page += "## 🔍 Audit Notes\n\n";
		page += `${proposal.auditNotes}\n\n`;
	}

	// Proof of Arrival
	if (proposal.proofOfArrival) {
		page += "## 🎯 Proof of Arrival\n\n";
		page += `${proposal.proofOfArrival}\n\n`;
	}

	// Final Summary
	if (proposal.finalSummary) {
		page += "## 📊 Final Summary\n\n";
		page += `${proposal.finalSummary}\n\n`;
	}

	return page;
}

/**
 * Capitalize first letter
 */
function capitalize(str: string): string {
	return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Generate all per-proposal detail pages with cross-referencing navigation
 */
/**
 * Generate all per-proposal detail pages with cross-referencing navigation
 * Supports incremental mode: only regenerates pages for proposals that changed since last run
 */
export function generateProposalDetailPages(
	proposalsDir: string,
	outputDir: string,
	incremental = false,
): GeneratedDoc[] {
	const docs: GeneratedDoc[] = [];

	if (!existsSync(proposalsDir)) {
		return docs;
	}

	const proposalDir = join(outputDir, "proposals");
	if (!existsSync(proposalDir)) {
		mkdirSync(proposalDir, { recursive: true });
	}

	// Cache file for incremental generation (stores file modification times)
	const cachePath = join(outputDir, ".doc-cache.json");
	let cache: Record<string, number> = {};
	if (incremental && existsSync(cachePath)) {
		try {
			cache = JSON.parse(readFileSync(cachePath, "utf-8"));
		} catch {
			cache = {};
		}
	}

	const files = readdirSync(proposalsDir).filter((f) => f.endsWith(".md"));

	// First pass: parse all proposals to build cross-references
	const allProposals: ProposalFullDetail[] = [];
	for (const file of files) {
		const filePath = join(proposalsDir, file);
		const detail = parseProposalFileFullDetail(filePath);
		if (detail) {
			allProposals.push(detail);
		}
	}

	// Build reverse dependency map for cross-references
	const reverseDeps = buildReverseDependencies(allProposals);

	// Determine which proposals need regeneration
	const newCache: Record<string, number> = {};
	for (const proposal of allProposals) {
		const file =
			files.find((f) =>
				f
					.replace(/-/g, "")
					.includes(proposal.id.replace(/[-.]/g, "").toLowerCase()),
			) || "";
		const filePath = join(proposalsDir, file);

		let needsRegeneration = !incremental; // Always regenerate if not incremental
		if (incremental && existsSync(filePath)) {
			const stat = statSync(filePath);
			const lastModified = cache[proposal.id] || 0;
			needsRegeneration = stat.mtimeMs > lastModified;
		}

		if (needsRegeneration || !incremental) {
			const content = generateFullProposalDetail(
				proposal,
				reverseDeps,
				allProposals,
			);
			const proposalPath = join(proposalDir, `${proposal.id}.md`);
			writeFileSync(proposalPath, content, "utf-8");

			docs.push({
				path: proposalPath,
				content,
				size: Buffer.byteLength(content),
			});
		}

		// Update cache with current timestamp
		if (existsSync(filePath)) {
			const stat = statSync(filePath);
			newCache[proposal.id] = stat.mtimeMs;
		}
	}

	// Save cache for next incremental run
	if (incremental) {
		writeFileSync(cachePath, JSON.stringify(newCache, null, 2), "utf-8");
	}

	return docs;
}

/**
 * Generate index page with links to all proposal detail pages
 */
export function generateProposalIndex(
	summary: StatusSummary,
	projectName: string,
): string {
	const timestamp = new Date().toISOString();

	let page = `# ${projectName} - Documentation\n\n`;
	page += `_Auto-generated on ${timestamp}_\n\n`;

	page += "## 📖 Documentation\n\n";
	page += `- **[README.md](./README.md)** - Main documentation with status overview\n`;
	page += `- **[STATUS.md](./STATUS.md)** - Quick status summary\n`;
	page += `- **[DAG.md](./DAG.md)** - Architecture diagrams\n`;
	page += `- **[INDEX.md](./INDEX.md)** - This page (full proposal index)\n\n`;

	page += "## 📈 Status Overview\n\n";
	page += `| Status | Count | Link |\n|--------|-------|------|\n`;
	page += `| ✅ Reached | ${summary.reached.length} | [View all](status/reached.md) |\n`;
	page += `| 🔵 Active | ${summary.active.length} | [View all](status/active.md) |\n`;
	page += `| 🟡 Review | ${summary.review.length} | [View all](status/review.md) |\n`;
	page += `| ⚪ New | ${summary.new.length} | [View all](status/new.md) |\n`;
	page += `| ❌ Abandoned | ${summary.abandoned.length} | [View all](status/abandoned.md) |\n`;
	page += `| **Total** | **${summary.total}** | |\n\n`;

	// All proposals table
	page += "## 📋 All Proposals\n\n";
	page += `| ID | Title | Status | Priority |\n`;
	page += `|-----|-------|--------|----------|\n`;

	const allProposals = [
		...summary.reached,
		...summary.active,
		...summary.review,
		...summary.new,
		...summary.abandoned,
	];

	for (const proposal of allProposals) {
		page += `| [${proposal.id}](proposals/${proposal.id}.md) | ${proposal.title} | ${proposal.status} | ${proposal.priority} |\n`;
	}

	return page;
}

/**
 * Generate per-status index pages
 */
export function generateStatusIndexPages(
	summary: StatusSummary,
	outputDir: string,
): GeneratedDoc[] {
	const docs: GeneratedDoc[] = [];
	const statusDir = join(outputDir, "status");

	if (!existsSync(statusDir)) {
		mkdirSync(statusDir, { recursive: true });
	}

	const statuses: Array<{
		name: string;
		emoji: string;
		proposals: Proposal[];
	}> = [
		{ name: "reached", emoji: "✅", proposals: summary.reached },
		{ name: "active", emoji: "🔵", proposals: summary.active },
		{ name: "review", emoji: "🟡", proposals: summary.review },
		{ name: "new", emoji: "⚪", proposals: summary.new },
		{ name: "abandoned", emoji: "❌", proposals: summary.abandoned },
	];

	for (const status of statuses) {
		let content = `# ${status.emoji} ${capitalize(status.name)} Proposals\n\n`;
		content += `_${status.proposals.length} proposals in this category_\n\n`;

		if (status.proposals.length > 0) {
			content += `| ID | Title | Priority | Updated |\n`;
			content += `|-----|-------|----------|--------|\n`;
			for (const proposal of status.proposals) {
				content += `| [${proposal.id}](../proposals/${proposal.id}.md) | ${proposal.title} | ${proposal.priority} | ${proposal.updatedDate || "N/A"} |\n`;
			}
		} else {
			content += "_No proposals in this category._\n";
		}

		const filePath = join(statusDir, `${status.name}.md`);
		writeFileSync(filePath, content, "utf-8");

		docs.push({
			path: filePath,
			content,
			size: Buffer.byteLength(content),
		});
	}

	return docs;
}

/**
 * Generate GitHub Actions workflow for Pages deployment
 */
export function generateGitHubPagesWorkflow(): {
	path: string;
	content: string;
} {
	const content = `name: Deploy Documentation to GitHub Pages

on:
  push:
    branches: [main]
    paths:
      - 'roadmap/proposals/**'
      - 'src/core/doc-generator.ts'
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  generate-docs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Generate documentation
        run: npx roadmap docs generate --output docs/

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: docs/

  deploy:
    needs: generate-docs
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
`;

	return {
		path: ".github/workflows/deploy-docs.yml",
		content,
	};
}

/**
 * Main documentation generation function (enhanced for STATE-58.1)
 */
export async function generateDocs(
	projectRoot: string,
	options: DocGeneratorOptions,
): Promise<GenerationResult> {
	const result: GenerationResult = {
		success: true,
		files: [],
		errors: [],
		timestamp: new Date().toISOString(),
	};

	try {
		const filesystem = new FileSystem(projectRoot);
		const config = await filesystem.loadConfig();
		const projectName = options.projectName || config?.projectName || "Project";

		// Load proposals
		const proposalsDir = filesystem.proposalsDir;
		const proposals = loadProposals(proposalsDir);

		// Build summary
		const summary = buildStatusSummary(proposals);

		// Generate main documentation
		const mainDoc = formatMarkdown(summary, projectName, options, proposals);

		// Ensure output directory exists
		const outputDir = resolve(projectRoot, options.outputDir);
		if (!existsSync(outputDir)) {
			mkdirSync(outputDir, { recursive: true });
		}

		// Write main documentation
		const mainPath = join(outputDir, "README.md");
		writeFileSync(mainPath, mainDoc, "utf-8");

		result.files.push({
			path: mainPath,
			content: mainDoc,
			size: Buffer.byteLength(mainDoc),
		});

		// Generate index file
		const indexDoc = `# Documentation Index

## Auto-Generated Documentation

This documentation is automatically generated from the roadmap proposal.

- **[README.md](./README.md)** - Main documentation with status overview
- **[STATUS.md](./STATUS.md)** - Quick status summary
- **[DAG.md](./DAG.md)** - Architecture diagrams

_Generated on: ${result.timestamp}_
`;

		const indexPath = join(outputDir, "INDEX.md");
		writeFileSync(indexPath, indexDoc, "utf-8");

		result.files.push({
			path: indexPath,
			content: indexDoc,
			size: Buffer.byteLength(indexDoc),
		});

		// Generate quick status file
		const statusDoc = `# Quick Status

_Last updated: ${result.timestamp}_

## Summary
- ✅ Reached: ${summary.reached.length}
- 🔵 Active: ${summary.active.length}
- 🟡 Review: ${summary.review.length}
- ⚪ New: ${summary.new.length}
- ❌ Abandoned: ${summary.abandoned.length}

## Active Proposals
${summary.active.map((s) => `- ${s.id}: ${s.title}`).join("\n") || "_None_"}

## In Review
${summary.review.map((s) => `- ${s.id}: ${s.title}`).join("\n") || "_None_"}
`;

		const statusPath = join(outputDir, "STATUS.md");
		writeFileSync(statusPath, statusDoc, "utf-8");

		result.files.push({
			path: statusPath,
			content: statusDoc,
			size: Buffer.byteLength(statusDoc),
		});

		// Generate DAG file if requested
		if (options.includeDAG) {
			const dagDoc = `# Architecture DAG

_Generated on: ${result.timestamp}_

${buildArchitectureSection(proposals)}
`;

			const dagPath = join(outputDir, "DAG.md");
			writeFileSync(dagPath, dagDoc, "utf-8");

			result.files.push({
				path: dagPath,
				content: dagDoc,
				size: Buffer.byteLength(dagDoc),
			});
		}

		// STATE-58.1: Generate per-proposal detail pages (if fullDetail mode enabled)
		if (options.fullDetail !== false) {
			const proposalDetailPages = generateProposalDetailPages(
				proposalsDir,
				outputDir,
				options.incremental || false,
			);
			result.files.push(...proposalDetailPages);
		}

		// Generate enhanced proposal index with full navigation
		const proposalIndex = generateProposalIndex(summary, projectName);
		const proposalIndexPath = join(outputDir, "INDEX.md");
		writeFileSync(proposalIndexPath, proposalIndex, "utf-8");
		result.files.push({
			path: proposalIndexPath,
			content: proposalIndex,
			size: Buffer.byteLength(proposalIndex),
		});

		// Generate per-status index pages
		const statusPages = generateStatusIndexPages(summary, outputDir);
		result.files.push(...statusPages);
	} catch (error) {
		result.success = false;
		result.errors.push(error instanceof Error ? error.message : String(error));
	}

	return result;
}

/**
 * Watch for changes and regenerate docs
 */
export async function watchAndRegenerate(
	projectRoot: string,
	options: DocGeneratorOptions,
	callback?: (result: GenerationResult) => void,
): Promise<() => void> {
	const filesystem = new FileSystem(projectRoot);
	const proposalsDir = filesystem.proposalsDir;
	const configPath = filesystem.configFilePath;

	// Initial generation
	await generateDocs(projectRoot, options);

	// Simple polling watcher (cross-platform)
	let lastCheck = Date.now();

	const interval = setInterval(() => {
		try {
			// Check for changes
			const files = [
				...readdirSync(proposalsDir)
					.filter((f) => f.endsWith(".md"))
					.map((f) => join(proposalsDir, f)),
				configPath,
			].filter((f) => existsSync(f));

			let hasChanges = false;
			for (const file of files) {
				const stat = statSync(file);
				if (stat.mtimeMs > lastCheck) {
					hasChanges = true;
					break;
				}
			}

			if (hasChanges) {
				lastCheck = Date.now();
				generateDocs(projectRoot, options).then((result) => {
					if (callback) {
						callback(result);
					}
				});
			}
		} catch {
			// Ignore errors during watch
		}
	}, 5000); // Check every 5 seconds

	// Return cleanup function
	return () => clearInterval(interval);
}
