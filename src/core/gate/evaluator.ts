/**
 * Gate Evaluator — Pluggable evaluation system for proposal gates.
 *
 * Supports three modes:
 * - auto: Programmatic AC/dependency check, no LLM dispatch
 * - ai-agent: Dispatch to an AI agent in a cubic for review
 * - quorum: Collect N approvals from eligible reviewers
 *
 * @module core/gate/evaluator
 */

import type { query } from "../../infra/postgres/pool.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export type GateEvaluatorMode = "auto" | "ai-agent" | "quorum";

export type GateVerdict = "approve" | "reject" | "pending";

export interface GateDecision {
	verdict: GateVerdict;
	reason: string;
	metadata?: Record<string, unknown>;
}

export interface GateEvaluatorConfig {
	mode: GateEvaluatorMode;
	// auto mode
	ac_pass_threshold?: number; // 0-100, default 100
	allow_unresolved_deps?: boolean; // default false
	// ai-agent mode
	agent_role?: string; // 'architect', 'reviewer', 'security'
	model?: string; // model name override
	timeout_minutes?: number; // default 30
	// quorum mode
	quorum_size?: number; // min approvals, default 2
	quorum_roles?: string[]; // roles that can approve
	allow_abstain?: boolean; // default false — if true, 'pending' instead of 'reject'
}

export interface ProposalBrief {
	id: number;
	display_id: string;
	title: string;
	status: string;
	workflow_name?: string;
}

export interface GateBrief {
	name: string;
	from_state: string;
	to_state: string;
	requires_ac?: boolean;
}

export interface GateEvaluator {
	evaluate(proposal: ProposalBrief, gate: GateBrief): Promise<GateDecision>;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

type QueryFn = typeof query;

export interface GateEvaluatorFactoryDeps {
	queryFn: QueryFn;
	spawnAgentFn?: (req: {
		worktree: string;
		task: string;
		proposalId: number | string;
		stage: string;
		model?: string;
		timeoutMs?: number;
	}) => Promise<{ exitCode: number; stdout: string }>;
}

/**
 * Create a GateEvaluator for the given config.
 */
export function createGateEvaluator(
	config: GateEvaluatorConfig,
	deps: GateEvaluatorFactoryDeps,
): GateEvaluator {
	switch (config.mode) {
		case "auto":
			// Lazy import to avoid circular
			return new AutoEvaluator(config, deps.queryFn);
		case "ai-agent":
			if (!deps.spawnAgentFn) {
				throw new Error(
					"ai-agent evaluator requires spawnAgentFn in deps",
				);
			}
			return new AIAgentEvaluator(config, deps.spawnAgentFn);
		case "quorum":
			return new QuorumEvaluator(config, deps.queryFn);
		default:
			throw new Error(`Unknown gate evaluator mode: ${config.mode}`);
	}
}

// ─── Auto Evaluator ──────────────────────────────────────────────────────────

class AutoEvaluator implements GateEvaluator {
	constructor(
		private config: GateEvaluatorConfig,
		private queryFn: QueryFn,
	) {}

	async evaluate(
		proposal: ProposalBrief,
		_gate: GateBrief,
	): Promise<GateDecision> {
		const threshold = this.config.ac_pass_threshold ?? 100;

		// Check unresolved dependencies
		if (!this.config.allow_unresolved_deps) {
			const { rows: deps } = await this.queryFn<{ count: number }>(
				`SELECT COUNT(*) as count
				 FROM roadmap_proposal.proposal_dependencies
				 WHERE from_proposal_id = $1 AND resolved = false`,
				[proposal.id],
			);
			const unresolved = Number(deps[0]?.count ?? 0);
			if (unresolved > 0) {
				return {
					verdict: "reject",
					reason: `${unresolved} unresolved dependencies`,
				};
			}
		}

		// Check AC pass rate
		const { rows: acRows } = await this.queryFn<{
			total: string;
			passed: string;
		}>(
			`SELECT COUNT(*) as total,
			        SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) as passed
			 FROM roadmap_proposal.proposal_acceptance_criteria
			 WHERE proposal_id = $1`,
			[proposal.id],
		);

		const total = Number(acRows[0]?.total ?? 0);
		const passed = Number(acRows[0]?.passed ?? 0);

		if (total === 0) {
			return {
				verdict: "reject",
				reason: "No acceptance criteria defined",
			};
		}

		const passRate = (passed / total) * 100;
		if (passRate >= threshold) {
			return {
				verdict: "approve",
				reason: `AC pass rate: ${passed}/${total} (${passRate.toFixed(0)}%)`,
				metadata: { pass_rate: passRate, passed, total },
			};
		}
		return {
			verdict: "reject",
			reason: `AC pass rate: ${passed}/${total} (${passRate.toFixed(0)}%) < ${threshold}%`,
			metadata: { pass_rate: passRate, passed, total, threshold },
		};
	}
}

// ─── AI Agent Evaluator ──────────────────────────────────────────────────────

type SpawnFn = GateEvaluatorFactoryDeps["spawnAgentFn"] extends infer T
	? T extends (...args: any[]) => any
		? T
		: never
	: never;

class AIAgentEvaluator implements GateEvaluator {
	constructor(
		private config: GateEvaluatorConfig,
		private spawnAgentFn: NonNullable<SpawnFn>,
	) {}

