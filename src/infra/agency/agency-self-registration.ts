/**
 * Agency self-registration — P912 shared lifecycle for any provider runtime.
 *
 * Replaces the duplicated registration prologue across start-agency.ts,
 * start-copilot-agency.ts, and the now-obsolete start-liaison.ts. A provider
 * runtime calls selfRegisterAgency() once at boot and gets back a shutdown
 * handle. Every step is idempotent.
 *
 * What this module owns (P912 AC-2/AC-4):
 *   1. Upsert roadmap_workforce.agent_registry  (identity + agent_type='agency').
 *   2. Upsert roadmap_workforce.agent_capability (capabilities, if any).
 *   3. Optional: upsert roadmap_workforce.provider_registry rows for declared
 *      project participation (P912 AC-3 — explicit opt-in only).
 *   4. Open a liaison session via liaisonRegister (which itself upserts
 *      roadmap.agency).
 *   5. Start the offer_dispatch hub via startLiaisonHub(agency_id).
 *   6. Schedule heartbeat (30s) + dormancy sweep (60s).
 *   7. Emit pulseHeartbeat for fleet observability.
 *
 * What it does NOT own:
 *   - The legacy OfferProvider pull-claim loop. P912 AC-7 retires it; provider
 *     runtimes that previously instantiated OfferProvider should drop that
 *     instantiation when migrating to this module.
 *   - Provider-specific A2A reply loops (runLiaisonAgent). Those are layered
 *     on top by the runtime that wants inbox-reply LLM behavior.
 *
 * Shutdown contract: stop() clears both timers, stops the hub, ends the
 * liaison session with the supplied reason (default "operator"), and drains
 * any in-flight tracked work.
 */

import { hostname } from "node:os";
import type { PoolClient } from "pg";
import { pulseHeartbeat } from "../pulse/heartbeat.ts";
import { getPool, query } from "../postgres/pool.ts";
import { startLiaisonHub } from "./liaison-hub.ts";
import { AgencyAlreadyActive } from "./errors.ts";
import { assignDisplayAlias } from "../../core/identity/agent-registry/agent-name.ts";
import { claimDisplayAlias } from "../../core/identity/agent-registry/alias-manager.ts";
import {
	checkAndMarkDormant,
	endLiaisonSession,
	liaisonHeartbeat,
	liaisonRegister,
} from "./liaison-service.ts";

export interface AgencySelfRegistrationOptions {
	/** e.g. "claude/agency-bot". Identity prefix should be the provider. */
	agencyId: string;
	/** Resolved provider — "claude", "codex", "copilot", etc. */
	provider: string;
	/** Capabilities exposed by this agency (e.g. ["code", "design"]). */
	capabilities?: string[];
	/** Optional explicit display name; defaults to last "/"-segment of agencyId. */
	displayName?: string;
	/** Host identity — defaults to OS hostname. */
	hostId?: string;
	/** Optional capacity envelope for liaison heartbeat. */
	capacityEnvelope?: Record<string, unknown>;
	/** Optional metadata attached to the agency row. */
	metadata?: Record<string, unknown>;
	/**
	 * Project IDs to opt into via roadmap_workforce.provider_registry. Empty
	 * means "agency is registered but not yet eligible for any project's
	 * dispatch". P912 AC-3: registration alone is not project participation.
	 */
	projectIds?: number[];
	/** Heartbeat cadence in ms (default 30 s). */
	heartbeatMs?: number;
	/** Dormancy sweep cadence in ms (default 60 s). */
	dormancySweepMs?: number;
	/** Optional logger; defaults to console. */
	logger?: Pick<Console, "log" | "warn" | "error">;
}

export interface AgencySelfRegistrationHandle {
	/** Session ID returned by liaisonRegister. */
	sessionId: string;
	/** Numeric agent_registry.id (useful for capability writes outside this module). */
	agentRegistryId: number;
	/** P919 AC-12: Tier 1 display alias if one was claimed (e.g. "Gemini-Bot"),
	 *  null when registration ran without resolving a host or another active row
	 *  already holds the alias. The agency is fully functional either way; this
	 *  is a UI/log label only. */
	displayAlias: string | null;
	/** Stop hub + timers + end session. Idempotent. */
	stop: (
		reason?: "normal" | "crash" | "operator" | "throttle",
	) => Promise<void>;
}

