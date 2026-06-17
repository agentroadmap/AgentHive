/**
 * Acceptance-criteria mutation helpers.
 *
 * Extracted from the `Core` class (P3796 monolith decomposition, Phase 1, AC-10).
 *
 * These functions accept a `CriteriaContext` instead of relying on `this`, so
 * they can be called from `Core` without circular imports with `roadmap.ts`.
 */
import type { AcceptanceCriterion, Proposal } from "../../types/index.ts";

export interface CriteriaContext {
	loadProposal(id: string): Promise<Proposal | null>;
	updateProposal(proposal: Proposal, autoCommit?: boolean): Promise<void>;
}

/** Add acceptance criteria to a proposal. */
export async function addAcceptanceCriteria(
	ctx: CriteriaContext,
	proposalId: string,
	criteria: string[],
	autoCommit?: boolean,
): Promise<void> {
	const proposal = await ctx.loadProposal(proposalId);
	if (!proposal) {
		throw new Error(`Proposal not found: ${proposalId}`);
	}

	// Get existing criteria or initialize empty array
	const current = Array.isArray(proposal.acceptanceCriteriaItems)
		? [...proposal.acceptanceCriteriaItems]
		: [];

	// Calculate next index (1-based)
	let nextIndex =
		current.length > 0 ? Math.max(...current.map((c) => c.index)) + 1 : 1;

	// Append new criteria
	const newCriteria = criteria.map((text) => ({
		index: nextIndex++,
		text,
		checked: false,
	}));
	proposal.acceptanceCriteriaItems = [...current, ...newCriteria];

	// Save the proposal
	await ctx.updateProposal(proposal, autoCommit);
}

/**
 * Remove acceptance criteria by indices (supports batch operations).
 * @returns Array of removed indices
 */
export async function removeAcceptanceCriteria(
	ctx: CriteriaContext,
	proposalId: string,
	indices: number[],
	autoCommit?: boolean,
): Promise<number[]> {
	const proposal = await ctx.loadProposal(proposalId);
	if (!proposal) {
		throw new Error(`Proposal not found: ${proposalId}`);
	}

	let list = Array.isArray(proposal.acceptanceCriteriaItems)
		? [...proposal.acceptanceCriteriaItems]
		: [];
	const removed: number[] = [];

	// Sort indices in descending order to avoid index shifting issues
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

	// Re-index remaining items (1-based)
	list = list.map((c, i) => ({ ...c, index: i + 1 }));
	proposal.acceptanceCriteriaItems = list;

	// Save the proposal
	await ctx.updateProposal(proposal, autoCommit);

	return removed.sort((a, b) => a - b); // Return in ascending order
}

/**
 * Check or uncheck acceptance criteria by indices (supports batch operations).
 * Silently ignores invalid indices and only updates valid ones.
 * @returns Array of updated indices
 */
export async function checkAcceptanceCriteria(
	ctx: CriteriaContext,
	proposalId: string,
	indices: number[],
	checked: boolean,
	autoCommit?: boolean,
): Promise<number[]> {
	const proposal = await ctx.loadProposal(proposalId);
	if (!proposal) {
		throw new Error(`Proposal not found: ${proposalId}`);
	}

	let list = Array.isArray(proposal.acceptanceCriteriaItems)
		? [...proposal.acceptanceCriteriaItems]
		: [];
	const updated: number[] = [];

	// Filter to only valid indices and update them
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

	// Save the proposal
	await ctx.updateProposal(proposal, autoCommit);

	return updated.sort((a, b) => a - b);
}

/** List all acceptance criteria for a proposal. */
export async function listAcceptanceCriteria(
	ctx: CriteriaContext,
	proposalId: string,
): Promise<AcceptanceCriterion[]> {
	const proposal = await ctx.loadProposal(proposalId);
	if (!proposal) {
		throw new Error(`Proposal not found: ${proposalId}`);
	}

	return proposal.acceptanceCriteriaItems || [];
}
