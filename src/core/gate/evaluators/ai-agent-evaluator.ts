/**
 * AI Agent Evaluator — Gate evaluation via dispatched agent in a cubic.
 *
 * Spawns an agent with a specific role (architect, reviewer, security) to
 * evaluate proposal coherence, feasibility, and AC completeness.
 *
 * @module core/gate/evaluators/ai-agent-evaluator
 */

export type {
	GateDecision,
	GateEvaluator,
	GateEvaluatorConfig,
	GateBrief,
	ProposalBrief,
	GateVerdict,
} from "../evaluator.ts";

// Re-export factory — ai-agent evaluator is created via createGateEvaluator({ mode: 'ai-agent' })
export { createGateEvaluator } from "../evaluator.ts";
