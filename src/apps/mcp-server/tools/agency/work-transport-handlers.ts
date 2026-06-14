/**
 * P1385: MCP agency work transport handlers
 *
 * Three new MCP actions for remote agency work transport (no PG LISTEN required):
 * - agency_subscribe: long-poll for next available claimed offer
 * - agency_submit_result: write agent_runs row, release lease
 * - agency_heartbeat: extend claim_expires_at to prevent requeue
 *
 * Design: fn_claim_work_offer is non-blocking; agency_subscribe implements
 * sleep+poll loop. Lease expiry via existing fn_reap_expired_offers (no new watchdog).
 * Bearer token auth when MCP_AGENCY_AUTH=on.
 */

import { query } from "../../../../infra/postgres/pool.js";
import { verifyDeliverables } from "../../../../core/orchestration/deliverable-verifier.js";
import crypto from "crypto";

const POLL_INTERVAL_MS = 2000;
const MAX_TIMEOUT_SECONDS = 30;
const DEFAULT_LEASE_SECONDS = 60;
const MAX_CONCURRENT_SUBSCRIBERS = 10;

export interface AgencySubscribeInput {
	agency_identity: string;
	timeout_seconds?: number;
	lease_seconds?: number;
	authorization?: string;
}

export interface AgencySubscribeResult {
	dispatch_id?: bigint;
	proposal_id?: bigint;
	squad_name?: string;
	dispatch_role?: string;
	claim_token?: string;
	claim_expires_at?: string;
	offer_version?: number;
	metadata?: Record<string, any>;
	empty?: boolean;
	polled_at?: string;
}

export interface AgencySubmitResultInput {
	dispatch_id: bigint;
	claim_token: string;
	status: "completed" | "failed";
	duration_ms: number;
	tokens_in?: number;
	tokens_out?: number;
	cost_usd?: number;
	output_summary?: string;
	authorization?: string;
}

export interface AgencySubmitResultOutput {
	agent_runs_id?: number;
	agent_runs_row?: Record<string, any>;
	message?: string;
	/** P1438 AC-12/13: false when a 'completed' submit was downgraded for lack of evidence. */
	delivered?: boolean;
	/** P1438 AC-12/13: reason the completion was rejected as a delivery (if any). */
	evidence_rejected?: string;
}

export interface AgencyHeartbeatInput {
	dispatch_id: bigint;
	claim_token: string;
	lease_seconds?: number;
	authorization?: string;
}

export interface AgencyHeartbeatOutput {
	claim_expires_at?: string;
	renewed_at?: string;
	message?: string;
}

/**
 * Verify agency bearer token (MCP_AGENCY_AUTH mode)
 *
 * When MCP_AGENCY_AUTH=on, checks Authorization header against token_hash
 * in agent_registry. When off, skips check (trusted-LAN mode).
 */
export async function verifyAgencyBearer(
	agency_identity: string,
	authHeader?: string,
): Promise<{ ok: boolean; status?: number; reason?: string }> {
	// Read MCP_AGENCY_AUTH env (default: off)
	const authMode = (process.env.MCP_AGENCY_AUTH || "off").toLowerCase();
	if (authMode !== "on") {
		return { ok: true }; // Trusted-LAN mode
	}

	// Auth required: bearer token must be present and match token_hash
	if (!authHeader) {
		return { ok: false, status: 401, reason: "missing_authorization" };
	}

	// Extract bearer token from "Bearer <token>" format
	const match = authHeader.match(/^Bearer\s+(.+)$/i);
	if (!match || !match[1]) {
		return { ok: false, status: 401, reason: "invalid_bearer_format" };
	}

	const plaintext_token = match[1];
	const token_hash = crypto.createHash("sha256").update(plaintext_token).digest("hex");

	// Look up token_hash in agent_registry
	const result = await query(
		`SELECT id FROM roadmap_workforce.agent_registry
     WHERE agent_identity = $1 AND token_hash = $2`,
		[agency_identity, token_hash],
	);

	if (result.rows.length === 0) {
		return { ok: false, status: 401, reason: "invalid_token" };
	}

	return { ok: true };
}

