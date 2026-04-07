/**
 * Scout module: Analyzes roadmap and proposes new proposals or obstacles.
 * Used by agents to identify gaps and suggest improvements.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface ProposalInfo {
	id: string;
	title: string;
	status: string;
	dependencies: string[];
	labels: string[];
	directive?: string;
	unlocks?: string[];
	needs_capabilities?: string[];
	description?: string;
}

export interface Proposal {
	type: "proposal" | "obstacle";
	title: string;
	description: string;
	rationale: string;
	suggestedDependencies: string[];
	suggestedDirective?: string;
	suggestedLabels: string[];
	priority: "high" | "medium" | "low";
}

/**
 * Parse a proposal file and extract relevant info.
 */
export function parseProposalFile(filePath: string): ProposalInfo | null {
	const content = fs.readFileSync(filePath, "utf-8");
	const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
	if (!frontmatterMatch) return null;

	const fm = frontmatterMatch[1]!;
	const id = fm.match(/^id:\s*(.+)$/m)?.[1]?.trim();
	if (!id) return null;

	const title = fm.match(/^title:\s*(.+)$/m)?.[1]?.trim() || "Untitled";
	const status = fm.match(/^status:\s*(.+)$/m)?.[1]?.trim() || "New";
	const directive = fm.match(/^directive:\s*(.+)$/m)?.[1]?.trim();
	const labelsStr = fm.match(/^labels:\s*(.+)$/m)?.[1]?.trim();
	const unlocksStr = fm.match(/^unlocks:\s*(.+)$/m)?.[1]?.trim();
	const needsStr = fm.match(/^needs_capabilities:\s*(.+)$/m)?.[1]?.trim();
	const descMatch = content.match(
		/## Description\n\n([\s\S]*?)(?:\n##|\n---|$)/,
	);
	const description = descMatch?.[1]?.trim();

	// Parse dependencies (multi-line YAML array)
	const deps: string[] = [];
	const lines = fm.split("\n");
	const depIdx = lines.findIndex((l) => l.match(/^dependencies:/));
	if (depIdx >= 0) {
		for (let i = depIdx; i < lines.length; i++) {
			const line = lines[i]!;
			const itemMatch = line.match(/^\s*-\s+(STATE-[\w.]+|\d+)$/);
			if (itemMatch?.[1]) {
				deps.push(itemMatch[1]);
			} else if (i > depIdx && line.match(/^[a-z]/i)) {
				break;
			}
		}
	}

	// Parse labels array
	const labels: string[] = [];
	if (labelsStr?.startsWith("[")) {
		for (const l of labelsStr.replace(/[[\]]/g, "").split(",")) {
			const clean = l.trim();
			if (clean) labels.push(clean);
		}
	}

	// Parse unlocks
	const unlocks: string[] = [];
	if (unlocksStr?.startsWith("[")) {
		for (const u of unlocksStr.replace(/[[\]]/g, "").split(",")) {
			const clean = u.trim();
			if (clean) unlocks.push(clean);
		}
	}

	// Parse needs_capabilities
	const needs: string[] = [];
	if (needsStr?.startsWith("[")) {
		for (const n of needsStr.replace(/[[\]]/g, "").split(",")) {
			const clean = n.trim();
			if (clean) needs.push(clean);
		}
	}

	return {
		id,
		title,
		status,
		dependencies: deps,
		labels,
		directive,
		unlocks,
		needs_capabilities: needs,
		description,
	};
}

/**
 * Load all proposals from the roadmap directory.
 */
export function loadProposals(proposalsDir: string): ProposalInfo[] {
	const proposals: ProposalInfo[] = [];
	if (!fs.existsSync(proposalsDir)) return proposals;

	for (const file of fs.readdirSync(proposalsDir)) {
		if (file.endsWith(".md")) {
			const proposal = parseProposalFile(path.join(proposalsDir, file));
			if (proposal) proposals.push(proposal);
		}
	}
	return proposals;
}

/**
 * Find gaps in the roadmap by analyzing unlocks that don't have corresponding proposals.
 */
