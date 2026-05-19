/**
 * A2A Host Runtime — P1132.
 *
 * Mechanical router shaped like Discord/WhatsApp low-level infra: discovers
 * local agencies in agent_registry, attaches a LISTEN session for each,
 * routes inbound a2a_msg_<identity> NOTIFY events into the existing
 * runLiaisonAgent dispatch path. Does not host agencies, does not own their
 * lifecycle. systemd is the sole process supervisor for this runtime;
 * agencies will eventually own their own lifecycle (via P1129 operator-
 * triggered MCP registration of independent standing AI liaisons).
 *
 * Phase 1 keeps today's spawn-per-message provider invocation unchanged.
 * The deferred follow-ons (stdin-loop, worker pool, multi-host inbound HTTP,
 * credential vault, etc.) are tracked under P1132's appendix.
 *
 * Configuration source-of-truth — NO HARDCODED CONSTANTS:
 *   - AGENTHIVE_HOST: env / yaml (universal config, structural key)
 *   - All tunables: core.runtime_flag rows (seeded by migration 170-p1132-...)
 *     - A2A_HOST_LISTEN_REFRESH_MS    (registry re-read cadence; see TODO below)
 *     - A2A_HOST_SHUTDOWN_TIMEOUT_MS
 *     - A2A_HOST_PRESENCE_REFRESH_MS  (compat shim; see TODO below)
 *
 * Liveness on PG disconnect (P1138):
 *   - pool.on("error") → process.exit(1). systemd's Restart=on-failure RestartSec=15
 *     handles recovery; on restart, main() re-runs loadActiveAgencies() and
 *     attachListener() per identity, fn_pulse(identity, 'online') fires per
 *     successful re-attach. ~15-30s presence-stale window during the bounce.
 *   - In-process reconnect (the deferred Phase 2 of P1138) would shrink that
 *     window further; the A2A_HOST_PG_RECONNECT_MS flag was removed from
 *     core.runtime_flag in migration 172 because Phase 1 is exit-only.
 *   - Operator changes via SQL `UPDATE core.runtime_flag SET value_jsonb=...`
 *     Live-reload via runtime_config_changed NOTIFY (no restart).
 *
 * Note on universal config integration:
 *   FlagKeys.* entries exist in src/shared/runtime/config-keys.ts but the
 *   resolver's getDbValue() at config.ts:516 currently does `SELECT col FROM
 *   table LIMIT 1` — missing the WHERE name=$1 filter. Until the resolver
 *   is fixed (separate follow-on), this file queries core.runtime_flag
 *   directly via the pool. The FlagKeys entries serve as forward-compat
 *   documentation of the canonical source.
 *
 * Liveness model:
 *   - A2A runtime process aliveness → systemd (Restart=on-failure)
 *   - Per-agency presence → fn_pulse(identity, state) on transitions
 *     ('online' after LISTEN attached, 'offline' on detach)
 *
 * TODO — compat shim retirement:
 *   The per-host presence-refresh timer below exists ONLY because ~10
 *   downstream consumers (agency-resolver dispatchability, maintenance.ts
 *   dormancy sweep, liveness-probe Tier-B, alias-manager, etc.) currently
 *   filter on `agent_registry.last_heartbeat_at < now() - interval '90 s'`.
 *   When those consumers migrate to `agent_registry.presence_state IN
 *   ('online','busy')` the shim retires and this runtime becomes
 *   purely-event-driven. Tracked under P1132 follow-on.
 *
 * TODO — registry polling retirement:
 *   The registry re-read interval below picks up newly-registered local
 *   agencies. When P1129 ships `mcp_ops agency_start`, the operator-
 *   triggered MCP action can emit a `agency_registered` NOTIFY this
 *   runtime LISTENs for; polling retires. Tracked under P1132 follow-on.
 */

