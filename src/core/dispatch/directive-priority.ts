/**
 * P188: Directive dispatch priority boost.
 * Directives carry a 1.5× multiplier so they are scheduled ahead of
 * equal-priority feature proposals in agent dispatch queues.
 */

const DIRECTIVE_MULTIPLIER = 1.5;

export interface DispatchableProposal {
	type: string;
	priority?: number | string | null;
}

/**
 * Returns the effective dispatch priority for a proposal.
 * Directive proposals receive a 1.5× boost over their base priority.
 * Non-numeric priority strings default to 1.0 before the multiplier.
 */
export function calculateDispatchPriority(proposal: DispatchableProposal): number {
	const base =
		typeof proposal.priority === "number"
			? proposal.priority
			: typeof proposal.priority === "string"
				? parseFloat(proposal.priority) || 1.0
				: 1.0;
	return proposal.type === "directive" ? base * DIRECTIVE_MULTIPLIER : base;
}
