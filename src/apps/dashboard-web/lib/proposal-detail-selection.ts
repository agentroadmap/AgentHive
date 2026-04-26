import type { Proposal } from "../../../shared/types";

export type ProposalWithSelectionAliases = Proposal & {
	selectionAliases?: string[];
	displayId?: string;
	websocketId?: string;
};

function normalizeSelectionAliases(...values: Array<unknown>): string[] {
	const aliases = new Set<string>();
	for (const value of values) {
		if (typeof value !== "string") continue;
		const normalized = value.trim();
		if (!normalized) continue;
		aliases.add(normalized);
	}
	return [...aliases];
}

export function buildProposalSelectionAliases(
	...values: Array<unknown>
): string[] {
	return normalizeSelectionAliases(...values);
}

export function getProposalSelectionAliases(
	proposal: Proposal | ProposalWithSelectionAliases | null | undefined,
): string[] {
	if (!proposal) return [];
	const withAliases = proposal as ProposalWithSelectionAliases;
	return normalizeSelectionAliases(
		proposal.id,
		withAliases.displayId,
		withAliases.websocketId,
		...(withAliases.selectionAliases ?? []),
	);
}

export function proposalMatchesSelection(
	proposal: Proposal | ProposalWithSelectionAliases,
	selected: Proposal | ProposalWithSelectionAliases,
): boolean {
	const proposalAliases = new Set(getProposalSelectionAliases(proposal));
	return getProposalSelectionAliases(selected).some((alias) =>
		proposalAliases.has(alias),
	);
}

function preferNonEmptyString(
	nextValue: string | undefined,
	currentValue: string | undefined,
): string | undefined {
	return nextValue && nextValue.trim().length > 0 ? nextValue : currentValue;
}

function preferNonEmptyArray<T>(
	nextValue: T[] | undefined,
	currentValue: T[] | undefined,
): T[] | undefined {
	return Array.isArray(nextValue) && nextValue.length > 0 ? nextValue : currentValue;
}

export function mergeProposalDetailState(
	current: ProposalWithSelectionAliases,
	next: ProposalWithSelectionAliases,
): ProposalWithSelectionAliases {
	return {
		...current,
		...next,
		summary: preferNonEmptyString(next.summary, current.summary),
		motivation: preferNonEmptyString(next.motivation, current.motivation),
		design: preferNonEmptyString(next.design, current.design),
		drawbacks: preferNonEmptyString(next.drawbacks, current.drawbacks),
		alternatives: preferNonEmptyString(next.alternatives, current.alternatives),
		dependency_note: preferNonEmptyString(
			next.dependency_note,
			current.dependency_note,
		),
		description: preferNonEmptyString(next.description, current.description),
		implementationPlan: preferNonEmptyString(
			next.implementationPlan,
			current.implementationPlan,
		),
		implementationNotes: preferNonEmptyString(
			next.implementationNotes,
			current.implementationNotes,
		),
		finalSummary: preferNonEmptyString(next.finalSummary, current.finalSummary),
		labels: preferNonEmptyArray(next.labels, current.labels) ?? [],
		dependencies:
			preferNonEmptyArray(next.dependencies, current.dependencies) ?? [],
		references: preferNonEmptyArray(next.references, current.references),
		documentation: preferNonEmptyArray(next.documentation, current.documentation),
		required_capabilities: preferNonEmptyArray(
			next.required_capabilities,
			current.required_capabilities,
		),
		needs_capabilities: preferNonEmptyArray(
			next.needs_capabilities,
			current.needs_capabilities,
		),
		acceptanceCriteriaItems: preferNonEmptyArray(
			next.acceptanceCriteriaItems,
			current.acceptanceCriteriaItems,
		),
		selectionAliases: normalizeSelectionAliases(
			...getProposalSelectionAliases(current),
			...getProposalSelectionAliases(next),
		),
	};
}
