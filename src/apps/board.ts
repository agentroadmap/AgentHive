import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Directive, Proposal } from "../types/index.ts";
import { getMaturityIcon, getStatusStyle } from "../ui/status-icon.ts";

export interface BoardOptions {
	statuses?: string[];
}

export type BoardLayout = "horizontal" | "vertical";
export type BoardFormat = "terminal" | "markdown";

export function buildKanbanStatusGroups(
	proposals: Proposal[],
	statuses: string[],
): { orderedStatuses: string[]; groupedProposals: Map<string, Proposal[]> } {
	const canonicalByLower = new Map<string, string>();
	const orderedConfiguredStatuses: string[] = [];
	const configuredSeen = new Set<string>();

	for (const status of statuses ?? []) {
		if (typeof status !== "string") continue;
		const trimmed = status.trim();
		if (!trimmed) continue;
		const lower = trimmed.toLowerCase();
		if (!canonicalByLower.has(lower)) {
			canonicalByLower.set(lower, trimmed);
		}
		if (!configuredSeen.has(trimmed)) {
			orderedConfiguredStatuses.push(trimmed);
			configuredSeen.add(trimmed);
		}
	}

	const groupedProposals = new Map<string, Proposal[]>();
	for (const status of orderedConfiguredStatuses) {
		groupedProposals.set(status, []);
	}

	for (const proposal of proposals) {
		const raw = (proposal.status ?? "").trim();
		if (!raw) continue;
		const canonical = canonicalByLower.get(raw.toLowerCase()) ?? raw;
		if (!groupedProposals.has(canonical)) {
			groupedProposals.set(canonical, []);
		}
		groupedProposals.get(canonical)?.push(proposal);
	}

	const orderedStatuses: string[] = [];
	const seen = new Set<string>();

	for (const status of orderedConfiguredStatuses) {
		if (seen.has(status)) continue;
		orderedStatuses.push(status);
		seen.add(status);
	}

	for (const status of groupedProposals.keys()) {
		if (seen.has(status)) continue;
		orderedStatuses.push(status);
		seen.add(status);
	}

	return { orderedStatuses, groupedProposals };
}