import { hostname } from "node:os";
import { Client } from "pg";
import { bootLiaison, type LiaisonBootHandle } from "../src/infra/agency/liaison-boot.ts";
import {
	runLiaisonAgent,
	type LiaisonAgentHandle,
} from "../src/infra/agency/liaison-agent.ts";
import { startLiaisonHub } from "../src/infra/agency/liaison-hub.ts";
import {
	closePool,
	getPool,
	query,
	setPoolLifecycleMode,
} from "../src/infra/postgres/pool.ts";
import { loadRuntimeEnvFile } from "../src/shared/runtime/config.ts";

// Protect the shared pool from stray pool.end() in shared CLI code.
setPoolLifecycleMode("long-running");

// P1138: on terminal PG pool failure, exit(1) so systemd's Restart=on-failure
// brings us back. Without this, broken LISTENs go undetected — agencies show
// presence_state='online' (refreshed by the per-host shim) while inbound
// a2a_msg_<id> NOTIFY events are silently dropped. Pool errors are TERMINAL —
// the pg library handles per-connection retry internally; .on("error") fires
// only when the pool can't recover.
getPool().on("error", (err) => {
	console.error(
		`[a2a-host] FATAL pool error — exiting for systemd restart: ${err.message}`,
	);
	console.error(err.stack ?? "(no stack)");
	process.exit(1);
});

interface AgencyRow {
	agent_identity: string;
	preferred_provider: string;
}

interface AttachedListener {
	identity: string;
	provider: string;
	bootHandle: LiaisonBootHandle;
	agentHandle: LiaisonAgentHandle | null;
	liaisonHub: { stop: () => void } | null;
}

interface RuntimeFlags {
	listenRefreshMs: number;
	shutdownTimeoutMs: number;
	presenceRefreshMs: number;
}

const attached = new Map<string, AttachedListener>();
let shuttingDown = false;
let host = "";
let flags: RuntimeFlags;
let presenceRefreshTimer: ReturnType<typeof setInterval> | null = null;
let registryRefreshTimer: ReturnType<typeof setInterval> | null = null;
let flagsReloadClient: Client | null = null;

/** Load tunables from core.runtime_flag. Throws (no silent defaults) if a row is missing. */
async function loadRuntimeFlags(): Promise<RuntimeFlags> {
	const { rows } = await query<{ name: string; value_jsonb: unknown }>(
		`SELECT name, value_jsonb FROM core.runtime_flag
		 WHERE name IN (
		   'A2A_HOST_LISTEN_REFRESH_MS',
		   'A2A_HOST_SHUTDOWN_TIMEOUT_MS',
		   'A2A_HOST_PRESENCE_REFRESH_MS'
		 )`,
	);
	const byName = new Map(rows.map((r) => [r.name, r.value_jsonb]));
	const need = (k: string): number => {
		const v = byName.get(k);
		if (v === undefined || v === null) {
			throw new Error(
				`[a2a-host] Required runtime flag '${k}' is missing from core.runtime_flag. ` +
					`Apply migration 170-p1132-a2a-host-runtime-flags.sql.`,
			);
		}
		const n = typeof v === "number" ? v : Number(v);
		if (!Number.isFinite(n) || n <= 0) {
			throw new Error(`[a2a-host] Runtime flag '${k}' has invalid value: ${JSON.stringify(v)}`);
		}
		return n;
	};
	return {
		listenRefreshMs:    need("A2A_HOST_LISTEN_REFRESH_MS"),
		shutdownTimeoutMs:  need("A2A_HOST_SHUTDOWN_TIMEOUT_MS"),
		presenceRefreshMs:  need("A2A_HOST_PRESENCE_REFRESH_MS"),
	};
}

