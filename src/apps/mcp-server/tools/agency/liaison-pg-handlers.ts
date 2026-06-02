/**
 * P917: Agency lifecycle MCP handlers.
 * Four tools bridging roadmap.agency (liaison layer) to the consolidated router.
 */

import {
	getAgencyStatus,
	liaisonRegister,
} from "../../../../infra/agency/liaison-service.js";
import { query } from "../../../../infra/postgres/pool.js";
import type { CallToolResult } from "../../types.ts";

export async function agencyBootstrapHandler(args: {
	agency_id: string;
	display_name: string;
	provider: string;
	host_id: string;
	capabilities?: string[];
	capacity_envelope?: Record<string, unknown>;
	public_key?: string;
	metadata?: Record<string, unknown>;
}): Promise<CallToolResult> {
	try {
		const result = await liaisonRegister(args);
		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
		};
	} catch (err) {
		return {
			content: [{ type: "text", text: `❌ ${(err as Error).message}` }],
		};
	}
}

export async function agencyJoinProjectHandler(args: {
	agency_id: string;
	project_name: string;
	capabilities?: string[];
}): Promise<CallToolResult> {
	try {
		const proj = await query(
			`SELECT id FROM roadmap_workforce.projects WHERE name = $1`,
			[args.project_name],
		);
		if (proj.rows.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							error: "project_not_found",
							project_name: args.project_name,
						}),
					},
				],
			};
		}
		const projectId = proj.rows[0].id;

		await query(
			`SELECT roadmap_workforce.fn_offer_provider_heartbeat($1, $2, NULL, $3::jsonb)`,
			[args.agency_id, projectId, JSON.stringify(args.capabilities ?? [])],
		);
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						ok: true,
						agency_id: args.agency_id,
						project_id: projectId,
					}),
				},
			],
		};
	} catch (err: any) {
		// Bridge gap: agent_registry row absent (FK violation code 23503)
		if (err.code === "23503") {
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							error: "agent_registry_not_found",
							message:
								"Agency must call agency_register (workforce) first to bridge old/new systems",
							agency_id: args.agency_id,
						}),
					},
				],
			};
		}
		return { content: [{ type: "text", text: `❌ ${err.message}` }] };
	}
}

export async function agencyLeaveProjectHandler(args: {
	agency_id: string;
	project_name: string;
}): Promise<CallToolResult> {
	try {
		const proj = await query(
			`SELECT id FROM roadmap_workforce.projects WHERE name = $1`,
			[args.project_name],
		);
		if (proj.rows.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({ error: "project_not_found" }),
					},
				],
			};
		}
		const projectId = proj.rows[0].id;

		const result = await query(
			`UPDATE roadmap_workforce.provider_registry
			 SET status = 'paused'
			 WHERE agency_identity = $1 AND project_id = $2
			 RETURNING id`,
			[args.agency_id, projectId],
		);
		if (result.rowCount === 0) {
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							error: "not_joined",
							agency_id: args.agency_id,
							project_id: projectId,
						}),
					},
				],
			};
		}
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({ ok: true, paused: result.rowCount }),
				},
			],
		};
	} catch (err: any) {
		return { content: [{ type: "text", text: `❌ ${err.message}` }] };
	}
}

export async function agencyLiaisonStatusHandler(args: {
	agency_id: string;
}): Promise<CallToolResult> {
	try {
		const status = await getAgencyStatus(args.agency_id);
		if (!status) {
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							error: "not_found",
							agency_id: args.agency_id,
						}),
					},
				],
			};
		}
		return {
			content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
		};
	} catch (err: any) {
		return { content: [{ type: "text", text: `❌ ${err.message}` }] };
	}
}
