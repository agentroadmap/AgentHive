/**
 * Auto Evaluator — Programmatic gate evaluation without LLM dispatch.
 *
 * Checks AC pass rate and unresolved dependencies to make a deterministic
 * approve/reject decision. No cubic spawn, no token cost.
 *
 * @module core/gate/evaluators/auto-evaluator
 */

export type {
	GateDecision,
	GateEvaluator,
	GateEvaluatorConfig,
	GateBrief,
	ProposalBrief,
	GateVerdict,
} from "../evaluator.ts";

// Re-export factory — auto evaluator is created via createGateEvaluator({ mode: 'auto' })
export { createGateEvaluator } from "../evaluator.ts";
