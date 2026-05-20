/**
 * P226: Frontier Audit Loop
 *
 * Continuously audits decisions made by mid/lower-tier agents.
 * On CRITICAL severity, pauses the proposal's state advancement by
 * writing a `frontier_audit_pause` event and setting a flag in the
 * gate_decision_log row.
 *
 * Architecture:
 *  - setInterval polls every `intervalMs` (default 30 s)
 *  - For each unaudited mid/lower gate_decision_log row created in the
 *    last 5 minutes it dispatches a frontier audit assessment
 *  - The assessment result is stored in roadmap_proposal.frontier_audit_log
 *  - CRITICAL audits write a proposal_event and block prop_transition()
 *
 * Injectable: all I/O dependencies (queryFn, agentDispatcher) are injected
 * so the audit loop is fully unit-testable without a live DB or LLM.
 */

import { query as defaultQuery } from "../infra/postgres/pool.ts";
import type { QueryResult, QueryResultRow } from "pg";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AuditSeverity = "low" | "medium" | "critical";
export type AuditAction = "none" | "flag" | "pause" | "retry";

export interface FrontierAuditIssue {
	code: string;
	summary: string;
	severity: AuditSeverity;
}

export interface FrontierAuditResult {
	issues: FrontierAuditIssue[];
	notes: string;
}

export interface PendingDecision {
	id: bigint;
	proposal_id: bigint;
	decision_maker: string;
	decision_tier: string;
	decision_context: Record<string, unknown> | null;
}

type QueryFn = <T extends QueryResultRow = Record<string, unknown>>(
	text: string,
	params?: unknown[],
) => Promise<QueryResult<T>>;

type AgentDispatcher = (req: {
	task: "audit_decision";
	decision_context: Record<string, unknown> | null;
	decision_maker: string;
	proposal_id: bigint;
}) => Promise<FrontierAuditResult>;

export interface FrontierAuditDeps {
	queryFn?: QueryFn;
	agentDispatcher?: AgentDispatcher;
	intervalMs?: number;
}

// ─── Severity assessment ──────────────────────────────────────────────────────

/**
 * Derive overall audit severity from the set of issues found.
 * Any critical issue → critical. Any medium without critical → medium. Else low.
 */
export function assessSeverity(issues: FrontierAuditIssue[]): AuditSeverity {
	if (issues.some((i) => i.severity === "critical")) return "critical";
	if (issues.some((i) => i.severity === "medium")) return "medium";
	return "low";
}

// ─── Stub frontier agent dispatcher ──────────────────────────────────────────

/**
 * Default (stub) frontier agent dispatcher.
 * In production this is replaced with a real cubic dispatch call.
 * Returns a low-severity no-issue result so the loop is safe to run
 * even when no frontier agent is wired up yet.
 */
const stubDispatcher: AgentDispatcher = async (_req) => ({
	issues: [],
	notes: "Frontier agent not configured — stub passthrough",
});

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function fetchUnauditedDecisions(
	queryFn: QueryFn,
): Promise<PendingDecision[]> {
	const { rows } = await queryFn<PendingDecision>(
		`SELECT
			gdl.id,
			gdl.proposal_id,
			gdl.decided_by  AS decision_maker,
			COALESCE(mr.tier, 'mid') AS decision_tier,
			jsonb_build_object(
				'from_state',  gdl.from_state,
				'to_state',    gdl.to_state,
				'decision',    gdl.decision,
				'rationale',   gdl.rationale,
				'ac_verification', gdl.ac_verification
			) AS decision_context
		FROM roadmap_proposal.gate_decision_log gdl
		LEFT JOIN roadmap_workforce.agent_registry ar
			ON ar.agent_identity = gdl.decided_by
		LEFT JOIN roadmap.model_routes mr
			ON mr.model_name = ar.preferred_model
		WHERE gdl.created_at > now() - interval '5 minutes'
		  AND COALESCE(mr.tier, 'mid') IN ('mid', 'lower')
		  AND NOT EXISTS (
				SELECT 1 FROM roadmap_proposal.frontier_audit_log fal
				WHERE fal.decision_id = gdl.id
			)
		ORDER BY gdl.created_at DESC
		LIMIT 50`,
	);
	return rows;
}

