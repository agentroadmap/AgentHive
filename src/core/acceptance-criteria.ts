import type { AcceptanceCriterion, Proposal } from "../types/index.ts";

export interface AcceptanceCriteriaDeps {
	loadProposal(id: string): Promise<Proposal | null>;
	updateProposal(proposal: Proposal, autoCommit?: boolean): Promise<void>;
}

export async function addAcceptanceCriteria(
	deps: AcceptanceCriteriaDeps,
	proposalId: string,
	criteria: string[],
	autoCommit?: boolean,
): Promise<void> {
	const proposal = await deps.loadProposal(proposalId);
	if (!proposal) {
		throw new Error(`Proposal not found: ${proposalId}`);
	}

	const current = Array.isArray(proposal.acceptanceCriteriaItems)
		? [...proposal.acceptanceCriteriaItems]
		: [];

	let nextIndex =
		current.length > 0 ? Math.max(...current.map((c) => c.index)) + 1 : 1;

	const newCriteria = criteria.map((text) => ({
		index: nextIndex++,
		text,
		checked: false,
	}));
	proposal.acceptanceCriteriaItems = [...current, ...newCriteria];

	await deps.updateProposal(proposal, autoCommit);
}

export async function removeAcceptanceCriteria(
	deps: AcceptanceCriteriaDeps,
	proposalId: string,
	indices: number[],
	autoCommit?: boolean,
): Promise<number[]> {
	const proposal = await deps.loadProposal(proposalId);
	if (!proposal) {
		throw new Error(`Proposal not found: ${proposalId}`);
	}

	let list = Array.isArray(proposal.acceptanceCriteriaItems)
		? [...proposal.acceptanceCriteriaItems]
		: [];
	const removed: number[] = [];

	const sortedIndices = [...indices].sort((a, b) => b - a);

	for (const idx of sortedIndices) {
		const before = list.length;
		list = list.filter((c) => c.index !== idx);
		if (list.length < before) {
			removed.push(idx);
		}
	}

	if (removed.length === 0) {
		throw new Error(
			"No criteria were removed. Check that the specified indices exist.",
		);
	}

	list = list.map((c, i) => ({ ...c, index: i + 1 }));
	proposal.acceptanceCriteriaItems = list;

	await deps.updateProposal(proposal, autoCommit);

	return removed.sort((a, b) => a - b);
}

export async function checkAcceptanceCriteria(
	deps: AcceptanceCriteriaDeps,
	proposalId: string,
	indices: number[],
	checked: boolean,
	autoCommit?: boolean,
): Promise<number[]> {
	const proposal = await deps.loadProposal(proposalId);
	if (!proposal) {
		throw new Error(`Proposal not found: ${proposalId}`);
	}

	let list = Array.isArray(proposal.acceptanceCriteriaItems)
		? [...proposal.acceptanceCriteriaItems]
		: [];
	const updated: number[] = [];

	for (const idx of indices) {
		if (list.some((c) => c.index === idx)) {
			list = list.map((c) => {
				if (c.index === idx) {
					updated.push(idx);
					return { ...c, checked };
				}
				return c;
			});
		}
	}

	if (updated.length === 0) {
		throw new Error("No criteria were updated.");
	}

	proposal.acceptanceCriteriaItems = list;

	await deps.updateProposal(proposal, autoCommit);

	return updated.sort((a, b) => a - b);
}

export async function listAcceptanceCriteria(
	deps: AcceptanceCriteriaDeps,
	proposalId: string,
): Promise<AcceptanceCriterion[]> {
	const proposal = await deps.loadProposal(proposalId);
	if (!proposal) {
		throw new Error(`Proposal not found: ${proposalId}`);
	}

	return proposal.acceptanceCriteriaItems || [];
}