	async evaluate(
		proposal: ProposalBrief,
		gate: GateBrief,
	): Promise<GateDecision> {
		const timeoutMs = (this.config.timeout_minutes ?? 30) * 60_000;
		const role = this.config.agent_role ?? "architect";

		const task = [
			`Gate evaluation for ${proposal.display_id}: ${proposal.title}`,
			`Gate: ${gate.name} (${gate.from_state} → ${gate.to_state})`,
			`Evaluate proposal coherence, feasibility, and AC completeness.`,
			`Return verdict as JSON: {"verdict": "approve"|"reject"|"pending", "reason": "..."}`,
		].join("\n");

		const result = await this.spawnAgentFn({
			worktree: `gate-eval-${proposal.id}`,
			task,
			proposalId: proposal.id,
			stage: `gate:${gate.to_state.toUpperCase()}`,
			model: this.config.model,
			timeoutMs,
		});

		// Try to parse verdict from agent output
		try {
			const parsed = JSON.parse(result.stdout.trim());
			if (parsed.verdict && ["approve", "reject", "pending"].includes(parsed.verdict)) {
				return {
					verdict: parsed.verdict as GateVerdict,
					reason: parsed.reason ?? `Agent ${role} evaluation completed`,
					metadata: { agent_role: role, exit_code: result.exitCode },
				};
			}
		} catch {
			// Fall through to default
		}

		// Default: treat exit code 0 as approve, non-zero as reject
		return {
			verdict: result.exitCode === 0 ? "approve" : "reject",
			reason: `Agent ${role} exited with code ${result.exitCode}`,
			metadata: { agent_role: role, exit_code: result.exitCode },
		};
	}
}

// ─── Quorum Evaluator ────────────────────────────────────────────────────────

class QuorumEvaluator implements GateEvaluator {
	constructor(
		private config: GateEvaluatorConfig,
		private queryFn: QueryFn,
	) {}

	async evaluate(
		proposal: ProposalBrief,
		_gate: GateBrief,
	): Promise<GateDecision> {
		const quorumSize = this.config.quorum_size ?? 2;
		const roles = this.config.quorum_roles;

		let queryStr = `SELECT COUNT(DISTINCT reviewer_identity) as count
			FROM roadmap_proposal.proposal_reviews
			WHERE proposal_id = $1 AND verdict = 'approve'`;
		const params: (number | string[])[] = [proposal.id];

		if (roles && roles.length > 0) {
			queryStr += ` AND reviewer_identity IN (SELECT unnest($2::text[]))`;
			params.push(roles);
		}

		const { rows } = await this.queryFn<{ count: string }>(queryStr, params);
		const approvals = Number(rows[0]?.count ?? 0);

		if (approvals >= quorumSize) {
			return {
				verdict: "approve",
				reason: `Quorum met: ${approvals}/${quorumSize} approvals`,
				metadata: { approvals, quorum_size: quorumSize },
			};
		}

		if (this.config.allow_abstain) {
			return {
				verdict: "pending",
				reason: `Quorum pending: ${approvals}/${quorumSize} approvals`,
				metadata: { approvals, quorum_size: quorumSize },
			};
		}

		return {
			verdict: "reject",
			reason: `Quorum not met: ${approvals}/${quorumSize} approvals`,
			metadata: { approvals, quorum_size: quorumSize },
		};
	}
}