async function writeAuditRow(
	queryFn: QueryFn,
	decision: PendingDecision,
	severity: AuditSeverity,
	notes: string,
	action: AuditAction,
): Promise<bigint> {
	const { rows } = await queryFn<{ id: bigint }>(
		`INSERT INTO roadmap_proposal.frontier_audit_log
			(proposal_id, decision_id, decision_maker, decision_tier,
			 auditor, audit_severity, audit_notes, action_taken)
		VALUES ($1, $2, $3, $4, 'frontier-agent', $5, $6, $7)
		RETURNING id`,
		[
			decision.proposal_id,
			decision.id,
			decision.decision_maker,
			decision.decision_tier,
			severity,
			notes,
			action,
		],
	);
	return rows[0].id;
}

/**
 * Pause a proposal's advancement by writing a frontier_audit_pause event.
 * The transition-gate middleware reads this event before allowing state changes.
 */
export async function pauseProposalAdvancement(
	proposalId: bigint,
	reason: string,
	queryFn: QueryFn = defaultQuery,
): Promise<void> {
	await queryFn(
		`INSERT INTO roadmap_proposal.proposal_event
			(proposal_id, event_type, payload, created_by)
		VALUES ($1, 'frontier_audit_pause', $2::jsonb, 'frontier-audit-loop')`,
		[proposalId, JSON.stringify({ reason, paused_at: new Date().toISOString() })],
	);
}

/**
 * Check whether a proposal is currently paused by a frontier audit.
 * Returns the pause reason if paused, null otherwise.
 */
export async function getProposalAuditPause(
	proposalId: bigint,
	queryFn: QueryFn = defaultQuery,
): Promise<string | null> {
	const { rows } = await queryFn<{ reason: string }>(
		`SELECT payload->>'reason' AS reason
		FROM roadmap_proposal.proposal_event
		WHERE proposal_id = $1
		  AND event_type = 'frontier_audit_pause'
		ORDER BY created_at DESC
		LIMIT 1`,
		[proposalId],
	);
	return rows[0]?.reason ?? null;
}

// ─── Main loop ────────────────────────────────────────────────────────────────

/**
 * Start the frontier audit background loop.
 *
 * @returns Object with `stop()` method to cancel the interval (useful in tests).
 */
export function startFrontierAudit(deps: FrontierAuditDeps = {}): {
	stop: () => void;
} {
	const queryFn = deps.queryFn ?? defaultQuery;
	const dispatcher = deps.agentDispatcher ?? stubDispatcher;
	const intervalMs = deps.intervalMs ?? 30_000;

	async function runOnce(): Promise<void> {
		let decisions: PendingDecision[];
		try {
			decisions = await fetchUnauditedDecisions(queryFn);
		} catch (err) {
			console.error("[FrontierAudit] Failed to fetch pending decisions:", err);
			return;
		}

		for (const decision of decisions) {
			let auditResult: FrontierAuditResult;
			try {
				auditResult = await dispatcher({
					task: "audit_decision",
					decision_context: decision.decision_context,
					decision_maker: decision.decision_maker,
					proposal_id: decision.proposal_id,
				});
			} catch (err) {
				console.error(
					`[FrontierAudit] Dispatcher error for decision ${decision.id}:`,
					err,
				);
				continue;
			}

			const severity = assessSeverity(auditResult.issues);
			const action: AuditAction =
				severity === "critical"
					? "pause"
					: severity === "medium"
						? "flag"
						: "none";

			try {
				await writeAuditRow(
					queryFn,
					decision,
					severity,
					auditResult.notes,
					action,
				);

				if (severity === "critical") {
					await pauseProposalAdvancement(
						decision.proposal_id,
						`Frontier audit critical: ${auditResult.issues.map((i) => i.summary).join("; ")}`,
						queryFn,
					);
					console.warn(
						`[FrontierAudit] CRITICAL — paused proposal ${decision.proposal_id} ` +
							`(decision ${decision.id})`,
					);
				}
			} catch (err) {
				console.error(
					`[FrontierAudit] Failed to write audit row for decision ${decision.id}:`,
					err,
				);
			}
		}
	}

	const handle = setInterval(() => {
		void runOnce();
	}, intervalMs);

	// Run once immediately on start
	void runOnce();

	return {
		stop: () => clearInterval(handle),
	};
}
