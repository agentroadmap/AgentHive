/**
 * P1123 Phase 3 — Pool poisoning watchdog.
 *
 * Periodically probes the shared pool with `SELECT 1`. If the probe throws
 * `Cannot use a pool after calling end on the pool`, publishes a pg_notify
 * on the `control_feed` channel so the state-feed-listener forwards it to
 * the Discord operator channel and the incident is observable in <60s
 * instead of the 30 hours seen on 2026-05-15.
 *
 * The publisher uses a dedicated pg.Client (not the shared pool) so that
 * alerting still works after the pool is poisoned.
 *
 * Usage in a long-running service:
 *   import { startPoolWatchdog } from "../src/infra/postgres/pool-watchdog.ts";
 *   const stopWatchdog = startPoolWatchdog("agenthive-board");
 *   // … later in shutdown handler: await stopWatchdog();
 */

import { Client } from "pg";
import { query } from "./pool.ts";

const DEFAULT_INTERVAL_MS = 60_000;
const POISONED_ERROR_FRAGMENT = "after calling end on the pool";

export interface WatchdogOptions {
	intervalMs?: number;
	/** Override for tests. Production uses pg.Client() with PG env vars. */
	notifyClient?: Pick<Client, "query" | "connect" | "end" | "on">;
}

export interface WatchdogHandle {
	stop: () => Promise<void>;
	/** Internal: exposed for testing. */
	tick: () => Promise<void>;
}

export function startPoolWatchdog(
	serviceName: string,
	options: WatchdogOptions = {},
): WatchdogHandle {
	const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
	let notifyClient: Pick<Client, "query" | "connect" | "end" | "on"> | null =
		options.notifyClient ?? null;
	let notifyClientReady = false;
	let timer: ReturnType<typeof setInterval> | null = null;
	let stopped = false;

	async function ensureNotifyClient(): Promise<void> {
		if (notifyClientReady) return;
		if (!notifyClient) {
			// Dedicated client — separate connection that survives shared-pool death.
			// pg.Client() reads PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE from env.
			notifyClient = new Client();
			notifyClient.on("error", (err) => {
				console.error(
					`[pool-watchdog:${serviceName}] notify client error:`,
					err.message,
				);
				notifyClientReady = false;
			});
		}
		await notifyClient.connect();
		notifyClientReady = true;
	}

	async function publishPoisonedAlert(detail: string): Promise<void> {
		try {
			await ensureNotifyClient();
			if (!notifyClient) return;
			const payload = JSON.stringify({
				event_type: "pool_poisoned",
				service_name: serviceName,
				detail,
				ts: new Date().toISOString(),
			});
			await notifyClient.query("SELECT pg_notify('control_feed', $1)", [payload]);
		} catch (err) {
			console.error(
				`[pool-watchdog:${serviceName}] failed to publish pool_poisoned notify:`,
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	async function tick(): Promise<void> {
		try {
			await query("SELECT 1");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes(POISONED_ERROR_FRAGMENT)) {
				console.error(
					`[pool-watchdog:${serviceName}] POOL POISONED — alerting via control_feed`,
				);
				await publishPoisonedAlert(msg);
			} else {
				// Any other error is logged but not alerted — could be transient.
				console.warn(
					`[pool-watchdog:${serviceName}] probe error (non-poisoning):`,
					msg,
				);
			}
		}
	}

	timer = setInterval(() => {
		if (!stopped) void tick();
	}, intervalMs);

	return {
		stop: async () => {
			stopped = true;
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
			if (notifyClient && notifyClientReady) {
				try {
					await notifyClient.end();
				} catch {
					/* ignore */
				}
			}
		},
		tick,
	};
}