export function findGaps(proposals: ProposalInfo[]): string[] {
	const gaps: string[] = [];
	const _proposalIds = new Set(proposals.map((s) => s.id));
	const allUnlocks = new Set<string>();
	const allCapabilities = new Set<string>();

	for (const proposal of proposals) {
		for (const u of proposal.unlocks || []) {
			allUnlocks.add(u);
		}
		for (const c of proposal.needs_capabilities || []) {
			allCapabilities.add(c);
		}
	}

	// Check if unlocked capabilities have proposals that use them
	for (const capability of allCapabilities) {
		const hasImplementation = proposals.some(
			(s) =>
				s.labels.includes(capability) ||
				s.title.toLowerCase().includes(capability.toLowerCase()),
		);
		if (!hasImplementation) {
			gaps.push(
				`Capability "${capability}" is needed but no proposal implements it`,
			);
		}
	}

	return gaps;
}

/**
 * Compute suggested directive based on dependency depth.
 */
export function suggestDirective(
	proposal: ProposalInfo,
	allProposals: ProposalInfo[],
): string {
	const depGraph = new Map(allProposals.map((s) => [s.id, s]));
	const visited = new Set<string>();

	function getDepth(id: string): number {
		if (visited.has(id)) return 0;
		visited.add(id);
		const s = depGraph.get(id);
		if (!s || s.dependencies.length === 0) return 0;
		return 1 + Math.max(...s.dependencies.map(getDepth));
	}

	const depth = getDepth(proposal.id);
	// Map depth to directive
	if (depth === 0) return "m-1";
	if (depth <= 2) return "m-3";
	if (depth <= 4) return "m-6";
	return "m-9";
}

/**
 * Analyze the roadmap and generate proposals for missing proposals.
 */
export function generateProposals(proposals: ProposalInfo[]): Proposal[] {
	const generatedProposals: Proposal[] = [];
	const _proposalIds = new Set(proposals.map((s) => s.id));
	const _reachedIds = new Set(
		proposals.filter((s) => s.status === "Reached").map((s) => s.id),
	);

	// Find proposals with unlocks that aren't implemented
	const unimplementedUnlocks = new Map<string, string[]>();
	for (const proposal of proposals) {
		for (const unlock of proposal.unlocks || []) {
			const isImplemented = proposals.some(
				(s) =>
					s.labels.includes(unlock) ||
					s.title.toLowerCase().includes(unlock.toLowerCase()),
			);
			if (!isImplemented) {
				if (!unimplementedUnlocks.has(unlock)) {
					unimplementedUnlocks.set(unlock, []);
				}
				unimplementedUnlocks.get(unlock)?.push(proposal.id);
			}
		}
	}

	for (const [capability, unlockedBy] of unimplementedUnlocks) {
		generatedProposals.push({
			type: "proposal",
			title: `Implement ${capability}`,
			description: `This capability is unlocked by ${unlockedBy.join(", ")} but has no implementation proposal.`,
			rationale: `Unlocked capability needs implementation to realize value from ${unlockedBy[0]}`,
			suggestedDependencies: unlockedBy,
			suggestedDirective: "m-6",
			suggestedLabels: [capability.toLowerCase().replace(/\s+/g, "-")],
			priority: "medium",
		});
	}

	// Find potential obstacles (proposals with many dependents but low progress)
	const dependentCount = new Map<string, number>();
	for (const proposal of proposals) {
		for (const dep of proposal.dependencies) {
			dependentCount.set(dep, (dependentCount.get(dep) || 0) + 1);
		}
	}

	for (const [id, count] of dependentCount) {
		if (count >= 3) {
			const proposal = proposals.find((s) => s.id === id);
			if (proposal && proposal.status !== "Reached") {
				generatedProposals.push({
					type: "obstacle",
					title: `Bottleneck: ${proposal.title}`,
					description: `${proposal.id} blocks ${count} other proposals. Consider prioritizing or parallelizing.`,
					rationale: `High dependency count (${count}) indicates potential bottleneck`,
					suggestedDependencies: [],
					suggestedLabels: ["obstacle"],
					priority: "high",
				});
			}
		}
	}

	return generatedProposals;
}

