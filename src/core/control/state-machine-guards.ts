/**
 * P445 — State Machine Race Guards
 *
 * Production race-condition guards for the control plane. Each function uses
 * PostgreSQL-native concurrency primitives (advisory locks, FOR UPDATE SKIP LOCKED)
 * so concurrent calls are serialized at the DB level without application-side mutexes.
 *
 * All write operations are wrapped in explicit transactions. Lock acquisition is
 * non-blocking (SKIP LOCKED / pg_try_advisory_xact_lock) so no call will hang
 * waiting for another; losers get a typed rejection reason instead.
 */

import { getPool, query } from "../../infra/postgres/pool.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ClaimRejectReason =
	| "lost_race"
	| "dispatch_closed"
	| "agency_suspended"
	| "budget_exhausted"
	| "host_policy_denied"
	| "concurrency_ceiling_exceeded";

export type ClaimOutcome =
	| { won: true; claim_id: string }
	| { won: false; reason: ClaimRejectReason; rejected_claim_id: string };

export type PollOutcome =
	| { dispatch_id: string }
	| { skipped: true; reason: "already_dispatched" | "lock_contention" };

export interface DispatchOpts {
	project_id?: string;
	agency_id?: string;
	worker_id?: string;
	host?: string;
	route?: string;
	model?: string;
	provider?: string;
	agent_cli?: string;
	budget_scope?: string;
}

// ─── pollAndCreateDispatch ────────────────────────────────────────────────────
//
// Uses pg_try_advisory_xact_lock(proposal_id) so exactly one concurrent poller
// creates the dispatch row; all others get skipped=true without waiting.
// The lock is transaction-scoped and automatically released on COMMIT/ROLLBACK.

