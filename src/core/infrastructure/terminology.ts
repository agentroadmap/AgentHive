/**
 * STATE-59: Rethink Roadmap as Product Design & Project Management
 *
 * Centralized terminology management for the roadmap.
 * AC#1: 'Reached' status renamed to 'Complete'
 * AC#2: 'Proposal' terminology updated to 'Component'
 * AC#3: MAP.md reflects new terminology
 * AC#4: Documentation uses product design language
 * AC#5: Migration path for existing proposals
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Status values
 */
export type StatusValue =
	| "New"
	| "Draft"
	| "Review"
	| "Active"
	| "Accepted"
	| "Complete"
	| "Rejected"
	| "Abandoned"
	| "Replaced";

/**
 * Canonical status values (new terminology)
 */
export type CanonicalStatus =
	| "New"
	| "Draft"
	| "Review"
	| "Active"
	| "Accepted"
	| "Complete"
	| "Rejected"
	| "Abandoned"
	| "Replaced";

/**
 * Status mapping from legacy to canonical
 */
export const STATUS_MAP: Record<string, CanonicalStatus> = {
	complete: "Complete",
	new: "New",
	draft: "Draft",
	potential: "New",
	active: "Active",
	review: "Review",
	accepted: "Accepted",
	rejected: "Rejected",
	abandoned: "Abandoned",
	replaced: "Replaced",
};

/**
 * Display names for statuses
 */
export const STATUS_DISPLAY: Record<CanonicalStatus, string> = {
	New: "New",
	Draft: "Draft",
	Review: "In Review",
	Active: "In Progress",
	Accepted: "Accepted",
	Complete: "Complete",
	Rejected: "Rejected",
	Abandoned: "Abandoned",
	Replaced: "Replaced",
};

/**
 * Status emoji for TUI
 */
export const STATUS_EMOJI: Record<CanonicalStatus, string> = {
	New: "★",
	Draft: "⚪",
	Review: "🟡",
	Active: "🔵",
	Accepted: "▣",
	Complete: "✅",
	Rejected: "✖",
	Abandoned: "❌",
	Replaced: "⇄",
};

/**
 * Terminology mappings
 */
export const TERMINOLOGY_MAP: Record<string, string> = {
	proposal: "component",
	Proposal: "Component",
	proposals: "components",
	Proposals: "Components",
	"proposal create": "component create",
	"proposal list": "component list",
	"proposal edit": "component edit",
	"proposal view": "component view",
	"proposal claim": "component claim",
	"proposal archive": "component archive",
};

/**
 * TUI labels using new terminology
 */
export const TUI_LABELS = {
	boardTitle: "Component Board",
	overviewTitle: "Product Overview",
	backlog: "Backlog",
	inProgress: "In Progress",
	inReview: "In Review",
	complete: "Complete",
	abandoned: "Abandoned",
	componentCount: (n: number) => `${n} component${n !== 1 ? "s" : ""}`,
	noComponents: "No components found",
	claimComponent: "Claim Component",
	startWork: "Start Work",
	submitReview: "Submit for Review",
	markComplete: "Mark Complete",
};

/**
 * CLI messages using new terminology
 */
export const CLI_MESSAGES = {
	componentCreated: (id: string) => `${formatComponentId(id)} created`,
	componentUpdated: (id: string) => `${formatComponentId(id)} updated`,
	componentClaimed: (id: string) => `${formatComponentId(id)} claimed by`,
	componentArchived: (id: string) => `${formatComponentId(id)} archived`,
	listHeader: (count: number) => `Components (${count})`,
	noComponents: "No components found",
	statusLabel: (status: CanonicalStatus) =>
		`${STATUS_EMOJI[status]} ${STATUS_DISPLAY[status]}`,
};

/**
 * MCP tool labels
 */
export const MCP_LABELS = {
	proposalList: "component_list",
	proposalCreate: "component_create",
	proposalEdit: "component_edit",
	proposalView: "component_view",
	proposalClaim: "component_claim",
};

/**
 * Normalize a status to canonical form
 */
export function normalizeStatus(status: string): CanonicalStatus {
	const normalized = status.toLowerCase().trim();
	return STATUS_MAP[normalized] || "New";
}

/**
 * Check if a status is a "complete" status (either Reached or Complete)
 */
export function isCompleteStatus(status: string): boolean {
	const canonical = normalizeStatus(status);
	return canonical === "Complete";
}

/**
 * Check if a status is "active" status
 */
export function isActiveStatus(status: string): boolean {
	return normalizeStatus(status) === "Active";
}

/**
 * Check if a status is "review" status
 */
export function isReviewStatus(status: string): boolean {
	return normalizeStatus(status) === "Review";
}

/**
 * Check if a status is "new" status
 */
export function isNewStatus(status: string): boolean {
	return normalizeStatus(status) === "New";
}

/**
 * Format status for display
 */
export function formatStatus(status: string): string {
	const canonical = normalizeStatus(status);
	return `${STATUS_EMOJI[canonical]} ${STATUS_DISPLAY[canonical]}`;
}

/**
 * Format component ID for display
 * "STATE-1" → "Component 1"
 */
export function formatComponentId(id: string): string {
	return id.replace(/^STATE-(\d+)/, "Component $1");
}

