/**
 * P856: Probe agent liveness via tiered checks.
 *
 * Pull-based dispatch (P855) trusts that any squad_dispatch row marked
 * 'claimed' by agent X means X is alive and working. If X has crashed,
 * deadlocked, or never spawned, the lease only recovers on TTL expiry —
 * slow. This probe gives the queue resolver a faster, real liveness signal.
 *
 * Tiered design (cheapest signal wins):
 *
 *   Tier-A (free, ~1ms):  pg_stat_activity check — is some process actively
 *                         LISTENing on msg_<agent_identity>?
 *                         No connection ⇒ definitely not addressable.
 *   Tier-B (free, ~1ms):  agent_health.last_heartbeat_at — was the agent's
 *                         pulseHeartbeat() within HEARTBEAT_FRESH_MS?
 *                         Recent heartbeat ⇒ probably alive.
 *   Tier-C (~5s budget):  active A2A protocol_ping — INSERT message_ledger
 *                         row, fall through to trg_message_notify, poll for
 *                         a 'protocol_pong' reply correlated by reply_to.
 *
 * Caller contract — IMPORTANT:
 *   - signal='unaddressable' means the agent has no LISTEN connection AND no
 *     fresh heartbeat. The agent might still be valid (e.g., claude/agency-bot
 *     today is the OfferProvider runner and does not LISTEN on a2a — see
 *     follow-up P-issue). Callers MUST NOT auto-release a lease on
 *     signal='unaddressable'.
 *   - signal='silent' means the agent IS addressable (LISTEN active or
 *     recent heartbeat) BUT did not respond to an active ping within the
 *     timeout window. THIS authorizes the caller to release/requeue the lease.
 *   - signal='unaddressable' vs 'silent' is the only safe distinction. Do
 *     not collapse them.
 */

import { randomUUID } from "node:crypto";
import { agentNotifyChannel } from "../../../infra/messaging/a2a-access-control.ts";

type QueryFn = <T = Record<string, unknown>>(
	sql: string,
	params?: unknown[],
) => Promise<{ rows: T[] }>;

export type LivenessSignal =
	| "pong" // active ping replied within timeout
	| "heartbeat" // skipped active ping; recent heartbeat sufficient
	| "listen" // skipped active ping; LISTEN active and cheapOnly=true
	| "silent" // addressable but did not respond to active ping
	| "unaddressable"; // no LISTEN, no recent heartbeat — cannot probe safely

export interface LivenessResult {
	alive: boolean;
	signal: LivenessSignal;
	latency_ms?: number;
	reason?: string;
}

