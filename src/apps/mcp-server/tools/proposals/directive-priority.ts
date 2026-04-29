/**
 * P188: Directive proposal dispatch priority
 * Directives carry a 1.5× priority multiplier to surface them above ordinary proposals.
 */

export const DIRECTIVE_PRIORITY_MULTIPLIER = 1.5;

/**
 * Returns the adjusted dispatch priority for a directive proposal.
 * @param basePriority  Numeric priority (e.g. 1–100); defaults to 50 when null.
 */
export function calculateDispatchPriority(basePriority: number | null): number {
	const base = basePriority ?? 50;
	return Math.round(base * DIRECTIVE_PRIORITY_MULTIPLIER);
}
