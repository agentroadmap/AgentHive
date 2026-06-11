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

export type GateVerdict =
	| "approve"
	| "reject"
	| "pending"
	| "hold"
	| "abstain"
	| "wontfix"
	| "discard"
	| "replace"
	| "escalate"
	| "nonissue";

/**
 * Structured detail attached to non-transition gate decisions.
 *
 * Operational rule: on `reject` or `pending` verdicts the gate evaluator MUST
 * populate `details` so the enhancing agent can act on the rejection without
 * relying on MCP discussions/messages — those are not guaranteed to reach
 * downstream agents. The `rationale` column in `gate_decision_log` is rendered
 * from this structure (text fallback) and the `ac_verification` JSONB column
 * captures the full structure machine-readably.
 *
 * On `approve` verdicts `details` may be omitted.
 */
export interface GateDecisionDetails {
	/** Required: 1–N concrete things blocking advancement, each actionable. */
	failures?: Array<{
		severity: "critical" | "major" | "minor";
		code?: string;          // machine-readable identifier (e.g., 'AC-1', 'SCHEMA-MISMATCH')
		summary: string;        // one line, human-readable
		evidence?: string;      // file:line reference, query snippet, or pointer to artifact
	}>;
	/** Required if failures non-empty: remediation steps the enhancer should take. */
	remediation?: Array<{
		action: string;
		applies_to_failure_codes?: string[];
	}>;
	/** Optional pointer to a longer write-up (markdown doc, gate-review file). */
	evidence_uri?: string;
	/** Optional per-reviewer breakdown when the decision aggregates multiple voices. */
	reviewer_breakdown?: Array<{
		reviewer_role: string;
		verdict: "approve" | "reject" | "pending" | "abstain";
		headline: string;
	}>;
	/** Optional explicit next-step instruction for the enhancing agent. */
	next_step?: string;
}

export interface GateDecision {
	verdict: GateVerdict;
	reason: string;
	metadata?: Record<string, unknown>;
	/**
	 * Required on `reject` and `pending`. The enhancing agent reads this from
	 * `gate_decision_log.ac_verification.details` to decide what to revise.
	 * MCP discussions/messages are best-effort; this is the canonical channel.
	 */
	details?: GateDecisionDetails;
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

		// P707 null-details guard: reject if any 'pass' AC lacks verification_notes.
		// Phantom passes are ACs marked pass without structured evidence.
		const { rows: phantomRows } = await this.queryFn<{ phantom_count: string }>(
			`SELECT COUNT(*) as phantom_count
			 FROM roadmap_proposal.proposal_acceptance_criteria
			 WHERE proposal_id = $1
			   AND status = 'pass'
			   AND (verification_notes IS NULL OR trim(verification_notes) = '')`,
			[proposal.id],
		);
		const phantomCount = Number(phantomRows[0]?.phantom_count ?? 0);
		if (phantomCount > 0) {
			return {
				verdict: "reject",
				reason: `Phantom pass detected: ${phantomCount} AC(s) passed without verification_notes — fix with verifyAC before gate can approve (P707 §AC-Verification)`,
				metadata: { phantom_count: phantomCount },
			};
		}

		// Check AC pass rate
		const { rows: acRows } = await this.queryFn<{
			total: string;
			passed: string;
			passed_without_evidence: string;
		}>(
			`SELECT COUNT(*) as total,
			        SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) as passed,
			        SUM(CASE WHEN status = 'pass' AND details IS NULL THEN 1 ELSE 0 END) as passed_without_evidence
			 FROM roadmap_proposal.proposal_acceptance_criteria
			 WHERE proposal_id = $1`,
			[proposal.id],
		);

		const total = Number(acRows[0]?.total ?? 0);
		const passed = Number(acRows[0]?.passed ?? 0);
		const passedWithoutEvidence = Number(acRows[0]?.passed_without_evidence ?? 0);

		if (total === 0) {
			return {
				verdict: "reject",
				reason: "No acceptance criteria defined",
			};
		}

		// P707: structural guard — ACs passed without evidence payload are phantom passes
		if (passedWithoutEvidence > 0) {
			return {
				verdict: "reject",
				reason: `${passedWithoutEvidence} AC(s) passed without evidence (details IS NULL) — phantom-pass guard triggered. Re-verify with structured evidence payload.`,
				metadata: { passed_without_evidence: passedWithoutEvidence, passed, total },
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