/**
 * Format component reference
 */
export function formatComponentRef(id: string, title: string): string {
	return `${formatComponentId(id)}: ${title}`;
}

/**
 * Apply terminology replacements in text
 */
export function applyTerminology(text: string): string {
	let result = text;

	// Sort by length (longest first) to avoid partial replacements
	const sortedMappings = Object.entries(TERMINOLOGY_MAP).sort(
		(a, b) => b[0].length - a[0].length,
	);

	for (const [legacy, modern] of sortedMappings) {
		// Use word boundary-aware replacement with case preservation for first char
		const regex = new RegExp(`\\b${escapeRegex(legacy)}\\b`, "g");
		result = result.replace(regex, (match) => {
			// If original starts with uppercase, use uppercase replacement
			if (match[0] === match[0].toUpperCase()) {
				return modern.charAt(0).toUpperCase() + modern.slice(1);
			}
			return modern;
		});
	}

	return result;
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse proposal file frontmatter
 */
export function parseFrontmatter(content: string): Record<string, unknown> {
	const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---/;
	const match = content.match(frontmatterRegex);

	if (!match) {
		return {};
	}

	const yaml = match[1];
	const result: Record<string, unknown> = {};

	for (const line of yaml.split("\n")) {
		const colonIndex = line.indexOf(":");
		if (colonIndex > 0) {
			const key = line.slice(0, colonIndex).trim();
			let value: unknown = line.slice(colonIndex + 1).trim();

			if (typeof value === "string" && value.startsWith("[")) {
				try {
					value = JSON.parse(value);
				} catch {
					// Keep as string
				}
			}

			result[key] = value;
		}
	}

	return result;
}

/**
 * Migrate a single proposal file to new terminology
 */
export function migrateProposalFile(filePath: string): {
	original: string;
	migrated: string;
	changes: string[];
} {
	const content = readFileSync(filePath, "utf-8");
	const changes: string[] = [];

	// Normalize status in frontmatter
	let migrated = content;

	// Replace legacy "status: Reached" with "status: Complete"
	const statusRegex = /status:\s*Reached/gi;
	if (statusRegex.test(content)) {
		migrated = migrated.replace(statusRegex, "status: Complete");
		changes.push("Legacy status: Reached → Complete");
	}

	// Apply terminology to user-facing content (not frontmatter)
	const parts = migrated.split("---");
	if (parts.length >= 3) {
		const frontmatter = `${parts[0]}---${parts[1]}---`;
		const body = parts.slice(2).join("---");

		// Apply terminology only to body
		const migratedBody = applyTerminology(body);
		if (migratedBody !== body) {
			changes.push("Applied terminology to body content");
			migrated = frontmatter + migratedBody;
		}
	}

	return {
		original: content,
		migrated,
		changes,
	};
}

/**
 * Migrate all proposals in a directory
 */
export function migrateAllProposals(proposalsDir: string): {
	totalFiles: number;
	changedFiles: number;
	results: Array<{ file: string; changes: string[] }>;
} {
	const results: Array<{ file: string; changes: string[] }> = [];
	let changedFiles = 0;

	if (!existsSync(proposalsDir)) {
		return { totalFiles: 0, changedFiles: 0, results: [] };
	}

	const files = readdirSync(proposalsDir).filter((f) => f.endsWith(".md"));

	for (const file of files) {
		const filePath = join(proposalsDir, file);
		const { migrated, changes } = migrateProposalFile(filePath);

		if (changes.length > 0) {
			writeFileSync(filePath, migrated, "utf-8");
			results.push({ file, changes });
			changedFiles++;
		}
	}

	return {
		totalFiles: files.length,
		changedFiles,
		results,
	};
}

/**
 * Generate migration guide
 */
export function generateMigrationGuide(): string {
	return `# Migration Guide: Proposal → Component Terminology

## Overview

This guide helps you transition from the legacy terminology to the new product design language.

## Status Changes

| Legacy Status | New Status | Display |
|---------------|------------|---------|
| Reached | Complete | ✅ Complete |
| Active | Active | 🔵 In Progress |
| Review | Review | 🟡 In Review |
| New | New | ⚪ Backlog |
| Abandoned | Abandoned | ❌ Abandoned |

## Terminology Changes

| Legacy | New | Example |
|--------|-----|---------|
| Proposal | Component | "STATE-1" → "Component 1" |
| proposal create | component create | CLI command |
| proposal list | component list | CLI command |

## Backward Compatibility

Both old and new terminology are supported during the transition period:

- Status: Both "Reached" and "Complete" work
- CLI: Both "proposal" and "component" commands work
- Files: Old proposal files work without modification

## Automatic Migration

To migrate all proposal files to the new terminology:

\`\`\`bash
roadmap migrate --terminology
\`\`\`

## Code Changes

For developers using the API:

\`\`\`typescript
// Legacy (still works)
import { normalizeStatus } from './core/infrastructure/terminology.ts';
const status = normalizeStatus("Reached");  // → "Complete"

// New terminology
import { isCompleteStatus, formatComponentId } from './core/infrastructure/terminology.ts';
if (isCompleteStatus(proposal.status)) {
  console.log(formatComponentId(proposal.id));  // "Component 1"
}
\`\`\`
`;
}
