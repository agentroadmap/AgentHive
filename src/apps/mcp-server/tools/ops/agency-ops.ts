/**
 * agency_start and agency_status MCP handlers.
 *
 * agency_start  — DB-only activation. Per-agency systemd units are RETIRED
 *                 (operator policy: the liaison is a cold-wake AI agent, not a
 *                 service; the universal `agenthive-a2a-host` floor discovers
 *                 registered agencies from the DB and attaches their LISTEN
 *                 session — there is no per-agency `agenthive-agency@<id>` unit).
 *                 This handler verifies registration and reports presence.
 * agency_status — query v_agency_status + agency_liaison_session for full snapshot
 */

import { query } from "../../../../postgres/pool.ts";
import type { CallToolResult } from "../../types.ts";

function ok(data: unknown): CallToolResult {
	return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(code: string, message: string, extra: Record<string, unknown> = {}): CallToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify({ error: code, message, ...extra }, null, 2) }],
		isError: true,
	};
}

// ---------------------------------------------------------------------------
// agency_start
// ---------------------------------------------------------------------------

export async function handleAgencyStart(args: {
	agency_id: string;
}): Promise<CallToolResult> {
	const { agency_id } = args;

	// 1. Verify agency exists in agent_registry
	const reg = await query(
		`SELECT agent_identity, agent_cli, status FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
		[agency_id],
	);
	if (!reg.rows.length) {
		return err(
			"not_registered",
			`Agency '${agency_id}' is not in agent_registry. Call mcp_agent action=register first.`,
			{ agency_id },
		);
	}

	// 2. Activation is DB-only. Per-agency systemd units (agenthive-agency@<id>)
	//    are retired: the universal `agenthive-a2a-host` floor discovers any
	//    registered agency from the DB on its next refresh (~60s) and attaches a
	//    LISTEN session; the AI liaison is cold-wakeable, not a service. There is
	//    nothing to `systemctl start` here.
	const status = await query(
		`SELECT status, presence_state, dispatchable, liveness_state, last_heartbeat_at
		 FROM roadmap.v_agency_status
		 WHERE agency_id = $1`,
		[agency_id],
	);
	const s = status.rows[0] ?? null;

	return ok({
		agency_id,
		registered: true,
		started: true,
		mechanism: "db-only",
		dispatchable: s?.dispatchable ?? false,
		presence_state: s?.presence_state ?? null,
		liveness_state: s?.liveness_state ?? null,
		last_heartbeat_at: s?.last_heartbeat_at ?? null,
		note:
			"Agency is registered. Dispatch is handled by the universal agenthive-a2a-host floor " +
			"(DB-driven discovery, ~60s to attach a LISTEN session) — no per-agency systemd unit is " +
			"started. If the agency needs an AI liaison, cold-wake it; do not install a service.",
	});
}

// ---------------------------------------------------------------------------
// agency_status
// ---------------------------------------------------------------------------

export async function handleAgencyStatus(args: {
	agency_id?: string;
}): Promise<CallToolResult> {
	try {
		if (args.agency_id) {
			const [statusRes, sessionRes] = await Promise.all([
				query(
					`SELECT agency_id, display_name, status, presence_state, silence_seconds,
					        dispatchable, liveness_state, last_heartbeat_at, host_id, provider
					 FROM roadmap.v_agency_status
					 WHERE agency_id = $1`,
					[args.agency_id],
				),
				query(
					`SELECT session_id, liaison_pid, liaison_host, started_at
					 FROM roadmap.agency_liaison_session
					 WHERE agency_id = $1 AND ended_at IS NULL
					 LIMIT 1`,
					[args.agency_id],
				),
			]);

			if (!statusRes.rows.length) {
				return err(
					"not_found",
					`No agency found with id '${args.agency_id}'.`,
					{ agency_id: args.agency_id },
				);
			}

			const s = statusRes.rows[0];
			const sess = sessionRes.rows[0] ?? null;

			return ok({
				agency_id: s.agency_id,
				display_name: s.display_name,
				status: s.status,
				presence_state: s.presence_state,
				silence_seconds: s.silence_seconds,
				dispatchable: s.dispatchable,
				liveness_state: s.liveness_state,
				last_heartbeat_at: s.last_heartbeat_at,
				host_id: s.host_id,
				provider: s.provider,
				is_listening: !!sess,
				session_id: sess?.session_id ?? null,
				liaison_pid: sess?.liaison_pid ?? null,
				session_started_at: sess?.started_at ?? null,
			});
		}

		// List all agencies
		const { rows } = await query(
			`SELECT agency_id, display_name, status, presence_state,
			        dispatchable, liveness_state, last_heartbeat_at, provider
			 FROM roadmap.v_agency_status
			 ORDER BY agency_id`,
		);
		return ok({ agencies: rows });
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return err("status_failed", message);
	}
}