// Re-export AgencyAlreadyActive for consumers (e.g. start-agency.ts).
export { AgencyAlreadyActive } from "./errors.ts";

/**
 * Run the full agency boot prologue. Returns a handle the caller wires into
 * its SIGTERM/SIGINT path. Throws on fatal config errors (e.g. missing
 * agencyId); transient DB errors during heartbeat/dormancy are logged but
 * don't crash the process.
 */
export async function selfRegisterAgency(
	opts: AgencySelfRegistrationOptions,
): Promise<AgencySelfRegistrationHandle> {
	const logger = opts.logger ?? console;
	const agencyId = opts.agencyId;
	if (!agencyId?.trim()) throw new Error("agencyId is required");
	if (!opts.provider?.trim()) throw new Error("provider is required");

	const displayName =
		opts.displayName ?? agencyId.split("/").slice(-1)[0] ?? agencyId;
	const hostId = opts.hostId ?? hostname();
	const capabilities = opts.capabilities ?? [];
	const heartbeatMs = opts.heartbeatMs ?? 30_000;
	const dormancySweepMs = opts.dormancySweepMs ?? 60_000;

	// P913: wrap registry/capabilities/provider_registry/liaisonRegister in ONE
	// transaction with an identity-keyed advisory lock. The lock serializes
	// concurrent calls for the same agencyId without blocking other agencies.
	// Different agencyIds hash to different keys and proceed in parallel.
	const pool = getPool();
	const client: PoolClient = await pool.connect();
	let reg;
	let agentRegistryId: number;
	let resolvedAlias: string | null = null;
	try {
		await client.query("BEGIN");

		// 0. Advisory lock keyed on identity — concurrent same-identity boots queue here.
		await client.query(
			`SELECT pg_advisory_xact_lock(hashtext('selfRegisterAgency:' || $1)::int4)`,
			[agencyId],
		);

		// 1. Upsert agent_registry. Mirrors `roadmap state-machine register`
		// (src/apps/commands/state-machine.ts:208) so operators and self-reg agree
		// on the row shape.
		const regRowsRes = await client.query<{ id: number }>(
			`INSERT INTO roadmap_workforce.agent_registry
			   (agent_identity, agent_type, status, preferred_provider)
			 VALUES ($1, 'agency', 'active', $2)
			 ON CONFLICT (agent_identity) DO UPDATE SET
			   agent_type = 'agency',
			   status = 'active',
			   preferred_provider = EXCLUDED.preferred_provider,
			   updated_at = now()
			 RETURNING id`,
			[agencyId, opts.provider],
		);
		const newId = regRowsRes.rows[0]?.id;
		if (!newId) {
			throw new Error(
				`[selfRegisterAgency] agent_registry upsert returned no row for ${agencyId}`,
			);
		}
		agentRegistryId = newId;

		// 2. Upsert capabilities (no-op if empty).
		if (capabilities.length > 0) {
			await client.query(
				`INSERT INTO roadmap_workforce.agent_capability (agent_id, capability)
				 SELECT $1, unnest($2::text[])
				 ON CONFLICT DO NOTHING`,
				[agentRegistryId, capabilities],
			);
		}

		// P919 AC-12: Tier 1 display alias for the agency liaison —
		// "{Provider}-{Host}" (e.g. "Gemini-Bot"). assignDisplayAlias is pure;
		// the partial unique index on (display_alias) WHERE status='active'
		// enforces "one active alias per name". On collision (another agency
		// already holds the alias on an active row), we log and continue with
		// display_alias=NULL — registration must not fail because of UI label
		// contention; operators can clear via mcp_agent action=force_release_alias.
		const tier1Alias = assignDisplayAlias(
			opts.provider,
			pascalCaseHost(hostId),
			undefined,
			"0",
		);
		if (tier1Alias) {
			const claim = await claimDisplayAlias(agentRegistryId, tier1Alias, {
				client,
				tier: 1,
			});
			if (!claim.claimed) {
				logger.warn(
					`[selfRegisterAgency] ${agencyId} could not claim alias '${tier1Alias}': ${claim.reason} — proceeding without alias`,
				);
				resolvedAlias = null;
			} else {
				resolvedAlias = tier1Alias;
			}
		}

		// 3. P912 AC-3: provider_registry opt-in is explicit. Empty projectIds
		// means "registered but not dispatchable for any project". A future
		// agency_join_project MCP action calls back into the same INSERT shape
		// without re-running the registry/session bootstrap.
		// P913 bug-1 fix: provider_registry has BOTH agency_id (bigint FK) AND
		// agency_identity (text NOT NULL). The previous shape omitted
		// agency_identity and would fail the NOT NULL constraint when projectIds
		// was non-empty.
		if (opts.projectIds && opts.projectIds.length > 0) {
			await client.query(
				`INSERT INTO roadmap_workforce.provider_registry
				   (agency_id, agency_identity, project_id, squad_name, is_active)
				 SELECT $1, $2, unnest($3::bigint[]), NULL, true
				 ON CONFLICT (agency_id, project_id, squad_name) DO UPDATE SET
				   is_active = true`,
				[agentRegistryId, agencyId, opts.projectIds],
			);
		}

		// 4. Open liaison session. liaisonRegister itself upserts roadmap.agency.
		// P921: detect unique-violation on idx_agency_session_one_active and throw
		// the typed AgencyAlreadyActive. P913: pass the same client so the upsert
		// + session insert participate in this transaction.
		reg = await liaisonRegister(
			{
				agency_id: agencyId,
				display_name: displayName,
				provider: opts.provider,
				host_id: hostId,
				capabilities,
				capacity_envelope: opts.capacityEnvelope,
				metadata: { ...(opts.metadata ?? {}), pid: process.pid },
			},
			client,
		);

		await client.query("COMMIT");
	} catch (err) {
		try {
			await client.query("ROLLBACK");
		} catch (rollbackErr) {
			logger.warn(
				`[selfRegisterAgency] ROLLBACK failed for ${agencyId}: ${rollbackErr instanceof Error ? rollbackErr.message : rollbackErr}`,
			);
		}
		// Check if this is a unique constraint violation on idx_agency_session_one_active.
		// pg's DatabaseError carries SQLSTATE in err.code and the constraint name in
		// err.constraint (or in the message text). Match on either shape — the literal
		// "23505" is rarely embedded in the human-readable message.
		const pgErr = err as { code?: string; constraint?: string } & Error;
		const isUniqueViolation = pgErr.code === "23505";
		const matchesIndex =
			pgErr.constraint === "idx_agency_session_one_active" ||
			(pgErr.message && pgErr.message.includes("idx_agency_session_one_active"));
		if (err instanceof Error && isUniqueViolation && matchesIndex) {
			// P921 AC-5: SELECT existing session and throw typed AgencyAlreadyActive.
			const existingRes = await query<{
				session_id: string;
				liaison_pid: number | null;
				liaison_host: string | null;
			}>(
				`SELECT session_id, liaison_pid, liaison_host
				 FROM roadmap.agency_liaison_session
				 WHERE agency_id = $1 AND ended_at IS NULL
				 LIMIT 1`,
				[agencyId],
			);
			const existing = existingRes.rows[0];
			logger.log(
				`[selfRegisterAgency] CONFLICT: active session for ${agencyId} — ` +
					`session=${existing?.session_id} pid=${existing?.liaison_pid} host=${existing?.liaison_host}`,
			);
			throw new AgencyAlreadyActive(
				agencyId,
				existing?.session_id,
				existing?.liaison_pid ?? undefined,
				existing?.liaison_host ?? undefined,
			);
		}
		throw err;
	} finally {
		client.release();
	}
	const sessionId = reg.session_id;
	// P919 AC-13: prefer the display alias in log lines when claimed.
	// `displayLabel` reads "Gemini-Bot (gemini/agency-bot)" when an alias is
	// in play, falling back to the bare identity when not.
	const displayLabel = resolvedAlias
		? `${resolvedAlias} (${agencyId})`
		: agencyId;
	logger.log(
		`[AgencySelfReg] ${displayLabel} session=${sessionId} status=${reg.status}`,
	);

	// 5. Start the offer_dispatch hub IN-PROCESS — the missing piece in the
	// pre-P912 start-agency.ts. Without this, offer_dispatch downlinks pile up
	// unacked.
	const hub = startLiaisonHub(agencyId);
	logger.log(
		`[AgencySelfReg] ${displayLabel} hub started — listening for offer_dispatch + assistance_request + liaison_pong`,
	);

	// 6. Heartbeat: liaisonHeartbeat (DB) + pulseHeartbeat (fleet observability).
	const heartbeatTimer = setInterval(async () => {
		try {
			await liaisonHeartbeat({ session_id: sessionId, status: "active" });
		} catch (err) {
			logger.warn(
				`[AgencySelfReg] ${displayLabel} heartbeat error: ${err instanceof Error ? err.message : err}`,
			);
		}
		void pulseHeartbeat(agencyId, { currentTask: "agency-runtime" }).catch(
			(e) =>
				logger.warn(
					`[AgencySelfReg] ${displayLabel} pulse heartbeat failed: ${e instanceof Error ? e.message : e}`,
				),
		);
	}, heartbeatMs);

	// Emit pulse immediately so the agency is visible without waiting heartbeat_ms.
	void pulseHeartbeat(agencyId, { currentTask: "starting" }).catch((e) =>
		logger.warn(
			`[AgencySelfReg] ${displayLabel} initial pulse heartbeat failed: ${e instanceof Error ? e.message : e}`,
		),
	);

	// 7. Dormancy sweep — marks agencies silent > 90 s as dormant. Cheap to run
	// from any agency process; idempotent across the fleet.
	const dormancyTimer = setInterval(async () => {
		try {
			const count = await checkAndMarkDormant();
			if (count > 0) {
				logger.log(
					`[AgencySelfReg] ${displayLabel} dormancy sweep: ${count} marked dormant`,
				);
			}
		} catch (err) {
			logger.warn(
				`[AgencySelfReg] ${displayLabel} dormancy sweep error: ${err instanceof Error ? err.message : err}`,
			);
		}
	}, dormancySweepMs);

	let stopped = false;
	const stop = async (
		reason: "normal" | "crash" | "operator" | "throttle" = "operator",
	): Promise<void> => {
		if (stopped) return;
		stopped = true;
		clearInterval(heartbeatTimer);
		clearInterval(dormancyTimer);
		try {
			hub.stop();
		} catch (err) {
			logger.warn(
				`[AgencySelfReg] ${displayLabel} hub.stop error: ${err instanceof Error ? err.message : err}`,
			);
		}
		try {
			await endLiaisonSession(sessionId, reason);
			logger.log(
				`[AgencySelfReg] ${displayLabel} session=${sessionId} ended (reason=${reason})`,
			);
		} catch (err) {
			logger.error(
				`[AgencySelfReg] ${displayLabel} endLiaisonSession error: ${err instanceof Error ? err.message : err}`,
			);
		}
	};

	return { sessionId, agentRegistryId, displayAlias: resolvedAlias, stop };
}

/**
 * P919 AC-12: Convert a host token into PascalCase for the Tier 1 alias.
 *   "bot" → "Bot"
 *   "hermes-srv" → "HermesSrv"
 *   "agency-bot" → "AgencyBot" (rare; AGENTHIVE_HOST is normally a bare host)
 */
function pascalCaseHost(host: string): string {
	return host
		.split(/[-_]+/)
		.filter(Boolean)
		.map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase())
		.join("");
}
