/**
 * P242: Re-evaluation queue MCP handlers
 *
 * Implements reeval_list, reeval_claim, reeval_release, reeval_decide,
 * reeval_projection — the Loop A (stale-DEVELOP) and Loop B
 * (COMPLETE+mature optimization) surfaces.
 */

import { query } from "../../../../postgres/pool.ts";
import type { CallToolResult } from "../../types.ts";

function ok(text: string): CallToolResult {
	return { content: [{ type: "text", text }] };
}

function err(msg: string, e: unknown): CallToolResult {
	return {
		content: [
			{
				type: "text",
				text: `⚠️ ${msg}: ${e instanceof Error ? e.message : String(e)}`,
			},
		],
	};
}

// ────────────────────────────────────────────────────────────────────────────
// reeval_list
// ────────────────────────────────────────────────────────────────────────────
export async function reevalList(args: {
	reeval_type?: string;
	limit?: number;
}): Promise<CallToolResult> {
	try {
		const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
		const { rows } = await query<{
			queue_id: string;
			proposal_id: string;
			display_id: string;
			title: string;
			reeval_type: string;
			staleness_reason: string;
			flagged_at: string;
			reeval_count: number;
			leased_by: string | null;
			lease_expires: string | null;
		}>(
			`
      SELECT
        q.id          AS queue_id,
        p.id          AS proposal_id,
        p.display_id,
        p.title,
        q.reeval_type,
        q.staleness_reason,
        q.flagged_at,
        p.reeval_count,
        l.agent_identity AS leased_by,
        l.expires_at     AS lease_expires
      FROM roadmap_proposal.proposal_reeval_queue q
      JOIN roadmap_proposal.proposal p ON p.id = q.proposal_id
      LEFT JOIN roadmap_proposal.proposal_reeval_lease l
             ON l.reeval_queue_id = q.id
            AND l.released_at IS NULL
            AND l.expires_at > now()
      WHERE q.outcome IS NULL
        AND p.gate_scanner_paused = false
        ${args.reeval_type ? "AND q.reeval_type = $2" : ""}
      ORDER BY q.flagged_at ASC
      LIMIT $1
      `,
			args.reeval_type ? [limit, args.reeval_type] : [limit],
		);

		if (rows.length === 0) return ok("No open reeval items.");
		const lines = rows.map(
			(r) =>
				`[${r.queue_id}] ${r.display_id} "${r.title}" — ${r.reeval_type}/${r.staleness_reason}` +
				(r.leased_by ? ` (leased by ${r.leased_by})` : " (available)"),
		);
		return ok(`Open reeval items (${rows.length}):\n${lines.join("\n")}`);
	} catch (e) {
		return err("reeval_list failed", e);
	}
}