/** Subscribe to runtime_config_changed for live flag reload (no restart). */
async function subscribeFlagsReload(): Promise<void> {
	try {
		const databaseUrl = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
		const client = new Client({
			host: process.env.PGHOST ?? databaseUrl?.hostname ?? "127.0.0.1",
			port: Number(process.env.PGPORT_DIRECT ?? databaseUrl?.port ?? process.env.PGPORT ?? 5432),
			user: process.env.PGUSER ?? databaseUrl?.username,
			password: process.env.PGPASSWORD ?? databaseUrl?.password,
			database:
				process.env.PGDATABASE ?? databaseUrl?.pathname.replace(/^\/+/, "") ?? "agenthive",
			application_name: `agenthive-a2a-host-flags-${host}`,
		});
		// P1138: explicit error handler. Without it, when this dedicated Client's
		// connection is terminated (e.g., PG restart, pg_terminate_backend, network
		// drop), pg emits an 'error' event with no listener → Node's default
		// uncaughtException path crashes the process. That accidentally produced the
		// correct outcome (systemd restart), but relied on a brittle default. The
		// explicit handler makes the exit deliberate.
		client.on("error", (err) => {
			console.error(
				`[a2a-host] FATAL flagsReloadClient error — exiting for systemd restart: ${err.message}`,
			);
			console.error(err.stack ?? "(no stack)");
			process.exit(1);
		});
		await client.connect();
		await client.query("LISTEN runtime_config_changed");
		client.on("notification", () => {
			void (async () => {
				try {
					const next = await loadRuntimeFlags();
					const changed = JSON.stringify(next) !== JSON.stringify(flags);
					if (!changed) return;
					console.log(`[a2a-host] runtime flags reloaded: ${JSON.stringify(next)}`);
					const oldPresence = flags.presenceRefreshMs;
					flags = next;
					if (oldPresence !== next.presenceRefreshMs) {
						restartPresenceRefreshTimer();
					}
				} catch (err) {
					console.warn(`[a2a-host] flag reload failed (keeping previous values):`, err);
				}
			})();
		});
		flagsReloadClient = client;
	} catch (err) {
		console.warn(`[a2a-host] failed to subscribe runtime_config_changed (continuing without live reload):`, err);
	}
}

async function loadActiveAgencies(): Promise<AgencyRow[]> {
	// Match what the templated agenthive-agency@<id>.service daemons would have
	// handled. agent_type is loose ('agency' OR 'llm') because some legacy P996
	// names are typed 'llm' but operationally run as agencies (e.g. adam).
	// host_affinity is loose: match this host OR null/empty (treated as "any
	// host" — legacy copilot-agency-gary has empty host_affinity).
	const { rows } = await query<AgencyRow>(
		`SELECT agent_identity, preferred_provider
		   FROM roadmap_workforce.agent_registry
		  WHERE (host_affinity = $1 OR host_affinity IS NULL OR host_affinity = '')
		    AND agent_type    IN ('agency', 'llm')
		    AND status        IN ('active','dormant')
		    AND coalesce(preferred_provider, '') <> ''
		  ORDER BY agent_identity`,
		[host],
	);
	return rows;
}

async function fnPulse(identity: string, state: "online" | "offline" | "away" | "busy"): Promise<void> {
	try {
		await query(`SELECT roadmap.fn_pulse($1, $2)`, [identity, state]);
	} catch (err) {
		console.warn(`[a2a-host] fn_pulse(${identity}, ${state}) failed:`, err);
	}
}