export interface ProbeOptions {
	/** Total wall-clock budget for the probe (default 5000ms). */
	timeoutMs?: number;
	/** Heartbeat freshness threshold (default 90s, matches P464 dormancy). */
	heartbeatFreshMs?: number;
	/** Skip Tier-C; return success if Tier-A or Tier-B passes. */
	cheapOnly?: boolean;
	/** Identity of the probing agent (default 'orchestrator'). */
	probeFromAgent?: string;
	/** Injectable for tests. */
	queryFn?: QueryFn;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_HEARTBEAT_FRESH_MS = 90_000;
const POLL_INTERVAL_MS = 100;

// Lazy import: only resolved when no queryFn is injected. Keeps the module
// loadable in test environments where the pg native addon may not be present.
let _poolQuery: QueryFn | undefined;
async function getPoolQuery(): Promise<QueryFn> {
	if (!_poolQuery) {
		const mod = await import("../../../infra/postgres/pool.ts");
		_poolQuery = (mod as unknown as { query: QueryFn }).query;
	}
	return _poolQuery;
}

/**
 * Probe an agent's liveness using tiered checks.
 *
 * Returns a LivenessResult that NEVER throws. Any DB error, missing handler,
 * or timeout collapses to {alive:false, signal:'silent'|'unaddressable', reason}.
 */
export async function probeAgentLiveness(
	agent_identity: string,
	opts: ProbeOptions = {},
): Promise<LivenessResult> {
	const startedAt = Date.now();
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const heartbeatFreshMs = opts.heartbeatFreshMs ?? DEFAULT_HEARTBEAT_FRESH_MS;
	const cheapOnly = opts.cheapOnly ?? false;
	const probeFrom = opts.probeFromAgent ?? "orchestrator";
	const q = opts.queryFn ?? await getPoolQuery();

	// Tier-A: LISTEN check
	const listenActive = await checkListenActive(agent_identity, q);

	// Tier-B: heartbeat freshness
	const heartbeatRecent = await checkHeartbeatRecent(
		agent_identity,
		heartbeatFreshMs,
		q,
	);

	const addressable = listenActive || heartbeatRecent;

	if (!addressable) {
		return {
			alive: false,
			signal: "unaddressable",
			latency_ms: Date.now() - startedAt,
			reason: "no LISTEN connection and no fresh heartbeat — cannot probe",
		};
	}

	// cheapOnly: skip the active ping if Tier-A or Tier-B already passed.
	if (cheapOnly) {
		return {
			alive: true,
			signal: heartbeatRecent ? "heartbeat" : "listen",
			latency_ms: Date.now() - startedAt,
		};
	}

	// Tier-C: active A2A protocol_ping
	const remaining = timeoutMs - (Date.now() - startedAt);
	if (remaining <= 0) {
		return {
			alive: heartbeatRecent,
			signal: heartbeatRecent ? "heartbeat" : "silent",
			latency_ms: Date.now() - startedAt,
			reason: "timeout exhausted before ping could fire",
		};
	}

	const correlationId = randomUUID();
	let pingMessageId: number | null = null;

	try {
		const { rows } = await q<{ id: string }>(
			`INSERT INTO roadmap.message_ledger
                (from_agent, to_agent, message_type, message_content, correlation_id)
             VALUES ($1, $2, 'protocol_ping', 'ping', $3)
             RETURNING id`,
			[probeFrom, agent_identity, correlationId],
		);
		pingMessageId = Number(rows[0]?.id);
	} catch (err) {
		return {
			alive: false,
			signal: "silent",
			latency_ms: Date.now() - startedAt,
			reason: `ping insert failed: ${errMsg(err)}`,
		};
	}

	if (!pingMessageId) {
		return {
			alive: false,
			signal: "silent",
			latency_ms: Date.now() - startedAt,
			reason: "ping INSERT returned no id",
		};
	}

	// Poll for pong: a row from agent_identity with reply_to=our_id OR matching
	// correlation_id, and message_type='protocol_pong'.
	while (Date.now() - startedAt < timeoutMs) {
		try {
			const { rows: pongRows } = await q<{ id: string; created_at: Date }>(
				`SELECT id, created_at
                   FROM roadmap.message_ledger
                  WHERE from_agent      = $1
                    AND message_type    = 'protocol_pong'
                    AND (reply_to = $2 OR correlation_id = $3)
                  LIMIT 1`,
				[agent_identity, pingMessageId, correlationId],
			);
			if (pongRows.length > 0) {
				return {
					alive: true,
					signal: "pong",
					latency_ms: Date.now() - startedAt,
				};
			}
		} catch (err) {
			return {
				alive: false,
				signal: "silent",
				latency_ms: Date.now() - startedAt,
				reason: `pong poll failed: ${errMsg(err)}`,
			};
		}

		const remainingNow = timeoutMs - (Date.now() - startedAt);
		if (remainingNow <= 0) break;
		await sleep(Math.min(POLL_INTERVAL_MS, remainingNow));
	}

	// Timed out waiting for pong. The agent IS addressable (Tier-A or B passed)
	// but didn't respond — caller MAY release the lease.
	return {
		alive: false,
		signal: "silent",
		latency_ms: Date.now() - startedAt,
		reason: `no protocol_pong within ${timeoutMs}ms`,
	};
}

// ─── Tier helpers ───────────────────────────────────────────────────────────

async function checkListenActive(
	agent_identity: string,
	q: QueryFn,
): Promise<boolean> {
	try {
		const { rows } = await q<{ exists: boolean }>(
			`SELECT EXISTS (
                SELECT 1 FROM pg_stat_activity
                 WHERE query = $1
                   AND state IN ('idle', 'active')
            ) AS exists`,
			[`LISTEN "${agentNotifyChannel(agent_identity)}"`],
		);
		return Boolean(rows[0]?.exists);
	} catch {
		return false;
	}
}

async function checkHeartbeatRecent(
	agent_identity: string,
	freshMs: number,
	q: QueryFn,
): Promise<boolean> {
	// Tier-B liveness: either canonical source proves the agent is alive.
	//
	//   1. roadmap.agency.presence_state IN ('online','busy') — A2A maintains this
	//      via fn_pulse for agencies. This is the canonical signal post-P1132 and
	//      DOES NOT rely on a 30 s timer.
	//   2. roadmap.agent_health.last_heartbeat_at fresh — for per-task workers
	//      that aren't agencies (no agency row), and as a transitional fallback
	//      for agencies whose A2A presence-refresh hasn't fired yet.
	//
	// Either signal counts. Single query, no extra round-trips.
	try {
		const { rows } = await q<{ fresh: boolean | null }>(
			`SELECT (
                  COALESCE(
                    (SELECT presence_state IN ('online', 'busy')
                       FROM roadmap.agency WHERE agency_id = $2),
                    false
                  )
                  OR EXISTS (
                    SELECT 1 FROM roadmap_workforce.agent_health
                     WHERE agent_identity = $2
                       AND last_heartbeat_at > now() - ($1::int * interval '1 millisecond')
                  )
                ) AS fresh`,
			[freshMs, agent_identity],
		);
		return Boolean(rows[0]?.fresh);
	} catch {
		return false;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
