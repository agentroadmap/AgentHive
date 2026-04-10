/**
 * Centralized terminology helpers for AgentHive proposal workflow language.
 *
 * This module preserves compatibility with older status labels while exposing
 * the canonical AgentHive proposal stages.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type CanonicalStatus =
	| "Draft"
	| "Review"
	| "Develop"
	| "Merge"
	| "Complete"
	| "Rejected"
	| "Discard"
	| "Replaced";

export type StatusValue = CanonicalStatus;

/**
 * Legacy aliases remain accepted so older roadmap configs and docs can still
 * be interpreted during migration.
 */
export const STATUS_MAP: Record<string, CanonicalStatus> = {
	draft: "Draft",
	new: "Draft",
	potential: "Draft",
	review: "Review",
	develop: "Develop",
	developing: "Develop",
	building: "Develop",
	active: "Develop",
	merge: "Merge",
	accepted: "Merge",
	complete: "Complete",
	completed: "Complete",
	reached: "Complete",
	done: "Complete",
	rejected: "Rejected",
	discard: "Discard",
	discarded: "Discard",
	abandoned: "Discard",
	obsolete: "Discard",
	replaced: "Replaced",
};

export const STATUS_DISPLAY: Record<CanonicalStatus, string> = {
	Draft: "Draft",
	Review: "Review",
	Develop: "Develop",
	Merge: "Merge",
	Complete: "Complete",
	Rejected: "Rejected",
	Discard: "Discard",
	Replaced: "Replaced",
};

export const STATUS_EMOJI: Record<CanonicalStatus, string> = {
	Draft: "⚪",
	Review: "🟡",
	Develop: "🔵",
	Merge: "🧩",
	Complete: "✅",
	Rejected: "✖",
	Discard: "🗑",
	Replaced: "⇄",
};

/**
 * AgentHive remains proposal-centric. Keep this identity mapping so older
 * helpers that expect a terminology table continue to work without forcing a
 * proposal→component rewrite.
 */
export const TERMINOLOGY_MAP: Record<string, string> = {
	proposal: "proposal",
	Proposal: "Proposal",
	proposals: "proposals",
	Proposals: "Proposals",
};

export const TUI_LABELS = {
	boardTitle: "Proposal Board",
	overviewTitle: "Proposal Overview",
	backlog: "Draft",
	inProgress: "Develop",
	inReview: "Review",
	complete: "Complete",
	discard: "Discard",
	proposalCount: (n: number) => `${n} proposal${n !== 1 ? "s" : ""}`,
	noProposals: "No proposals found",
	claimProposal: "Claim Proposal",
	startWork: "Start Work",
	submitReview: "Submit for Review",
	markComplete: "Mark Complete",
};

export const CLI_MESSAGES = {
	proposalCreated: (id: string) => `${formatProposalId(id)} created`,
	proposalUpdated: (id: string) => `${formatProposalId(id)} updated`,
	proposalClaimed: (id: string) => `${formatProposalId(id)} claimed by`,
	proposalArchived: (id: string) => `${formatProposalId(id)} archived`,
	listHeader: (count: number) => `Proposals (${count})`,
	noProposals: "No proposals found",
	statusLabel: (status: CanonicalStatus) =>
		`${STATUS_EMOJI[status]} ${STATUS_DISPLAY[status]}`,
};

export const MCP_LABELS = {
	proposalList: "proposal_list",
	proposalCreate: "proposal_create",
	proposalEdit: "proposal_edit",
	proposalView: "proposal_view",
	proposalClaim: "proposal_claim",
};

export function normalizeStatus(status: string): CanonicalStatus {
	const normalized = status.toLowerCase().trim();
	return STATUS_MAP[normalized] || "Draft";
}

export function isCompleteStatus(status: string): boolean {
	return normalizeStatus(status) === "Complete";
}

export function isActiveStatus(status: string): boolean {
	return normalizeStatus(status) === "Develop";
}

export function isReviewStatus(status: string): boolean {
	return normalizeStatus(status) === "Review";
}

export function isNewStatus(status: string): boolean {
	return normalizeStatus(status) === "Draft";
}

export function formatStatus(status: string): string {
	const canonical = normalizeStatus(status);
	return `${STATUS_EMOJI[canonical]} ${STATUS_DISPLAY[canonical]}`;
}

export function formatProposalId(id: string): string {
	return id.replace(/^proposal-(\d+(?:\.\d+)?)/i, "Proposal $1");
}

export function formatComponentId(id: string): string {
	return formatProposalId(id);
}

export function formatProposalRef(id: string, title: string): string {
	return `${formatProposalId(id)}: ${title}`;
}

export function formatComponentRef(id: string, title: string): string {
	return formatProposalRef(id, title);
}

export function applyTerminology(text: string): string {
	return text;
}

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

			if (typeof value === "string" && key === "status") {
				value = normalizeStatus(value);
			}

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

export function migrateProposalFile(filePath: string): {
	original: string;
	migrated: string;
	changes: string[];
} {
	const content = readFileSync(filePath, "utf-8");
	const changes: string[] = [];
	let migrated = content;

	const replacements: Array<[RegExp, string, string]> = [
		[/status:\s*Reached/gi, "status: Complete", "Legacy status: Reached → Complete"],
		[/status:\s*Building/gi, "status: Develop", "Legacy status: Building → Develop"],
		[/status:\s*Accepted/gi, "status: Merge", "Legacy status: Accepted → Merge"],
		[/status:\s*Abandoned/gi, "status: Discard", "Legacy status: Abandoned → Discard"],
	];

	for (const [pattern, replacement, label] of replacements) {
		if (pattern.test(migrated)) {
			migrated = migrated.replace(pattern, replacement);
			changes.push(label);
		}
	}

	return {
		original: content,
		migrated,
		changes,
	};
}

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

export function generateMigrationGuide(): string {
	return `# Migration Guide: AgentHive Proposal Workflow

## Canonical Stages

| Legacy Status | Canonical Stage |
|---------------|-----------------|
| New / Potential | Draft |
| Building / Active | Develop |
| Accepted | Merge |
| Reached | Complete |
| Abandoned / Obsolete | Discard |

## Notes

- AgentHive remains proposal-centric. Do not rewrite proposal language to "component".
- Proposal type determines which workflow template applies.
- The default RFC-style workflow is Draft -> Review -> Develop -> Merge -> Complete.
`;
}
