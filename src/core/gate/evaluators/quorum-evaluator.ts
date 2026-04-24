/**
 * Quorum Evaluator — Gate evaluation via reviewer approval quorum.
 *
 * Counts distinct approvals from proposal_reviews and checks against
 * a configurable quorum size. Supports role filtering and abstention.
 *
 * @module core/gate/evaluators/quorum-evaluator
 */

export type {
	GateDecision,
	GateEvaluator,
	GateEvaluatorConfig,
	GateBrief,
	ProposalBrief,
	GateVerdict,
} from "../evaluator.ts";

// Re-export factory — quorum evaluator is created via createGateEvaluator({ mode: 'quorum' })
export { createGateEvaluator } from "../evaluator.ts";