async function attachListener(row: AgencyRow): Promise<void> {
	if (attached.has(row.agent_identity)) return;
	const { agent_identity: identity, preferred_provider: provider } = row;

	console.log(`[a2a-host] starting agency ${identity} (provider=${provider})`);

	let bootHandle: LiaisonBootHandle;
	try {
		bootHandle = await bootLiaison({
			agency_id: identity,
			provider,
			host_id: host,
			display_name: identity,
		});
	} catch (err) {
		console.error(`[a2a-host] bootLiaison failed for ${identity}: ${(err as Error).message}`);
		return;
	}

	let agentHandle: LiaisonAgentHandle | null = null;
	try {
		agentHandle = await runLiaisonAgent({
			identity,
			provider,
			loggerPrefix: `[liaison-agent:${identity}]`,
		});
	} catch (err) {
		console.warn(`[a2a-host] runLiaisonAgent failed for ${identity} (non-fatal): ${(err as Error).message}`);
	}

	// Start the LiaisonHub so this agency consumes liaison_message offer_dispatch
	// rows from the orchestrator. Without this, OfferDispatcher writes pile up
	// unacked (311 backlog observed 2026-05-19); claim_expires_at fires; reaper
	// requeues; dispatch loop never produces a spawn. startLiaisonHub returns
	// immediately; the listener runs in a void run() background promise.
	let liaisonHub: { stop: () => void } | null = null;
	try {
		liaisonHub = startLiaisonHub(identity);
	} catch (err) {
		console.warn(`[a2a-host] startLiaisonHub failed for ${identity} (non-fatal): ${(err as Error).message}`);
	}

	attached.set(identity, { identity, provider, bootHandle, agentHandle, liaisonHub });
	await fnPulse(identity, "online");
	console.log(`[a2a-host] ${identity} online`);
}

async function detachListener(identity: string, state: "offline" | "away" = "offline"): Promise<void> {
	const m = attached.get(identity);
	if (!m) return;
	attached.delete(identity);
	await fnPulse(identity, state);
	if (m.liaisonHub) {
		try {
			m.liaisonHub.stop();
		} catch (err) {
			console.warn(`[a2a-host] ${identity} liaisonHub.stop error:`, err);
		}
	}
	if (m.agentHandle) {
		try {
			await m.agentHandle.stop();
		} catch (err) {
			console.warn(`[a2a-host] ${identity} agentHandle.stop error:`, err);
		}
	}
	try {
		await m.bootHandle.shutdown("normal");
	} catch (err) {
		console.warn(`[a2a-host] ${identity} bootHandle.shutdown error:`, err);
	}
}

/** Re-read agent_registry and start any newly-active local agencies. */
async function refreshRegistry(): Promise<void> {
	if (shuttingDown) return;
	try {
		const rows = await loadActiveAgencies();
		const seenNow = new Set(rows.map((r) => r.agent_identity));
		// Start agencies that appeared
		for (const row of rows) {
			if (!attached.has(row.agent_identity)) {
				await attachListener(row);
			}
		}
		// Stop agencies that disappeared from registry (status flipped away or host_affinity changed)
		for (const identity of Array.from(attached.keys())) {
			if (!seenNow.has(identity)) {
				console.log(`[a2a-host] ${identity} no longer in active set; stopping`);
				await detachListener(identity, "offline");
			}
		}
	} catch (err) {
		console.warn(`[a2a-host] registry refresh failed:`, err);
	}
}

/**
 * Per-host presence refresh: every flags.presenceRefreshMs, iterate attached
 * children and call fn_pulse('online'). fn_pulse updates BOTH presence_state
 * (canonical) AND last_heartbeat_at (transitional).
 *
 * Why this is still load-bearing after the P1132 consumer migration:
 *
 *   - presence_state alone cannot detect an A2A host crash — the column value
 *     stays 'online' even though nothing is updating it.
 *   - last_heartbeat_at going stale IS the crash signal that checkAndMarkDormant
 *     uses (liaison-service.ts) to flip crashed agencies to dormant after 90 s.
 *   - This refresh keeps the heartbeat fresh ONLY while A2A is running. When
 *     A2A dies, heartbeat goes stale → dormancy fires correctly.
 *
 * Retirement gate: a follow-on must replace heartbeat-based crash detection
 * with a stronger signal (e.g. pg_stat_activity check for the LISTEN session
 * 'agenthive-a2a-listen-<identity>'). Until then, this 30 s refresh stays.
 */