export function generateKanbanBoardWithMetadata(
	proposals: Proposal[],
	statuses: string[],
	projectName: string,
): string {
	// Generate timestamp
	const now = new Date();
	const timestamp = now.toISOString().replace("T", " ").substring(0, 19);

	const { orderedStatuses: allStatuses, groupedProposals } =
		buildKanbanStatusGroups(proposals, statuses);

	// Hide archive statuses by default in the export
	const archiveStatuses = ["rejected", "abandoned", "replaced"];
	const orderedStatuses = allStatuses.filter(
		(s) => !archiveStatuses.includes(s.toLowerCase()),
	);

	// Create header
	const header = `# Kanban Board Export (powered by Roadmap.md)
Generated on: ${timestamp}
Project: ${projectName}

`;

	// Return early if there are no configured statuses and no proposals
	if (orderedStatuses.length === 0) {
		return `${header}No proposals found.`;
	}

	// Create table header
	const headerRow = `| ${orderedStatuses.map((status) => status || "No Status").join(" | ")} |`;
	const separatorRow = `| ${orderedStatuses.map(() => "---").join(" | ")} |`;

	// Map for quick lookup by id
	const byId = new Map<string, Proposal>(proposals.map((t) => [t.id, t]));

	// Group proposals by status and handle parent-child relationships
	const columns: Proposal[][] = orderedStatuses.map((status) => {
		const items = groupedProposals.get(status) || [];
		const top: Proposal[] = [];
		const children = new Map<string, Proposal[]>();

		// Sort items: All columns by updatedDate descending (fallback to createdDate), then by ID as secondary
		const sortedItems = items.sort((a, b) => {
			// Primary sort: updatedDate (newest first), fallback to createdDate if updatedDate is missing
			const dateA = a.updatedDate
				? new Date(a.updatedDate).getTime()
				: new Date(a.createdDate).getTime();
			const dateB = b.updatedDate
				? new Date(b.updatedDate).getTime()
				: new Date(b.createdDate).getTime();
			if (dateB !== dateA) {
				return dateB - dateA; // Newest first
			}
			// Secondary sort: ID descending when dates are equal
			const idA = Number.parseInt(a.id.replace("proposal-", ""), 10);
			const idB = Number.parseInt(b.id.replace("proposal-", ""), 10);
			return idB - idA; // Highest ID first (newest)
		});

		// Separate top-level proposals from subproposals
		for (const t of sortedItems) {
			const parent = t.parentProposalId
				? byId.get(t.parentProposalId)
				: undefined;
			if (parent && parent.status === t.status) {
				// Subproposal with same status as parent - group under parent
				const list = children.get(parent.id) || [];
				list.push(t);
				children.set(parent.id, list);
			} else {
				// Top-level proposal or subproposal with different status
				top.push(t);
			}
		}

		// Build final list with subproposals nested under parents
		const result: Proposal[] = [];
		for (const t of top) {
			result.push(t);
			const subs = children.get(t.id) || [];
			subs.sort((a, b) => {
				const idA = Number.parseInt(a.id.replace("proposal-", ""), 10);
				const idB = Number.parseInt(b.id.replace("proposal-", ""), 10);
				return idA - idB; // Subproposals in ascending order
			});
			result.push(...subs);
		}

		return result;
	});

	const maxProposals = Math.max(...columns.map((c) => c.length), 0);
	const rows = [headerRow, separatorRow];

	for (let proposalIdx = 0; proposalIdx < maxProposals; proposalIdx++) {
		const row = orderedStatuses.map((_, cIdx) => {
			const proposal = columns[cIdx]?.[proposalIdx];
			if (!proposal || !proposal.id || !proposal.title) return "";

			// Check if this is a subproposal
			const isSubproposal = proposal.parentProposalId;
			const proposalIdPrefix = isSubproposal ? "└─ " : "";
			const proposalIdUpper = proposal.id.toUpperCase();

			// Format assignees in brackets or empty string if none
			// Add @ prefix only if not already present
			const assigneesText =
				proposal.assignee && proposal.assignee.length > 0
					? ` [${proposal.assignee.map((a) => (a.startsWith("@") ? a : `@${a}`)).join(", ")}]`
					: "";

			// Format labels with # prefix and italic or empty string if none
			const labelsText =
				proposal.labels && proposal.labels.length > 0
					? `<br>*${proposal.labels.map((label) => `#${label}`).join(" ")}*`
					: "";

			return `${proposalIdPrefix}**${proposalIdUpper}** - ${proposal.title}${assigneesText}${labelsText}`;
		});
		rows.push(`| ${row.join(" | ")} |`);
	}

	const table = `${rows.join("\n")}`;
	if (maxProposals === 0) {
		return `${header}${table}\n\nNo proposals found.\n`;
	}

	return `${header}${table}\n`;
}

