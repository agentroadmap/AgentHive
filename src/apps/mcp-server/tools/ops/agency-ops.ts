/**
 * P1129 Phase C: agency_start and agency_status MCP handlers.
 *
 * agency_start  — verify registry + env file, start systemd unit, poll 30s for active
 * agency_status — query v_agency_status + agency_liaison_session for full snapshot
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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

	// 2. Verify systemd env file
	const envFile = `/etc/agenthive/agency-${agency_id}.env`;
	if (!existsSync(envFile)) {
		return err(
			"no_env_file",
			`Env file ${envFile} not found. Create it with AGENCY_ID, MCP_URL, and model env vars before starting.`,
			{ agency_id, env_file: envFile },
		);
	}

	// 3. Start the systemd unit
	const unitName = `agenthive-agency@${agency_id}.service`;
	const startResult = spawnSync("sudo", ["systemctl", "start", unitName], { timeout: 15_000 });
	if (startResult.status !== 0) {
		const stderr = startResult.stderr?.toString().trim() ?? "";
		return err(
			"start_failed",
			`systemctl start ${unitName} exited ${startResult.status}: ${stderr}`,
			{ agency_id, unit: unitName },
		);
	}

	// 4. Poll up to 30s for active
	const deadline = Date.now() + 30_000;
	let active = false;
	while (Date.now() < deadline) {
		const isActive = spawnSync("systemctl", ["is-active", "--quiet", unitName], { timeout: 5_000 });
		if (isActive.status === 0) {
			active = true;
			break;
		}
		await new Promise((r) => setTimeout(r, 2_000));
	}

	return ok({
		agency_id,
		unit: unitName,
		started: true,
		active,
		note: active ? "Unit is active." : "Unit started but did not reach active within 30s — check journalctl.",
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
