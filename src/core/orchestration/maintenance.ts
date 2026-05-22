/**
 * Shared maintenance tasks for the unified orchestrator.
 *
 * Originally extracted from the legacy gate-pipeline (P754 retired) so the
 * Orchestrator class could run the same maintenance cycle. Now the unified
 * orchestrator is the only consumer.
 *
 * All functions accept a QueryFn to stay injectable (testable without a real
 * pool).
 */

import { query as poolQuery } from "../../infra/postgres/pool.ts";
import { sendLiaisonPoke } from "../../infra/agency/liaison-message-service.ts";
import {
	probeAgentLiveness,
	type LivenessSignal,
} from "./probes/agent-liveness.ts";
import { runLivenessAlertTick } from "../../infra/agency/liveness-alerting.ts";

export type QueryFn = typeof poolQuery;

export interface MaintenanceLogger {
	log(msg: string): void;
	warn(msg: string): void;
}

export interface PokeWatchdogOptions {
	idleThresholdMin: number;
	stormCap: number;
}

// ─── Boot-time pass ───────────────────────────────────────────────────────────

/**
 * Cancel any open poke attempts left over from a prior process epoch.
 * Safe to call multiple times (CAS on outcome IS NULL).
 */
export async function bootCancelPokeAttempts(
	queryFn: QueryFn = poolQuery,
	logger: MaintenanceLogger = console,
	tag = "Maintenance",
): Promise<void> {
	try {
		const { rowCount } = await queryFn(
			`UPDATE roadmap.liaison_poke_attempt
			 SET outcome = 'cancelled', resolved_at = now()
			 WHERE outcome IS NULL`,
		);
		if (rowCount && rowCount > 0) {
			logger.log(
				`[${tag}] Boot-cancelled ${rowCount} open poke attempt(s) from prior epoch`,
			);
		}
	} catch (err) {
		logger.warn(
			`[${tag}] Boot-cancel pass failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

// ─── Periodic: poke watchdog ──────────────────────────────────────────────────

/**
 * One tick of the poke watchdog:
 *   1. Resolution pass — CAS-close poke attempts older than 60 s.
 *   2. Emission pass   — find stale agencies with no open poke and emit
 *                        (storm-capped to opts.stormCap).
 */
export async function runPokeWatchdogTick(
	opts: PokeWatchdogOptions,
	queryFn: QueryFn = poolQuery,
	logger: MaintenanceLogger = console,
	tag = "Maintenance",
): Promise<void> {
	// Resolution pass
	try {
		const { rowCount: timedOut } = await queryFn(
			`UPDATE roadmap.liaison_poke_attempt
			 SET outcome = 'timed_out', resolved_at = now()
			 WHERE outcome IS NULL
			   AND poked_at < now() - INTERVAL '60 seconds'`,
		);
		if (timedOut && timedOut > 0) {
			logger.log(
				`[${tag}] Poke watchdog: ${timedOut} poke(s) timed out → stale-unresponsive`,
			);
		}
	} catch (err) {
		logger.warn(
			`[${tag}] Poke resolution pass failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return;
	}

	// Emission pass
	try {
		// Poke watchdog: ask the liaison to prove it's alive. Skip agencies whose
		// presence_state already says alive — A2A maintains it via fn_pulse, so
		// 'online'/'busy' is canonical proof of liveness (no poke needed).
		// Only poke when presence is NOT alive AND heartbeat is stale.
		const { rows: staleAgencies } = await queryFn<{ agency_id: string }>(
			`SELECT a.agency_id
			 FROM roadmap.agency a
			 WHERE a.status IN ('active', 'throttled')
			   AND (a.presence_state IS NULL
			        OR a.presence_state NOT IN ('online', 'busy'))
			   AND a.last_heartbeat_at IS NOT NULL
			   AND (now() - a.last_heartbeat_at) > ($1 || ' minutes')::interval
			   AND NOT EXISTS (
			     SELECT 1 FROM roadmap.liaison_poke_attempt lpa
			     WHERE lpa.agency_id = a.agency_id AND lpa.outcome IS NULL
			   )
			 ORDER BY a.last_heartbeat_at ASC
			 LIMIT $2`,
			[String(opts.idleThresholdMin), String(opts.stormCap)],
		);

		for (const { agency_id } of staleAgencies) {
			try {
				const { pokeMessageId } = await sendLiaisonPoke(
					agency_id,
					opts.idleThresholdMin,
				);
				logger.log(`[${tag}] Sent poke ${pokeMessageId} to stale agency ${agency_id}`);
			} catch (err) {
				logger.warn(
					`[${tag}] Failed to poke agency ${agency_id}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	} catch (err) {
		logger.warn(
			`[${tag}] Poke emission pass failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

// ─── Periodic: liveness alerting ─────────────────────────────────────────────

/**
 * P765: One tick of the liveness alerting loop.
 *   1. Transitions provider_registry silent agencies (dormant/offline).
 *   2. Transitions roadmap.agency dormant→offline (5 min threshold).
 *   3. Emits single-shot Discord alerts for agencies offline > 10 min (AC-3/AC-4).
 *   4. Emits recovery alerts and clears debounce flags.
 */
export async function runLivenessAlertingTick(
	logger: MaintenanceLogger = console,
	tag = "Maintenance",
): Promise<void> {
	try {
		await runLivenessAlertTick();
	} catch (err) {
		logger.warn(
			`[${tag}] Liveness alert tick failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

// ─── Periodic: offer reaper ───────────────────────────────────────────────────

/**
 * Invoke fn_reap_expired_offers() — reissues expired offers to pending and
 * marks un-claimable ones as expired. Idempotent; safe to call concurrently
 * (callers should guard with an inFlight flag).
 */
export async function runOfferReaper(
	queryFn: QueryFn = poolQuery,
	logger: MaintenanceLogger = console,
	tag = "Maintenance",
): Promise<void> {
	try {
		const { rows } = await queryFn<{
			reissued_count: number;
			expired_count: number;
		}>("SELECT * FROM roadmap_workforce.fn_reap_expired_offers()");
		const row = rows[0];
		const reissued = Number(row?.reissued_count ?? 0);
		const expired = Number(row?.expired_count ?? 0);
		if (reissued > 0 || expired > 0) {
			logger.log(`[${tag}] Offer reaper: ${reissued} reissued, ${expired} expired`);
		}
	} catch (err) {
		logger.warn(
			`[${tag}] Offer reaper failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

// ─── Periodic: stale-lease probe sweep ───────────────────────────────────────

export interface StaleLeaseSweepOptions {
	/** Seconds without agent heartbeat before a dispatch is considered possibly stale (default 90). */
	renewalThresholdSec?: number;
	/** Max dispatches to probe per call — storm cap (default 5). */
	stormCap?: number;
	/** Wall-clock budget per probe in ms (default 5000). */
	probeTimeoutMs?: number;
	/** Skip Tier-C active ping; use Tier-A/B only (default false). */
	cheapOnly?: boolean;
	/** Probing agent identity inserted into message_ledger (default 'orchestrator'). */
	probeFromAgent?: string;
	/**
	 * Called when signal='silent' (agent IS addressable but not responding).
	 * Use to force early lease expiry (e.g. reset claim_expires_at to now()).
	 * MUST NOT be called when signal='unaddressable' — see caller contract in
	 * src/core/orchestration/probes/agent-liveness.ts.
	 */
	onSilent?: (dispatchId: number, agentIdentity: string) => Promise<void>;
}

export interface StaleLeaseSweepRow {
	dispatch_id: number;
	agent_identity: string;
	signal: LivenessSignal;
	alive: boolean;
	latency_ms?: number;
}

export interface StaleLeaseSweepResult {
	probed: StaleLeaseSweepRow[];
	aliveCount: number;
	silentCount: number;
	unaddressableCount: number;
}

/**
 * One sweep of the stale-dispatch liveness probe.
 *
 * Finds squad_dispatch rows in status='active' whose claiming agent has not
 * heartbeated within renewalThresholdSec. Calls probeAgentLiveness for each
 * (cheapOnly=false by default — fires a real protocol_ping).
 *
 * Caller contract (mirrors probeAgentLiveness doc):
 *   signal='silent'        → agent IS addressable but not responding; caller
 *                            SHOULD force early lease expiry via onSilent.
 *   signal='unaddressable' → no LISTEN + no heartbeat; MUST NOT release the
 *                            lease (OfferProvider agencies may lack A2A listening).
 *   signal='alive'         → agent responded; no action needed.
 *
 * probeFn is injectable so callers can unit-test this sweep without a DB.
 */
export async function runStaleLeaseProbeSweep(
	opts: StaleLeaseSweepOptions = {},
	queryFn: QueryFn = poolQuery,
	probeFn: typeof probeAgentLiveness = probeAgentLiveness,
	logger: MaintenanceLogger = console,
	tag = "Maintenance",
): Promise<StaleLeaseSweepResult> {
	const thresholdSec = opts.renewalThresholdSec ?? 90;
	const stormCap = opts.stormCap ?? 5;
	const probeTimeoutMs = opts.probeTimeoutMs ?? 5_000;
	const cheapOnly = opts.cheapOnly ?? false;
	const probeFromAgent = opts.probeFromAgent ?? "orchestrator";

	const result: StaleLeaseSweepResult = {
		probed: [],
		aliveCount: 0,
		silentCount: 0,
		unaddressableCount: 0,
	};

	let candidates: Array<{ dispatch_id: number; agent_identity: string }>;
	try {
		const { rows } = await queryFn<{ dispatch_id: string; agent_identity: string }>(
			`SELECT sd.id AS dispatch_id, sd.agent_identity
			   FROM roadmap_workforce.squad_dispatch sd
			   LEFT JOIN roadmap_workforce.agent_health ah
			     ON ah.agent_identity = sd.agent_identity
			  WHERE sd.dispatch_status = 'active'
			    AND (
			          ah.last_heartbeat_at IS NULL
			          OR ah.last_heartbeat_at < now() - ($1 * interval '1 second')
			        )
			  ORDER BY COALESCE(ah.last_heartbeat_at, '-infinity'::timestamptz) ASC
			  LIMIT $2`,
			[thresholdSec, stormCap],
		);
		candidates = rows.map((r) => ({
			dispatch_id: Number(r.dispatch_id),
			agent_identity: r.agent_identity,
		}));
	} catch (err) {
		logger.warn(
			`[${tag}] Stale-lease sweep: candidate query failed — ${err instanceof Error ? err.message : String(err)}`,
		);
		return result;
	}

	if (candidates.length === 0) return result;

	logger.log(
		`[${tag}] Stale-lease sweep: probing ${candidates.length} dispatch(es) with stale heartbeat`,
	);

	for (const { dispatch_id, agent_identity } of candidates) {
		let probe;
		try {
			probe = await probeFn(agent_identity, {
				timeoutMs: probeTimeoutMs,
				cheapOnly,
				probeFromAgent,
				queryFn,
			});
		} catch (err) {
			// probeFn must never throw, but be defensive
			probe = {
				alive: false,
				signal: "unaddressable" as LivenessSignal,
				reason: `probe threw: ${err instanceof Error ? err.message : String(err)}`,
			};
		}

		result.probed.push({
			dispatch_id,
			agent_identity,
			signal: probe.signal,
			alive: probe.alive,
			latency_ms: probe.latency_ms,
		});

		if (probe.alive) {
			result.aliveCount++;
			logger.log(
				`[${tag}] Stale-lease sweep: dispatch=${dispatch_id} agent=${agent_identity} alive (signal=${probe.signal}, ${probe.latency_ms}ms)`,
			);
		} else if (probe.signal === "unaddressable") {
			result.unaddressableCount++;
			logger.log(
				`[${tag}] Stale-lease sweep: dispatch=${dispatch_id} agent=${agent_identity} UNADDRESSABLE — skipping lease release per caller contract`,
			);
		} else {
			// signal='silent': addressable but non-responsive — safe to requeue
			result.silentCount++;
			logger.warn(
				`[${tag}] Stale-lease sweep: dispatch=${dispatch_id} agent=${agent_identity} SILENT (${probe.latency_ms}ms) — candidate for early requeue`,
			);
			if (opts.onSilent) {
				try {
					await opts.onSilent(dispatch_id, agent_identity);
				} catch (err) {
					logger.warn(
						`[${tag}] Stale-lease sweep: onSilent for dispatch=${dispatch_id} threw — ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		}
	}

	logger.log(
		`[${tag}] Stale-lease sweep: alive=${result.aliveCount} silent=${result.silentCount} unaddressable=${result.unaddressableCount}`,
	);

	return result;
}