// ────────────────────────────────────────────────────────────────────────────
// reeval_claim — lightweight claim; does NOT change proposal.status/maturity
// ────────────────────────────────────────────────────────────────────────────
export async function reevalClaim(args: {
	queue_id: string | number;
	agent_identity: string;
	expires_minutes?: number;
}): Promise<CallToolResult> {
	try {
		const expiresMinutes = Math.min(Math.max(args.expires_minutes ?? 30, 5), 120);
		const queueId = Number(args.queue_id);

		// Verify queue item is open
		const { rows: qRows } = await query<{ id: string; proposal_id: string }>(
			"SELECT id, proposal_id FROM roadmap_proposal.proposal_reeval_queue WHERE id = $1 AND outcome IS NULL",
			[queueId],
		);
		if (qRows.length === 0) {
			return ok(`❌ Queue item ${queueId} not found or already resolved.`);
		}

		const { rows } = await query<{
			id: string;
			expires_at: string;
		}>(
			`
      INSERT INTO roadmap_proposal.proposal_reeval_lease
             (reeval_queue_id, agent_identity, expires_at)
      VALUES ($1, $2, now() + ($3 || ' minutes')::interval)
      RETURNING id, expires_at
      `,
			[queueId, args.agent_identity, expiresMinutes],
		);

		return ok(
			`✅ Reeval lease ${rows[0].id} claimed by ${args.agent_identity} until ${rows[0].expires_at}.`,
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (msg.includes("unique") || msg.includes("idx_reeval_lease_one_active")) {
			return ok(`❌ Queue item ${args.queue_id} is already leased by another agent.`);
		}
		return err("reeval_claim failed", e);
	}
}

// ────────────────────────────────────────────────────────────────────────────
// reeval_release
// ────────────────────────────────────────────────────────────────────────────
export async function reevalRelease(args: {
	queue_id: string | number;
	agent_identity: string;
}): Promise<CallToolResult> {
	try {
		const { rowCount } = await query(
			`
      UPDATE roadmap_proposal.proposal_reeval_lease
         SET released_at = now()
       WHERE reeval_queue_id = $1
         AND agent_identity  = $2
         AND released_at IS NULL
      `,
			[Number(args.queue_id), args.agent_identity],
		);

		if (!rowCount) {
			return ok(
				`No active lease found for queue ${args.queue_id} / agent ${args.agent_identity}.`,
			);
		}
		return ok(`✅ Reeval lease for queue item ${args.queue_id} released.`);
	} catch (e) {
		return err("reeval_release failed", e);
	}
}

// ────────────────────────────────────────────────────────────────────────────
// reeval_decide — resolves the queue item with an outcome
// ────────────────────────────────────────────────────────────────────────────
export async function reevalDecide(args: {
	queue_id: string | number;
	outcome: string;
	decision_notes: string;
	decided_by: string;
	spawned_proposal_id?: string | number;
	exempt_until?: string;
}): Promise<CallToolResult> {
	const queueId = Number(args.queue_id);
	const validOutcomes = [
		"keep",
		"revise",
		"obsolete",
		"spawn_optimization",
		"spawn_transformation",
	];
	if (!validOutcomes.includes(args.outcome)) {
		return ok(
			`❌ Invalid outcome '${args.outcome}'. Must be one of: ${validOutcomes.join(", ")}.`,
		);
	}

	try {
		// Load queue item + proposal
		const { rows: qRows } = await query<{
			id: string;
			proposal_id: string;
			reeval_type: string;
			outcome: string | null;
		}>(
			`
      SELECT q.id, q.proposal_id, q.reeval_type, q.outcome
      FROM   roadmap_proposal.proposal_reeval_queue q
      WHERE  q.id = $1
      `,
			[queueId],
		);
		if (qRows.length === 0) return ok(`❌ Queue item ${queueId} not found.`);
		if (qRows[0].outcome !== null) {
			return ok(`❌ Queue item ${queueId} already resolved with '${qRows[0].outcome}'.`);
		}

		const { reeval_type, proposal_id } = qRows[0];

		// Reject Loop B outcomes that alter workflow state
		if (reeval_type === "optimization" && (args.outcome === "revise" || args.outcome === "obsolete")) {
			return ok(
				`❌ Outcome '${args.outcome}' is not valid for optimization-type reeval. Use keep, spawn_optimization, or spawn_transformation.`,
			);
		}

		// spawn outcomes require spawned_proposal_id
		if (
			(args.outcome === "spawn_optimization" || args.outcome === "spawn_transformation") &&
			!args.spawned_proposal_id
		) {
			return ok(`❌ spawned_proposal_id is required when outcome is '${args.outcome}'.`);
		}

		// Validate spawned_proposal_id exists
		if (args.spawned_proposal_id) {
			const { rows: spRows } = await query<{ id: string }>(
				"SELECT id FROM roadmap_proposal.proposal WHERE id = $1",
				[Number(args.spawned_proposal_id)],
			);
			if (spRows.length === 0) {
				return ok(
					`❌ spawned_proposal_id ${args.spawned_proposal_id} not found. Create the derivative proposal first.`,
				);
			}
		}

		// Fetch current proposal state
		const { rows: pRows } = await query<{
			status: string;
			maturity: string;
			reeval_count: number;
		}>(
			"SELECT status, maturity, reeval_count FROM roadmap_proposal.proposal WHERE id = $1",
			[Number(proposal_id)],
		);
		if (pRows.length === 0) return ok(`❌ Proposal ${proposal_id} not found.`);
		const { status: pStatus, maturity: pMaturity, reeval_count } = pRows[0];

		// Execute outcome in a single transaction
		await query("BEGIN");
		try {
			// 1. Resolve queue item
			await query(
				`
        UPDATE roadmap_proposal.proposal_reeval_queue
           SET outcome             = $2,
               decided_by          = $3,
               decision_notes      = $4,
               spawned_proposal_id = $5,
               resolved_at         = now()
         WHERE id = $1
        `,
				[
					queueId,
					args.outcome,
					args.decided_by,
					args.decision_notes,
					args.spawned_proposal_id ? Number(args.spawned_proposal_id) : null,
				],
			);

			// 2. Increment reeval_count; refresh modified_at; optionally set exempt_until
			await query(
				`
        UPDATE roadmap_proposal.proposal
           SET reeval_count       = reeval_count + 1,
               modified_at        = now()
               ${args.exempt_until ? ", reeval_exempt_until = $3::timestamptz" : ""}
         WHERE id = $1
        `,
				args.exempt_until
					? [Number(proposal_id), args.decided_by, args.exempt_until]
					: [Number(proposal_id), args.decided_by],
			);

			// 3. Apply workflow state changes (Loop A only)
			if (args.outcome === "revise") {
				await query(
					`UPDATE roadmap_proposal.proposal SET status = 'REVIEW', maturity = 'new', modified_at = now() WHERE id = $1`,
					[Number(proposal_id)],
				);
				await query(
					`INSERT INTO roadmap_proposal.proposal_maturity_transitions
           (proposal_id, from_maturity, to_maturity, transition_reason, transitioned_by, decision_notes)
           VALUES ($1, $2, 'new', 'system', 'system:reeval', $3)`,
					[Number(proposal_id), pMaturity, `reverted-by-reeval: ${args.decision_notes}`],
				);
			} else if (args.outcome === "obsolete") {
				// trg_proposal_maturity_sync resets maturity='new' on any status change,
				// so we must set status first, then update maturity in a separate statement.
				await query(
					`UPDATE roadmap_proposal.proposal SET status = 'COMPLETE', modified_at = now() WHERE id = $1`,
					[Number(proposal_id)],
				);
				await query(
					`UPDATE roadmap_proposal.proposal SET maturity = 'obsolete', modified_at = now() WHERE id = $1`,
					[Number(proposal_id)],
				);
				await query(
					`INSERT INTO roadmap_proposal.proposal_maturity_transitions
           (proposal_id, from_maturity, to_maturity, transition_reason, transitioned_by, decision_notes)
           VALUES ($1, $2, 'obsolete', 'system', 'system:reeval', $3)`,
					[Number(proposal_id), pMaturity, `obsoleted-by-reeval: ${args.decision_notes}`],
				);
			}

			// 4. Release any active lease
			await query(
				`UPDATE roadmap_proposal.proposal_reeval_lease
          SET released_at = now()
          WHERE reeval_queue_id = $1 AND released_at IS NULL`,
				[queueId],
			);

			// 5. Check reeval_count cap — escalate if at limit
			const newCount = reeval_count + 1;
			const maxCount = await query<{ value: string }>(
				"SELECT value FROM roadmap.config WHERE key = 'reeval_max_count'",
				[],
			);
			const cap = maxCount.rows[0] ? parseInt(maxCount.rows[0].value, 10) : 3;
			if (newCount >= cap) {
				await query(
					`INSERT INTO roadmap.escalation_log
           (obstacle_type, proposal_id, agent_identity, escalated_to, severity)
           VALUES ('LOOP_DETECTED', $1, 'system:reeval', 'operator', 'medium')`,
					[String(proposal_id)],
				);
			}

			await query("COMMIT");
		} catch (e) {
			await query("ROLLBACK");
			throw e;
		}

		return ok(
			`✅ Reeval queue item ${queueId} resolved: outcome='${args.outcome}' for proposal ${proposal_id}` +
				(args.exempt_until ? ` (exempt until ${args.exempt_until})` : "") +
				`.`,
		);
	} catch (e) {
		return err("reeval_decide failed", e);
	}
}

// ────────────────────────────────────────────────────────────────────────────
// reeval_projection — enriched view of a proposal for reeval agents
// ────────────────────────────────────────────────────────────────────────────
export async function reevalProjection(args: {
	proposal_id: string | number;
}): Promise<CallToolResult> {
	try {
		const { rows } = await query<{
			id: string;
			display_id: string;
			title: string;
			status: string;
			maturity: string;
			design: string | null;
			motivation: string | null;
			modified_at: string;
			reeval_count: number;
			reeval_exempt_until: string | null;
			last_reviewed_at: string | null;
			cost_usd_total: string | null;
			token_total: string | null;
			open_defect_count: string;
			related_proposals: unknown;
		}>(
			`
      SELECT
        p.id,
        p.display_id,
        p.title,
        p.status,
        p.maturity,
        p.design,
        p.motivation,
        p.modified_at,
        p.reeval_count,
        p.reeval_exempt_until,
        (SELECT MAX(r.created_at)
         FROM roadmap_proposal.proposal_reviews r
         WHERE r.proposal_id = p.id) AS last_reviewed_at,
        (SELECT SUM(ar.cost_usd)
         FROM roadmap_workforce.agent_runs ar
         WHERE ar.proposal_id = p.id) AS cost_usd_total,
        (SELECT SUM(ar.tokens_in + ar.tokens_out)
         FROM roadmap_workforce.agent_runs ar
         WHERE ar.proposal_id = p.id) AS token_total,
        (SELECT COUNT(*)
         FROM roadmap.escalation_log el
         WHERE el.proposal_id = p.id::text
           AND el.resolved_at IS NULL
           AND el.severity IN ('high', 'critical')) AS open_defect_count,
        (SELECT jsonb_agg(jsonb_build_object(
           'id', d.from_proposal_id, 'type', d.dependency_type, 'resolved', d.resolved))
         FROM roadmap_proposal.proposal_dependencies d
         WHERE d.to_proposal_id = p.id OR d.from_proposal_id = p.id) AS related_proposals
      FROM roadmap_proposal.proposal p
      WHERE p.id = $1
      `,
			[Number(args.proposal_id)],
		);

		if (rows.length === 0) {
			return ok(`❌ Proposal ${args.proposal_id} not found.`);
		}

		const r = rows[0];
		const lines = [
			`## Reeval Projection: ${r.display_id} — "${r.title}"`,
			`Status: ${r.status}  Maturity: ${r.maturity}`,
			`Modified: ${r.modified_at}`,
			`Reeval count: ${r.reeval_count}${r.reeval_exempt_until ? `  Exempt until: ${r.reeval_exempt_until}` : ""}`,
			`Last reviewed: ${r.last_reviewed_at ?? "never"}`,
			`Cost USD total: ${r.cost_usd_total ?? "0"}  Tokens: ${r.token_total ?? "0"}`,
			`Open defects (high/critical): ${r.open_defect_count}`,
			`Related proposals: ${r.related_proposals ? JSON.stringify(r.related_proposals) : "none"}`,
			r.motivation ? `\n### Motivation\n${r.motivation}` : "",
		].filter(Boolean);

		return ok(lines.join("\n"));
	} catch (e) {
		return err("reeval_projection failed", e);
	}
}

// ────────────────────────────────────────────────────────────────────────────
// reeval_budget_check — returns remaining daily budget for reeval agents
// ────────────────────────────────────────────────────────────────────────────
export async function reevalBudgetCheck(_args: unknown): Promise<CallToolResult> {
	try {
		const { rows: budgetRows } = await query<{ value: string }>(
			"SELECT value FROM roadmap.config WHERE key = 'reeval_daily_budget_usd'",
			[],
		);
		const cap = budgetRows[0] ? parseFloat(budgetRows[0].value) : 1.0;

		const { rows: spentRows } = await query<{ spent: string }>(
			`SELECT COALESCE(SUM(cost_usd), 0) AS spent
       FROM roadmap_workforce.agent_runs
       WHERE started_at > now() - interval '24h'
         AND stage = 'reeval'`,
			[],
		);
		const spent = parseFloat(spentRows[0]?.spent ?? "0");
		const remaining = Math.max(0, cap - spent);

		return ok(
			`Reeval daily budget: cap=$${cap.toFixed(2)} spent=$${spent.toFixed(4)} remaining=$${remaining.toFixed(4)}` +
				(remaining <= 0 ? "  ⚠️ Budget exhausted — defer reeval dispatch." : ""),
		);
	} catch (e) {
		return err("reeval_budget_check failed", e);
	}
}

// ────────────────────────────────────────────────────────────────────────────
// reeval_flag_stale — trigger Loop A scan
// ────────────────────────────────────────────────────────────────────────────
export async function reevalFlagStale(_args: unknown): Promise<CallToolResult> {
	try {
		const { rows } = await query<{ fn_flag_stale_proposals: number }>(
			"SELECT roadmap.fn_flag_stale_proposals() AS fn_flag_stale_proposals",
			[],
		);
		return ok(`Loop A scan complete. New flags: ${rows[0].fn_flag_stale_proposals}`);
	} catch (e) {
		return err("reeval_flag_stale failed", e);
	}
}

// ────────────────────────────────────────────────────────────────────────────
// reeval_flag_complete — trigger Loop B scan
// ────────────────────────────────────────────────────────────────────────────
export async function reevalFlagComplete(_args: unknown): Promise<CallToolResult> {
	try {
		const { rows } = await query<{ fn_flag_complete_mature_proposals: number }>(
			"SELECT roadmap.fn_flag_complete_mature_proposals() AS fn_flag_complete_mature_proposals",
			[],
		);
		return ok(`Loop B scan complete. New flags: ${rows[0].fn_flag_complete_mature_proposals}`);
	} catch (e) {
		return err("reeval_flag_complete failed", e);
	}
}
