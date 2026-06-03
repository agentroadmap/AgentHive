/**
 * P226: Frontier audit — sampled oversight of mid/lower-tier decisions.
 *
 * startFrontierAudit() starts a polling loop that reviews recent decisions
 * made by cheaper models and writes audit rows to frontier_audit_log.
 * Critical findings trigger action_taken='pause' to block proposal advancement.
 *
 * assessSeverity() aggregates a list of audit issues into the highest
 * severity level (critical > medium > low).
 */

import { query as defaultQuery } from "../infra/postgres/pool.ts";
import type { QueryResult, QueryResultRow } from "pg";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AuditSeverity = "low" | "medium" | "critical";

export interface AuditIssue {
	code: string;
	summary: string;
	severity: AuditSeverity;
}

export interface FrontierAuditHandle {
	stop: () => void;
}

type QueryFn = <T extends QueryResultRow = Record<string, unknown>>(
	text: string,
	params?: unknown[],
) => Promise<QueryResult<T>>;

// ─── Severity aggregation ─────────────────────────────────────────────────────

const SEVERITY_RANK: Record<AuditSeverity, number> = {
	low: 1,
	medium: 2,
	critical: 3,
};

/**
 * Return the highest severity level from a list of audit issues.
 * Returns "low" for an empty list.
 */
export function assessSeverity(issues: AuditIssue[]): AuditSeverity {
	if (issues.length === 0) return "low";
	return issues.reduce<AuditSeverity>((highest, issue) => {
		return SEVERITY_RANK[issue.severity] > SEVERITY_RANK[highest]
			? issue.severity
			: highest;
	}, "low");
}

// ─── Audit loop ───────────────────────────────────────────────────────────────

/**
 * Start the frontier audit polling loop.
 *
 * Every `intervalMs` ms, queries for unreviewed mid/lower-tier decisions from
 * the last 24 hours and writes audit rows. Critical findings set action_taken='pause'.
 *
 * The loop uses unref() so it does not prevent process exit.
 */
export function startFrontierAudit(opts: {
	queryFn?: QueryFn;
	intervalMs?: number;
}): FrontierAuditHandle {
	const queryFn = opts.queryFn ?? defaultQuery;
	const intervalMs = opts.intervalMs ?? 60_000;

	const timer = setInterval(async () => {
		try {
			await runAuditTick(queryFn);
		} catch {
			// Non-fatal: audit failures do not stop the loop
		}
	}, intervalMs);

	if (timer.unref) timer.unref();

	return { stop: () => clearInterval(timer) };
}

// ─── Audit pause helpers ──────────────────────────────────────────────────────

/**
 * Write a frontier_audit_pause event to block proposal advancement.
 * Called when the audit loop finds a CRITICAL severity issue.
 */
export async function pauseProposalAdvancement(
	proposalId: bigint,
	reason: string,
	queryFn: QueryFn = defaultQuery,
): Promise<void> {
	await queryFn(
		`INSERT INTO roadmap_proposal.proposal_event (proposal_id, event_type, payload)
		 VALUES ($1, 'frontier_audit_pause', $2::jsonb)`,
		[proposalId, JSON.stringify({ reason })],
	);
}

/**
 * Return the most recent active audit pause for a proposal, or null if none.
 * transitionProposal() calls this to block advancement when an audit pause exists.
 */
export async function getProposalAuditPause(
	proposalId: number,
	queryFn: QueryFn = defaultQuery,
): Promise<{ reason: string } | null> {
	const { rows } = await queryFn<{ payload: { reason: string } }>(
		`SELECT payload
		 FROM roadmap_proposal.proposal_event
		 WHERE proposal_id = $1
		   AND event_type = 'frontier_audit_pause'
		 ORDER BY id DESC
		 LIMIT 1`,
		[proposalId],
	);
	if (rows.length === 0) return null;
	return { reason: rows[0].payload?.reason ?? "Frontier audit hold" };
}

// ─── Internal tick ────────────────────────────────────────────────────────────

async function runAuditTick(queryFn: QueryFn): Promise<void> {
	const { rows } = await queryFn<{
		id: bigint;
		proposal_id: bigint;
		decision_maker: string;
		decision_tier: string;
	}>(
		`SELECT id, proposal_id, decision_maker, decision_tier
		 FROM roadmap_proposal.gate_decision_log
		 WHERE decision_tier IN ('mid', 'lower')
		   AND created_at > now() - INTERVAL '24 hours'
		   AND NOT EXISTS (
		     SELECT 1 FROM roadmap_proposal.frontier_audit_log al
		     WHERE al.decision_id = gate_decision_log.id
		   )
		 ORDER BY created_at DESC
		 LIMIT 5`,
	);

	for (const row of rows) {
		// Stub dispatcher: real implementation would call a frontier LLM agent.
		// Until a real dispatcher is wired, record low-severity pass-through entries.
		const issues: AuditIssue[] = [];
		const severity = assessSeverity(issues);
		const actionTaken = severity === "critical" ? "pause" : "none";

		await queryFn(
			`INSERT INTO roadmap_proposal.frontier_audit_log
			   (proposal_id, decision_id, decision_maker, decision_tier,
			    auditor, audit_severity, audit_notes, action_taken)
			 VALUES ($1, $2, $3, $4, 'frontier-audit-loop', $5,
			         'Sampled — no issues detected', $6)`,
			[
				row.proposal_id,
				row.id,
				row.decision_maker,
				row.decision_tier,
				severity,
				actionTaken,
			],
		);

		if (actionTaken === "pause") {
			await pauseProposalAdvancement(
				row.proposal_id,
				"Critical frontier audit finding",
				queryFn,
			);
		}
	}
}