export async function pollAndCreateDispatch(
	proposalId: number,
	opts: DispatchOpts,
): Promise<PollOutcome> {
	const client = await getPool().connect();
	try {
		await client.query("BEGIN");

		// Non-blocking advisory lock scoped to proposalId.
		// Returns FALSE immediately if another transaction holds it.
		const { rows: lockRows } = await client.query<{ got_lock: boolean }>(
			`SELECT pg_try_advisory_xact_lock($1::bigint) AS got_lock`,
			[proposalId],
		);
		const gotLock = lockRows[0]?.got_lock ?? false;

		if (!gotLock) {
			await client.query("ROLLBACK");
			return { skipped: true, reason: "lock_contention" };
		}

		// Check if a non-terminal dispatch already exists for this proposal.
		const { rows: existing } = await client.query<{ dispatch_id: string }>(
			`SELECT dispatch_id::text
			   FROM roadmap_control.dispatch
			  WHERE proposal_id = $1
			    AND status IN ('pending', 'running')
			  LIMIT 1`,
			[proposalId],
		);

		if (existing.length > 0) {
			await client.query("ROLLBACK");
			return { skipped: true, reason: "already_dispatched" };
		}

		// Create the dispatch row while holding the advisory lock.
		const { rows: created } = await client.query<{ dispatch_id: string }>(
			`INSERT INTO roadmap_control.dispatch
			     (proposal_id, project_id, agency_id, worker_id,
			      host, route, model, provider, agent_cli, budget_scope, status)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
			 RETURNING dispatch_id::text`,
			[
				proposalId,
				opts.project_id ?? null,
				opts.agency_id ?? null,
				opts.worker_id ?? null,
				opts.host ?? null,
				opts.route ?? null,
				opts.model ?? null,
				opts.provider ?? null,
				opts.agent_cli ?? null,
				opts.budget_scope ?? null,
			],
		);

		await client.query("COMMIT");
		return { dispatch_id: created[0]!.dispatch_id };
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
}

// ─── tryClaimDispatch ─────────────────────────────────────────────────────────
//
// Uses SELECT … FOR UPDATE OF d SKIP LOCKED to atomically acquire the dispatch
// row. The agency status is checked via LEFT JOIN in the same locking query so
// a suspended agency blocks claims without a separate round-trip.
//
// The winner inserts an 'active' claim; losers insert a 'released' claim with
// release_reason set to the ClaimRejectReason so the audit trail is complete.

export async function tryClaimDispatch(
	dispatchId: string,
	agentIdentity: string,
	expiresAt: Date,
): Promise<ClaimOutcome> {
	const client = await getPool().connect();
	try {
		await client.query("BEGIN");

		// Attempt to lock the dispatch row (non-blocking). Simultaneously verify:
		//   - dispatch exists and is 'pending'
		//   - agency is not blocked (via LEFT JOIN)
		// Agency is considered blocked when status is not 'active' or 'unknown'
		// (covers paused, throttled, dormant, retired — all non-claimable states).
		const { rows } = await client.query<{
			dispatch_id: string;
			agency_id: string | null;
			agency_status: string | null;
		}>(
			`SELECT d.dispatch_id::text,
			        d.agency_id,
			        a.status AS agency_status
			   FROM roadmap_control.dispatch d
			   LEFT JOIN roadmap.agency a ON a.agency_id = d.agency_id
			  WHERE d.dispatch_id = $1
			    AND d.status = 'pending'
			  FOR UPDATE OF d SKIP LOCKED`,
			[dispatchId],
		);

		const agencyIsBlocked = (status: string | null): boolean =>
			status !== null && status !== "active" && status !== "unknown";

		let rejectReason: ClaimRejectReason | null = null;

		if (rows.length === 0) {
			// Either another transaction holds the lock (lost race) or the dispatch
			// is no longer pending. Determine reason via a non-locking read.
			const { rows: statusRows } = await client.query<{
				status: string;
				agency_status: string | null;
			}>(
				`SELECT d.status,
				        a.status AS agency_status
				   FROM roadmap_control.dispatch d
				   LEFT JOIN roadmap.agency a ON a.agency_id = d.agency_id
				  WHERE d.dispatch_id = $1`,
				[dispatchId],
			);

			const statusRow = statusRows[0];
			if (!statusRow) {
				rejectReason = "dispatch_closed"; // row doesn't exist
			} else if (agencyIsBlocked(statusRow.agency_status)) {
				rejectReason = "agency_suspended";
			} else if (statusRow.status !== "pending") {
				rejectReason = "dispatch_closed";
			} else {
				rejectReason = "lost_race"; // another txn holds the lock
			}
		} else if (agencyIsBlocked(rows[0]!.agency_status)) {
			// Locked the row but agency is not claimable — reject.
			rejectReason = "agency_suspended";
		} else if (rows[0]!.agency_id) {
			// Agency is claimable — check its concurrency ceiling.
			// fn_check_concurrency materializes the per-agency row (INSERT ON CONFLICT)
			// and acquires a FOR UPDATE lock held until this transaction commits.
			// Serializes concurrent ceiling checks for the same agency_id.
			const { rows: concRows } = await client.query<{
				current_count: number;
				max_count: number;
				ok: boolean;
			}>(
				`SELECT current_count, max_count, ok
				   FROM roadmap_control.fn_check_concurrency($1, $2)`,
				["agency", rows[0]!.agency_id],
			);
			if (concRows[0] && !concRows[0].ok) {
				rejectReason = "concurrency_ceiling_exceeded";
			}
		}

		if (rejectReason !== null) {
			// Record the rejected claim for traceability.
			const { rows: rejectedRows } = await client.query<{ claim_id: string }>(
				`INSERT INTO roadmap_control.claim
				     (dispatch_id, agent_identity, expires_at, status, release_reason)
				 VALUES ($1,$2,$3,'released',$4)
				 RETURNING claim_id::text`,
				[dispatchId, agentIdentity, expiresAt, rejectReason],
			);
			await client.query("COMMIT");
			return {
				won: false,
				reason: rejectReason,
				rejected_claim_id: rejectedRows[0]!.claim_id,
			};
		}

		// Won the race — insert active claim and advance dispatch to 'running'.
		const { rows: claimRows } = await client.query<{ claim_id: string }>(
			`INSERT INTO roadmap_control.claim
			     (dispatch_id, agent_identity, expires_at, status)
			 VALUES ($1,$2,$3,'active')
			 RETURNING claim_id::text`,
			[dispatchId, agentIdentity, expiresAt],
		);

		await client.query(
			`UPDATE roadmap_control.dispatch
			    SET status = 'running', started_at = now()
			  WHERE dispatch_id = $1`,
			[dispatchId],
		);

		await client.query("COMMIT");
		return { won: true, claim_id: claimRows[0]!.claim_id };
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
}

// ─── recordRunFailure ─────────────────────────────────────────────────────────
//
// Records a run as failed and checks whether max_retries has been reached.
// When the failure count hits the limit, the parent dispatch is also set to
// 'failed' (terminal) and a feed event is emitted.
// Returns { terminal: true } so the caller can decide whether to reissue.

export async function recordRunFailure(
	dispatchId: string,
	runId: string,
	exitCode: number,
	opts: { max_retries: number },
): Promise<{ terminal: boolean; failure_count: number }> {
	const client = await getPool().connect();
	try {
		await client.query("BEGIN");

		// Mark the run as failed.
		await client.query(
			`UPDATE roadmap_control.run
			    SET status = 'failed', exit_code = $1, ended_at = now()
			  WHERE run_id = $2`,
			[exitCode, runId],
		);

		// Count total failed runs for this dispatch.
		const { rows: countRows } = await client.query<{ cnt: string }>(
			`SELECT COUNT(*) AS cnt
			   FROM roadmap_control.run
			  WHERE dispatch_id = $1
			    AND status = 'failed'`,
			[dispatchId],
		);
		const failureCount = Number(countRows[0]?.cnt ?? 0);
		const terminal = failureCount >= opts.max_retries;

		if (terminal) {
			await client.query(
				`UPDATE roadmap_control.dispatch
				    SET status = 'failed', completed_at = now()
				  WHERE dispatch_id = $1`,
				[dispatchId],
			);

			// Emit a terminal failure feed event (best-effort inside the same txn).
			await client.query(
				`INSERT INTO roadmap_control.feed_event
				     (dispatch_id, event_class, severity, message)
				 VALUES ($1, 'dispatch_failed', 'error', $2)`,
				[dispatchId, `max_retries=${opts.max_retries} reached after ${failureCount} failures`],
			);
		}

		await client.query("COMMIT");
		return { terminal, failure_count: failureCount };
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
}

// ─── reissueDispatch ──────────────────────────────────────────────────────────
//
// Clones a failed/cancelled dispatch into a new 'pending' dispatch, preserving
// all context fields. The caller is responsible for connecting the new dispatch
// to the claim/run lifecycle.

export async function reissueDispatch(failedDispatchId: string): Promise<string> {
	const { rows } = await query<{ dispatch_id: string }>(
		`INSERT INTO roadmap_control.dispatch
		     (proposal_id, project_id, agency_id, worker_id,
		      host, route, model, provider, agent_cli, budget_scope, status)
		 SELECT proposal_id, project_id, agency_id, worker_id,
		        host, route, model, provider, agent_cli, budget_scope, 'pending'
		   FROM roadmap_control.dispatch
		  WHERE dispatch_id = $1
		 RETURNING dispatch_id::text`,
		[failedDispatchId],
	);

	if (!rows[0]) {
		throw new Error(`reissueDispatch: source dispatch not found: ${failedDispatchId}`);
	}
	return rows[0].dispatch_id;
}

// ─── checkBudgetBeforeSpawn ───────────────────────────────────────────────────
//
// Reads the 'budget_exhausted' flag stored in dispatch.metadata by the budget
// controller. Returns allowed=false when the flag is set so the spawner can
// skip without calling the agent binary.

export async function checkBudgetBeforeSpawn(
	dispatchId: string,
): Promise<{ allowed: boolean; reason: string }> {
	const { rows } = await query<{ budget_exhausted: string | null }>(
		`SELECT metadata->>'budget_exhausted' AS budget_exhausted
		   FROM roadmap_control.dispatch
		  WHERE dispatch_id = $1`,
		[dispatchId],
	);

	if (!rows[0]) {
		return { allowed: false, reason: "dispatch_not_found" };
	}

	if (rows[0].budget_exhausted === "true") {
		return { allowed: false, reason: "budget_exhausted" };
	}

	return { allowed: true, reason: "ok" };
}

// ─── checkHostPolicyBeforeSpawn ───────────────────────────────────────────────
//
// Delegates to roadmap.fn_check_spawn_policy(host, route_provider) which reads
// roadmap.host_model_policy for the host's allowed/forbidden provider lists.
// Returns allowed=false with reason='host_policy_denied' for forbidden routes.

export async function checkHostPolicyBeforeSpawn(
	host: string,
	routeProvider: string,
): Promise<{ allowed: boolean; reason: string }> {
	const { rows } = await query<{ allowed: boolean }>(
		`SELECT roadmap.fn_check_spawn_policy($1, $2) AS allowed`,
		[host, routeProvider],
	);

	const allowed = rows[0]?.allowed ?? false;
	return {
		allowed,
		reason: allowed ? "ok" : "host_policy_denied",
	};
}