function startPresenceRefreshTimer(): void {
	if (presenceRefreshTimer) clearInterval(presenceRefreshTimer);
	presenceRefreshTimer = setInterval(async () => {
		if (shuttingDown) return;
		for (const identity of Array.from(attached.keys())) {
			await fnPulse(identity, "online");
		}
	}, flags.presenceRefreshMs);
}

function restartPresenceRefreshTimer(): void {
	startPresenceRefreshTimer();
}

async function shutdownAll(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	if (presenceRefreshTimer) clearInterval(presenceRefreshTimer);
	if (registryRefreshTimer) clearInterval(registryRefreshTimer);
	if (flagsReloadClient) {
		try { await flagsReloadClient.end(); } catch { /* ignore */ }
		flagsReloadClient = null;
	}
	const identities = Array.from(attached.keys());
	console.log(`[a2a-host] shutdown — stopping ${identities.length} agencies (cap=${flags.shutdownTimeoutMs}ms)`);
	const stopPromises = identities.map((id) => detachListener(id, "offline"));
	await Promise.race([
		Promise.allSettled(stopPromises),
		new Promise<void>((resolve) => setTimeout(resolve, flags.shutdownTimeoutMs)),
	]);
	setPoolLifecycleMode("one-shot");
	try {
		await closePool();
	} catch (err) {
		console.warn(`[a2a-host] closePool error (non-fatal):`, err);
	}
	console.log(`[a2a-host] stopped`);
}

async function main(): Promise<void> {
	// Each attached listener adds one or two `process` exit listeners (via
	// bootLiaison + runLiaisonAgent). With N=17 agencies we exceed Node's
	// default 10-listener warning threshold. Raise the cap explicitly so it
	// doesn't spam the journal on every boot.
	process.setMaxListeners(Math.max(100, process.getMaxListeners()));

	// Tier-0 bootstrap: promote /etc/agenthive/env into process.env if present.
	await loadRuntimeEnvFile();

	host = (process.env.AGENTHIVE_HOST ?? "").trim() || hostname();
	if (!host) {
		throw new Error("[a2a-host] AGENTHIVE_HOST is empty and os.hostname() returned empty — cannot proceed");
	}

	console.log(`[a2a-host] starting on host=${host}`);

	// Force pool init so loadRuntimeFlags has a connection. getPool() lazily inits.
	getPool();

	flags = await loadRuntimeFlags();
	console.log(`[a2a-host] flags: ${JSON.stringify(flags)}`);

	await subscribeFlagsReload();

	const agencies = await loadActiveAgencies();
	if (agencies.length === 0) {
		console.warn(`[a2a-host] no active agencies found for host=${host}; idling`);
	} else {
		console.log(
			`[a2a-host] booting ${agencies.length} agencies: ${agencies.map((a) => a.agent_identity).join(", ")}`,
		);
	}

	// Boot all agencies in parallel.
	await Promise.allSettled(agencies.map((row) => attachListener(row)));
	console.log(`[a2a-host] boot complete — ${attached.size} of ${agencies.length} agencies online`);

	startPresenceRefreshTimer();

	// Periodic registry refresh — pick up newly-registered agencies without restart.
	registryRefreshTimer = setInterval(() => {
		void refreshRegistry();
	}, flags.listenRefreshMs);

	// Wait for SIGTERM / SIGINT.
	await new Promise<void>((resolve) => {
		const onSignal = (sig: string) => {
			console.log(`[a2a-host] ${sig} received`);
			resolve();
		};
		process.once("SIGTERM", () => onSignal("SIGTERM"));
		process.once("SIGINT", () => onSignal("SIGINT"));
	});

	await shutdownAll();
}

main()
	.then(() => {
		// Explicit exit — shared pool keep-alives + leftover handles can otherwise
		// hold the event loop open after shutdownAll() completes.
		process.exit(0);
	})
	.catch(async (err) => {
		console.error(`[a2a-host] fatal:`, err);
		await shutdownAll();
		process.exit(1);
	});