/**
 * Format a proposal for display.
 */
export function formatProposal(proposal: Proposal, index: number): string {
	const lines = [
		`### Proposal ${index + 1}: ${proposal.title}`,
		`**Type:** ${proposal.type}`,
		`**Priority:** ${proposal.priority}`,
		`**Description:** ${proposal.description}`,
		`**Rationale:** ${proposal.rationale}`,
	];

	if (proposal.suggestedDependencies.length > 0) {
		lines.push(
			`**Suggested Dependencies:** ${proposal.suggestedDependencies.join(", ")}`,
		);
	}
	if (proposal.suggestedDirective) {
		lines.push(`**Suggested Directive:** ${proposal.suggestedDirective}`);
	}
	if (proposal.suggestedLabels.length > 0) {
		lines.push(`**Suggested Labels:** ${proposal.suggestedLabels.join(", ")}`);
	}

	return lines.join("\n");
}

export interface AuditResult {
	orphans: ProposalInfo[];
	deadEnds: ProposalInfo[];
	brokenDependencies: Array<{ proposalId: string; missingId: string }>;
	summary: string;
}

/**
 * Audit the roadmap for DAG connectivity and common issues.
 */
export function auditRoadmap(proposals: ProposalInfo[]): AuditResult {
	const proposalIds = new Set(proposals.map((s) => s.id));
	const descendants = new Map<string, string[]>();

	// Build descendant map
	for (const proposal of proposals) {
		for (const dep of proposal.dependencies) {
			if (!descendants.has(dep)) {
				descendants.set(dep, []);
			}
			descendants.get(dep)?.push(proposal.id);
		}
	}

	const orphans: ProposalInfo[] = [];
	const deadEnds: ProposalInfo[] = [];
	const brokenDependencies: Array<{ proposalId: string; missingId: string }> =
		[];

	for (const proposal of proposals) {
		const hasDependencies = proposal.dependencies.length > 0;
		const hasDescendants = (descendants.get(proposal.id)?.length || 0) > 0;

		// Orphan: no dependencies and no descendants (unless it's the very first proposal)
		if (
			!hasDependencies &&
			!hasDescendants &&
			proposal.id !== "0" &&
			proposal.id !== "000" &&
			proposal.id !== "STATE-0"
		) {
			orphans.push(proposal);
		}

		// Dead end: reached proposal with no descendants that isn't a terminal proposal
		// Note: we don't have an explicit 'terminal' field in ProposalInfo yet,
		// but we can check if it has 'terminal' in title or labels
		const isReached = proposal.status === "Reached";
		const isTerminal =
			proposal.labels.includes("terminal") ||
			proposal.title.toLowerCase().includes("terminal") ||
			proposal.title.toLowerCase().includes("vision");

		if (isReached && !hasDescendants && !isTerminal) {
			deadEnds.push(proposal);
		}

		// Broken dependencies: references to IDs that don't exist
		for (const dep of proposal.dependencies) {
			if (!proposalIds.has(dep)) {
				brokenDependencies.push({ proposalId: proposal.id, missingId: dep });
			}
		}
	}

	let summary = `Roadmap Audit: ${proposals.length} proposals analyzed.\n`;
	if (
		orphans.length === 0 &&
		deadEnds.length === 0 &&
		brokenDependencies.length === 0
	) {
		summary += "✅ No major DAG issues detected.";
	} else {
		if (orphans.length > 0)
			summary += `❌ ${orphans.length} orphan proposals found.\n`;
		if (deadEnds.length > 0)
			summary += `⚠️ ${deadEnds.length} dead ends found.\n`;
		if (brokenDependencies.length > 0)
			summary += `❌ ${brokenDependencies.length} broken dependencies found.\n`;
	}

	return { orphans, deadEnds, brokenDependencies, summary };
}
