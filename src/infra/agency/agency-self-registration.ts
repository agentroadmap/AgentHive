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
import { pulseHeartbeat } from "../pulse/heartbeat.ts";
import { query } from "../postgres/pool.ts";
import { startLiaisonHub } from "./liaison-hub.ts";
import { AgencyAlreadyActive } from "./errors.ts";
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

	// 1. Upsert agent_registry. Mirrors `roadmap state-machine register`
	// (src/apps/commands/state-machine.ts:208) so operators and self-reg agree
	// on the row shape.
	const { rows: regRows } = await query<{ id: number }>(
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
	const agentRegistryId = regRows[0]?.id;
	if (!agentRegistryId) {
		throw new Error(
			`[selfRegisterAgency] agent_registry upsert returned no row for ${agencyId}`,
		);
	}

	// 2. Upsert capabilities (no-op if empty).
	if (capabilities.length > 0) {
		await query(
			`INSERT INTO roadmap_workforce.agent_capability (agent_id, capability)
			 SELECT $1, unnest($2::text[])
			 ON CONFLICT DO NOTHING`,
			[agentRegistryId, capabilities],
		);
	}

	// 3. P912 AC-3: provider_registry opt-in is explicit. Empty projectIds
	// means "registered but not dispatchable for any project". A future
	// agency_join_project MCP action calls back into the same INSERT shape
	// without re-running the registry/session bootstrap.
	if (opts.projectIds && opts.projectIds.length > 0) {
		await query(
			`INSERT INTO roadmap_workforce.provider_registry
			   (agency_id, project_id, squad_name, is_active)
			 SELECT $1, unnest($2::bigint[]), NULL, true
			 ON CONFLICT (agency_id, project_id, squad_name) DO UPDATE SET
			   is_active = true`,
			[agentRegistryId, opts.projectIds],
		);
	}

	// 4. Open liaison session. liaisonRegister itself upserts roadmap.agency.
	// P921 AC-5: wrap in try/catch to detect unique violation on idx_agency_session_one_active.
	let reg;
	try {
		reg = await liaisonRegister({
			agency_id: agencyId,
			display_name: displayName,
			provider: opts.provider,
			host_id: hostId,
			capabilities,
			capacity_envelope: opts.capacityEnvelope,
			metadata: { ...(opts.metadata ?? {}), pid: process.pid },
		});
	} catch (err) {
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
	}
	const sessionId = reg.session_id;
	logger.log(
		`[AgencySelfReg] ${agencyId} session=${sessionId} status=${reg.status}`,
	);

	// 5. Start the offer_dispatch hub IN-PROCESS — the missing piece in the
	// pre-P912 start-agency.ts. Without this, offer_dispatch downlinks pile up
	// unacked.
	const hub = startLiaisonHub(agencyId);
	logger.log(
		`[AgencySelfReg] ${agencyId} hub started — listening for offer_dispatch + assistance_request + liaison_pong`,
	);

	// 6. Heartbeat: liaisonHeartbeat (DB) + pulseHeartbeat (fleet observability).
	const heartbeatTimer = setInterval(async () => {
		try {
			await liaisonHeartbeat({ session_id: sessionId, status: "active" });
		} catch (err) {
			logger.warn(
				`[AgencySelfReg] ${agencyId} heartbeat error: ${err instanceof Error ? err.message : err}`,
			);
		}
		void pulseHeartbeat(agencyId, { currentTask: "agency-runtime" }).catch(
			(e) =>
				logger.warn(
					`[AgencySelfReg] ${agencyId} pulse heartbeat failed: ${e instanceof Error ? e.message : e}`,
				),
		);
	}, heartbeatMs);

	// Emit pulse immediately so the agency is visible without waiting heartbeat_ms.
	void pulseHeartbeat(agencyId, { currentTask: "starting" }).catch((e) =>
		logger.warn(
			`[AgencySelfReg] ${agencyId} initial pulse heartbeat failed: ${e instanceof Error ? e.message : e}`,
		),
	);

	// 7. Dormancy sweep — marks agencies silent > 90 s as dormant. Cheap to run
	// from any agency process; idempotent across the fleet.
	const dormancyTimer = setInterval(async () => {
		try {
			const count = await checkAndMarkDormant();
			if (count > 0) {
				logger.log(
					`[AgencySelfReg] ${agencyId} dormancy sweep: ${count} marked dormant`,
				);
			}
		} catch (err) {
			logger.warn(
				`[AgencySelfReg] ${agencyId} dormancy sweep error: ${err instanceof Error ? err.message : err}`,
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
				`[AgencySelfReg] ${agencyId} hub.stop error: ${err instanceof Error ? err.message : err}`,
			);
		}
		try {
			await endLiaisonSession(sessionId, reason);
			logger.log(
				`[AgencySelfReg] ${agencyId} session=${sessionId} ended (reason=${reason})`,
			);
		} catch (err) {
			logger.error(
				`[AgencySelfReg] ${agencyId} endLiaisonSession error: ${err instanceof Error ? err.message : err}`,
			);
		}
	};

	return { sessionId, agentRegistryId, stop };
}
