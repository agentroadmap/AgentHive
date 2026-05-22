/**
 * P1129: Agency lifecycle MCP tools — agency_start / agency_status.
 *
 * Allows an agency to start its liaison process (systemd) and query live
 * status without requiring operator-level SSH access.
 *
 * Security model:
 *  - agency_start runs systemctl enable+start via sudo (sudoers must allow
 *    the mcp-server process user to manage agenthive-agency@.service).
 *  - agency_status is read-only (systemctl is-active + DB last_seen_at).
 *  - Both verify the identity exists in agent_registry with agent_type='agency'
 *    before touching systemd.
 */

import { spawnSync } from "node:child_process";
import { query } from "../../../../postgres/pool.ts";

export interface AgencyStartResult {
	ok: boolean;
	identity: string;
	systemd_unit: string;
	message: string;
}

export interface AgencyStatusResult {
	identity: string;
	systemd_unit: string;
	systemd_active: string;
	last_seen_at: string | null;
	registry_status: string | null;
}

export class AgencyOpsHandler {
	private unitName(identity: string): string {
		return `agenthive-agency@${identity}.service`;
	}

	async agencyStart(args: {
		identity: string;
	}): Promise<AgencyStartResult> {
		const identity = args.identity.trim();
		const unit = this.unitName(identity);

		// Verify registry entry exists and is an agency
		const reg = await query(
			`SELECT agent_type, status FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
			[identity],
		);
		if (!reg.rows.length) {
			return {
				ok: false,
				identity,
				systemd_unit: unit,
				message: `Agent '${identity}' not found in agent_registry. Call mcp_agent action='pg_register' first.`,
			};
		}
		if (reg.rows[0].agent_type !== "agency") {
			return {
				ok: false,
				identity,
				systemd_unit: unit,
				message: `Agent '${identity}' has agent_type='${reg.rows[0].agent_type}', not 'agency'. Only agency-type agents can be started via this tool.`,
			};
		}

		// Enable + start the systemd service
		const result = spawnSync("sudo", ["systemctl", "enable", "--now", unit], {
			timeout: 15000,
			encoding: "utf-8",
		});
		const output = ((result.stdout as string) || "") + ((result.stderr as string) || "");

		if (result.status !== 0) {
			return {
				ok: false,
				identity,
				systemd_unit: unit,
				message: `systemctl enable --now ${unit} failed (exit ${result.status}): ${output.slice(0, 400)}`,
			};
		}

		return {
			ok: true,
			identity,
			systemd_unit: unit,
			message: `${unit} enabled and started successfully.`,
		};
	}

	async agencyStatus(args: {
		identity: string;
	}): Promise<AgencyStatusResult> {
		const identity = args.identity.trim();
		const unit = this.unitName(identity);

		// Query systemd and DB in parallel
		const [isActiveResult, regResult] = await Promise.all([
			Promise.resolve(
				spawnSync("systemctl", ["is-active", unit], {
					timeout: 5000,
					encoding: "utf-8",
				}),
			),
			query(
				`SELECT status, last_seen_at FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
				[identity],
			),
		]);

		const systemdActive = ((isActiveResult.stdout as string) || "").trim() || "unknown";
		const row = regResult.rows[0] ?? null;

		return {
			identity,
			systemd_unit: unit,
			systemd_active: systemdActive,
			last_seen_at: row?.last_seen_at ?? null,
			registry_status: row?.status ?? null,
		};
	}
}