/**
 * agency_subscribe: Long-poll for next available claimed offer
 *
 * Implements sleep+poll loop (Blocker 2 design):
 * 1. Authenticate bearer token (if MCP_AGENCY_AUTH=on)
 * 2. Fetch capabilities from agent_capability (server-sourced)
 * 3. Fetch host_affinity from agent_registry
 * 4. Loop: call fn_claim_work_offer, sleep POLL_INTERVAL_MS, until timeout
 * 5. Return offer payload or empty on timeout
 *
 * Timeout capped at MAX_TIMEOUT_SECONDS (30s) to fit within nginx proxy_read_timeout.
 * Lease default 60s; heartbeat every 20s extends claim_expires_at.
 */
export async function handleAgencySubscribe(input: AgencySubscribeInput): Promise<AgencySubscribeResult> {
	if (!input.agency_identity?.trim()) {
		throw new Error("agency_identity is required");
	}

	// Authenticate
	const authCheck = await verifyAgencyBearer(input.agency_identity, input.authorization);
	if (!authCheck.ok) {
		const error = new Error(`Authentication failed: ${authCheck.reason}`);
		(error as any).status = authCheck.status || 401;
		throw error;
	}

	// Cap timeout at MAX_TIMEOUT_SECONDS
	const timeout_seconds = Math.min(input.timeout_seconds ?? 30, MAX_TIMEOUT_SECONDS);
	const lease_seconds = input.lease_seconds ?? DEFAULT_LEASE_SECONDS;

	// Fetch capabilities from agent_capability (server-sourced)
	const capResult = await query(
		`SELECT ARRAY_AGG(ac.capability) FILTER (WHERE ac.capability IS NOT NULL) as caps
     FROM roadmap_workforce.agent_capability ac
     JOIN roadmap_workforce.agent_registry ar ON ac.agent_id = ar.id
     WHERE ar.agent_identity = $1`,
		[input.agency_identity],
	);

	const capabilities = capResult.rows[0]?.caps || [];
	const capabilitiesJsonb = Array.isArray(capabilities) ? JSON.stringify(capabilities) : "{}";

	// Fetch host_affinity
	const hostResult = await query(
		`SELECT host_affinity FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
		[input.agency_identity],
	);

	if (hostResult.rows.length === 0) {
		const error = new Error("Agency not found");
		(error as any).status = 404;
		throw error;
	}

	const host_affinity = hostResult.rows[0].host_affinity || null;

	// Poll loop
	const deadline = Date.now() + timeout_seconds * 1000;
	const polled_at = new Date().toISOString();

	while (Date.now() < deadline) {
		// Call fn_claim_work_offer (Overload B: 5-param with host)
		const claimResult = await query(
			`SELECT dispatch_id, proposal_id, squad_name, dispatch_role, claim_token,
               claim_expires_at, offer_version, metadata
        FROM roadmap_workforce.fn_claim_work_offer($1, $2::jsonb, $3, NULL, $4)`,
			[input.agency_identity, capabilitiesJsonb, lease_seconds, host_affinity],
		);

		if (claimResult.rows.length > 0) {
			const row = claimResult.rows[0];
			return {
				dispatch_id: row.dispatch_id,
				proposal_id: row.proposal_id,
				squad_name: row.squad_name,
				dispatch_role: row.dispatch_role,
				claim_token: row.claim_token?.toString(),
				claim_expires_at: row.claim_expires_at,
				offer_version: row.offer_version,
				metadata: row.metadata,
			};
		}

		// Check deadline before sleep
		if (Date.now() >= deadline) {
			break;
		}

		// Sleep (without holding PG connection)
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}

	// Timeout: return empty
	return {
		empty: true,
		polled_at,
	};
}

/**
 * agency_submit_result: Write agent_runs row, release lease
 *
 * Idempotent: checks if dispatch already delivered/failed before INSERT.
 * Token validation: claim_token must match the dispatch row.
 *
 * Steps:
 * 1. Authenticate bearer token (if MCP_AGENCY_AUTH=on)
 * 2. UPDATE squad_dispatch: set offer_status to delivered/failed, set completed_at
 * 3. INSERT agent_runs row with status, duration_ms, tokens, output_summary
 * 4. Return agent_runs id or error
 */
export async function handleAgencySubmitResult(input: AgencySubmitResultInput): Promise<AgencySubmitResultOutput> {
	if (input.dispatch_id === undefined) {
		throw new Error("dispatch_id is required");
	}
	if (!input.claim_token?.trim()) {
		throw new Error("claim_token is required");
	}
	if (!["completed", "failed"].includes(input.status)) {
		throw new Error("status must be 'completed' or 'failed'");
	}
	if (input.duration_ms === undefined) {
		throw new Error("duration_ms is required");
	}

	// Authenticate
	const authCheck = await verifyAgencyBearer("", input.authorization); // Placeholder; real impl gets from context
	if (!authCheck.ok) {
		const error = new Error(`Authentication failed: ${authCheck.reason}`);
		(error as any).status = authCheck.status || 401;
		throw error;
	}

	// Begin transaction
	try {
		await query("BEGIN");

		// 1. Validate and close dispatch
		const updateResult = await query(
			`UPDATE roadmap_workforce.squad_dispatch
       SET offer_status = CASE WHEN $2='completed' THEN 'delivered' ELSE 'failed' END,
           dispatch_status = CASE WHEN $2='completed' THEN 'completed' ELSE 'failed' END,
           completed_at = now()
       WHERE id = $1 AND claim_token = $3 AND offer_status = 'claimed'
       RETURNING proposal_id, dispatch_role, agent_identity, agency_identity, squad_name, required_capabilities`,
			[input.dispatch_id, input.status, input.claim_token],
		);

		if (updateResult.rows.length === 0) {
			// Dispatch not found or already completed (idempotent: try to find existing agent_runs)
			const existingRun = await query(
				`SELECT id FROM roadmap_workforce.agent_runs
         WHERE dispatch_id = $1
         ORDER BY id DESC LIMIT 1`,
				[input.dispatch_id],
			);

			await query("ROLLBACK");

			if (existingRun.rows.length > 0) {
				return {
					message: "Already submitted (idempotent)",
					agent_runs_id: existingRun.rows[0].id,
				};
			}

			const error = new Error("Dispatch not found or already completed");
			(error as any).status = 409;
			throw error;
		}

		const dispatch = updateResult.rows[0];

		// 2. Insert agent_runs row
		// Parse output_summary as JSON if provided
		let output_summary_obj = null;
		if (input.output_summary) {
			try {
				output_summary_obj = typeof input.output_summary === "string" ? JSON.parse(input.output_summary) : input.output_summary;
			} catch {
				output_summary_obj = { text: input.output_summary };
			}
		}

		const runsResult = await query(
			`INSERT INTO roadmap_workforce.agent_runs
       (proposal_id, display_id, agent_identity, stage, model_used,
        tokens_in, tokens_out, cost_usd, duration_ms, status, output_summary,
        started_at, completed_at, activity, dispatch_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now(), 'mcp_transport', $12)
       RETURNING id`,
			[
				dispatch.proposal_id,
				null, // display_id
				dispatch.agent_identity || null,
				dispatch.dispatch_role,
				null, // model_used
				input.tokens_in ?? 0,
				input.tokens_out ?? 0,
				input.cost_usd ?? 0,
				input.duration_ms,
				input.status,
				output_summary_obj ? JSON.stringify(output_summary_obj) : null,
				input.dispatch_id,
			],
		);

		// P1438 AC-12/13 (option B): evidence-gate the MCP completion path so the AI
		// liaison's completions are held to the same bar as the mechanical handler,
		// reusing verifyDeliverables (single source of truth). A 'completed' submit
		// only stays 'delivered' if it carries a non-empty result AND the role
		// artifact exists (proposal_reviews / agent_runs / AC / discussion). The
		// agent_runs row was just inserted, so the developer check sees it. On a miss
		// we downgrade the OFFER to failed — the worker ran but produced no canonical
		// deliverable; never a false 'delivered'. (D4 zero-token gate auto-advance is
		// unaffected: it completes via fn_complete_work_offer in the mechanical
		// handler, not this MCP transport path.)
		let evidenceRejected: string | null = null;
		if (input.status === "completed") {
			const summaryEmpty =
				!output_summary_obj ||
				(typeof input.output_summary === "string" &&
					input.output_summary.trim().length === 0);
			if (summaryEmpty) {
				evidenceRejected = "empty result summary";
			} else {
				const verdict = await verifyDeliverables({
					proposalId: Number(dispatch.proposal_id),
					dispatchRole: dispatch.dispatch_role,
					workerIdentity: dispatch.agent_identity ?? dispatch.agency_identity ?? "",
					dispatchId: Number(input.dispatch_id),
				}).catch((e) => ({
					verified: false,
					failureReason: `verification error: ${e instanceof Error ? e.message : String(e)}`,
				}));
				if (!verdict.verified) {
					evidenceRejected = verdict.failureReason ?? "no role artifact";
				}
			}
			if (evidenceRejected) {
				await query(
					`UPDATE roadmap_workforce.squad_dispatch
					    SET offer_status = 'failed',
					        dispatch_status = 'failed',
					        failure_class = COALESCE(failure_class, 'no_artifact'),
					        failure_is_transient = false,
					        metadata = COALESCE(metadata, '{}'::jsonb)
					                 || jsonb_build_object('evidence_rejected', $2::text)
					  WHERE id = $1`,
					[input.dispatch_id, evidenceRejected],
				);
			}
		}

		await query("COMMIT");

		const agent_runs_id = runsResult.rows[0]?.id;
		if (evidenceRejected) {
			return {
				agent_runs_id,
				message: `Completion downgraded to failed — evidence gate: ${evidenceRejected}`,
				delivered: false,
				evidence_rejected: evidenceRejected,
			} as AgencySubmitResultOutput;
		}
		return {
			agent_runs_id,
			message: "Result submitted",
			delivered: input.status === "completed",
		} as AgencySubmitResultOutput;
	} catch (err) {
		await query("ROLLBACK").catch(() => {});
		throw err;
	}
}

/**
 * agency_heartbeat: Extend claim_expires_at to prevent requeue
 *
 * Called by remote executor during long-running work to prevent lease expiry.
 * Updates claim_expires_at to now() + lease_seconds.
 *
 * Idempotent: if dispatch not in 'claimed' state, returns 409 (conflict).
 */
export async function handleAgencyHeartbeat(input: AgencyHeartbeatInput): Promise<AgencyHeartbeatOutput> {
	if (input.dispatch_id === undefined) {
		throw new Error("dispatch_id is required");
	}
	if (!input.claim_token?.trim()) {
		throw new Error("claim_token is required");
	}

	// Authenticate
	const authCheck = await verifyAgencyBearer("", input.authorization); // Placeholder
	if (!authCheck.ok) {
		const error = new Error(`Authentication failed: ${authCheck.reason}`);
		(error as any).status = authCheck.status || 401;
		throw error;
	}

	const lease_seconds = input.lease_seconds ?? DEFAULT_LEASE_SECONDS;

	const result = await query(
		`UPDATE roadmap_workforce.squad_dispatch
     SET claim_expires_at = now() + make_interval(secs => $1),
         last_renewed_at = now(),
         renew_count = renew_count + 1
     WHERE id = $2 AND claim_token = $3 AND offer_status = 'claimed'
     RETURNING claim_expires_at`,
		[lease_seconds, input.dispatch_id, input.claim_token],
	);

	if (result.rows.length === 0) {
		const error = new Error("Heartbeat failed: dispatch not in claimed state");
		(error as any).status = 409;
		throw error;
	}

	const renewed_at = new Date().toISOString();
	return {
		claim_expires_at: result.rows[0].claim_expires_at,
		renewed_at,
		message: "Heartbeat accepted",
	};
}