export function generateDirectiveGroupedBoard(
	proposals: Proposal[],
	statuses: string[],
	directiveEntities: Directive[],
	projectName: string,
): string {
	const now = new Date();
	const timestamp = now.toISOString().replace("T", " ").substring(0, 19);

	// Collect canonical directive identifiers from directive files and proposals.
	// Proposal values can be either IDs or titles, so normalize aliases to one key.
	const directiveSeen = new Set<string>();
	const allDirectives: string[] = [];
	const aliasToDirective = new Map<string, string>();
	const directiveLabelsByKey = new Map<string, string>();
	const titleCounts = new Map<string, number>();
	for (const directive of directiveEntities) {
		const titleKey = directive.title.trim().toLowerCase();
		if (!titleKey) continue;
		titleCounts.set(titleKey, (titleCounts.get(titleKey) ?? 0) + 1);
	}

	for (const directive of directiveEntities) {
		const normalizedId = directive.id.trim();
		const normalizedTitle = directive.title.trim();
		const idKey = normalizedId.toLowerCase();
		if (normalizedId && !directiveSeen.has(idKey)) {
			directiveSeen.add(idKey);
			allDirectives.push(normalizedId);
		}

		if (normalizedId) {
			aliasToDirective.set(idKey, normalizedId);
			const idAliasMatch = normalizedId.match(/^m-(\d+)$/i);
			if (idAliasMatch?.[1]) {
				const numericAlias = String(Number.parseInt(idAliasMatch[1], 10));
				aliasToDirective.set(`m-${numericAlias}`, normalizedId);
				if (!aliasToDirective.has(numericAlias)) {
					aliasToDirective.set(numericAlias, normalizedId);
				}
			}
		}
		if (normalizedTitle) {
			const titleKey = normalizedTitle.toLowerCase();
			if (titleCounts.get(titleKey) === 1 && !aliasToDirective.has(titleKey)) {
				aliasToDirective.set(titleKey, normalizedId || normalizedTitle);
			}
			directiveLabelsByKey.set(idKey, normalizedTitle);
			if (
				titleCounts.get(titleKey) === 1 &&
				!directiveLabelsByKey.has(titleKey)
			) {
				directiveLabelsByKey.set(titleKey, normalizedTitle);
			}
		}
	}

	const canonicalizeDirective = (value?: string | null): string => {
		const normalized = value?.trim();
		if (!normalized) return "";
		const direct = aliasToDirective.get(normalized.toLowerCase());
		if (direct) {
			return direct;
		}
		const idMatch = normalized.match(/^m-(\d+)$/i);
		if (idMatch?.[1]) {
			const numericAlias = String(Number.parseInt(idMatch[1], 10));
			return (
				aliasToDirective.get(`m-${numericAlias}`) ??
				aliasToDirective.get(numericAlias) ??
				normalized
			);
		}
		if (/^\d+$/.test(normalized)) {
			const numericAlias = String(Number.parseInt(normalized, 10));
			return (
				aliasToDirective.get(`m-${numericAlias}`) ??
				aliasToDirective.get(numericAlias) ??
				normalized
			);
		}
		return normalized;
	};

	for (const proposal of proposals) {
		const canonicalDirective = canonicalizeDirective(proposal.directive);
		if (
			canonicalDirective &&
			!directiveSeen.has(canonicalDirective.toLowerCase())
		) {
			directiveSeen.add(canonicalDirective.toLowerCase());
			allDirectives.push(canonicalDirective);
		}
	}

	const header = `# Kanban Board by Directive (powered by Roadmap.md)
Generated on: ${timestamp}
Project: ${projectName}

`;

	const sections: string[] = [];

	// No directive section
	const noDirectiveProposals = proposals.filter((t) => !t.directive?.trim());
	if (noDirectiveProposals.length > 0) {
		sections.push(
			generateDirectiveSection("No Directive", noDirectiveProposals, statuses),
		);
	}

	// Each directive section
	for (const directive of allDirectives) {
		const directiveProposals = proposals.filter(
			(proposal) =>
				canonicalizeDirective(proposal.directive).toLowerCase() ===
				directive.toLowerCase(),
		);
		if (directiveProposals.length > 0) {
			const directiveLabel =
				directiveLabelsByKey.get(directive.toLowerCase()) ?? directive;
			sections.push(
				generateDirectiveSection(directiveLabel, directiveProposals, statuses),
			);
		}
	}

	if (sections.length === 0) {
		return `${header}No proposals found.\n`;
	}

	return `${header}${sections.join("\n\n")}\n`;
}

function generateDirectiveSection(
	directive: string,
	proposals: Proposal[],
	statuses: string[],
): string {
	const { orderedStatuses, groupedProposals } = buildKanbanStatusGroups(
		proposals,
		statuses,
	);

	const sectionHeader = `## ${directive} (${proposals.length} proposals)\n`;

	if (orderedStatuses.length === 0) {
		return `${sectionHeader}\nNo proposals.\n`;
	}

	const statusLines = orderedStatuses.map((status) => {
		const statusProposals = groupedProposals.get(status) || [];
		const statusStyle = getStatusStyle(status);
		const statusIcon = statusStyle.icon;

		const proposalLines = statusProposals.map((t) => {
			const id = t.id.toUpperCase();
			const assignees = t.assignee?.length
				? ` [@${t.assignee.join(", @")}]`
				: "";
			const maturity = (t as any).maturity;
			const maturityIcon = getMaturityIcon(maturity);
			return `  - ${maturityIcon}${statusIcon} **${id}** - ${t.title}${assignees}`;
		});
		return `### ${statusIcon} ${status} (${statusProposals.length})\n${proposalLines.length > 0 ? proposalLines.join("\n") : "  (empty)"}`;
	});

	return `${sectionHeader}\n${statusLines.join("\n\n")}`;
}

export async function exportKanbanBoardToFile(
	proposals: Proposal[],
	statuses: string[],
	filePath: string,
	projectName: string,
	_overwrite = false,
): Promise<void> {
	const board = generateKanbanBoardWithMetadata(
		proposals,
		statuses,
		projectName,
	);

	// Ensure directory exists
	try {
		await mkdir(dirname(filePath), { recursive: true });
	} catch {
		// Directory might already exist
	}

	// Write the content (overwrite mode)
	await writeFile(filePath, board);
}
