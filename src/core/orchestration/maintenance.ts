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
		const { rows: staleAgencies } = await queryFn<{ agency_id: string }>(
			`SELECT a.agency_id
			 FROM roadmap.agency a
			 WHERE a.status IN ('active', 'throttled')
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
