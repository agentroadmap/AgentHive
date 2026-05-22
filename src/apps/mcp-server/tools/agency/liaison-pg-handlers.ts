/**
 * P917: Agency lifecycle MCP handlers — four actions that bridge the new
 * liaison system (roadmap.agency / agency_liaison_session) with the legacy
 * workforce dispatch system (roadmap_workforce.agent_registry / provider_registry).
 *
 * agency_bootstrap     → liaisonRegister()
 * agency_join_project  → fn_offer_provider_heartbeat() upsert
 * agency_leave_project → provider_registry status='paused'
 * agency_liaison_status → v_agency_status query
 */

import {
	liaisonRegister,
	liaisonResume,
	getAgencyStatus,
	listDispatchableAgencies,
} from "../../../../infra/agency/liaison-service.ts";
import { query } from "../../../../infra/postgres/pool.ts";
import type { CallToolResult } from "../../types.ts";

function ok(data: unknown): CallToolResult {
	return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(
	code: string,
	extra: Record<string, unknown>,
	message: string,
): CallToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify({ error: code, ...extra, message }, null, 2) }],
		isError: true,
	};
}

// ---------------------------------------------------------------------------
// agency_bootstrap
// ---------------------------------------------------------------------------

export interface AgencyBootstrapInput {
	agency_id: string;
	display_name: string;
	provider: string;
	host_id: string;
	capabilities?: string[];
	capacity_envelope?: Record<string, unknown>;
	public_key?: string;
	metadata?: Record<string, unknown>;
}

export async function handleAgencyBootstrap(
	input: AgencyBootstrapInput,
): Promise<CallToolResult> {
	try {
		const result = await liaisonRegister({
			agency_id: input.agency_id,
			display_name: input.display_name,
			provider: input.provider,
			host_id: input.host_id,
			capabilities: input.capabilities,
			capacity_envelope: input.capacity_envelope,
			public_key: input.public_key,
			metadata: input.metadata,
		});
		return ok(result);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return err("bootstrap_failed", { agency_id: input.agency_id }, message);
	}
}

// ---------------------------------------------------------------------------
// agency_join_project
// ---------------------------------------------------------------------------

export interface AgencyJoinProjectInput {
	agency_id: string;
	project_slug: string;
	capabilities?: string[];
}

export async function handleAgencyJoinProject(
	input: AgencyJoinProjectInput,
): Promise<CallToolResult> {
	try {
		// 1. Verify agency exists in new liaison table
		const agencyCheck = await query(
			`SELECT agency_id FROM roadmap.agency WHERE agency_id = $1`,
			[input.agency_id],
		);
		if (agencyCheck.rows.length === 0) {
			return err(
				"agency_not_found",
				{ agency_id: input.agency_id },
				`Agency '${input.agency_id}' is not registered. Call agency_bootstrap first.`,
			);
		}

		// 2. Resolve project_id from slug or name
		const projectCheck = await query<{ id: string }>(
			`SELECT id FROM roadmap_workforce.projects
			 WHERE slug = $1 OR name = $1
			 LIMIT 1`,
			[input.project_slug],
		);
		if (projectCheck.rows.length === 0) {
			return err(
				"project_not_found",
				{ project_slug: input.project_slug },
				`Project '${input.project_slug}' not found.`,
			);
		}
		const projectId = BigInt(projectCheck.rows[0].id);

		// 3. Call fn_offer_provider_heartbeat — UPSERT-inserts provider_registry
		const capabilitiesJsonb = JSON.stringify(
			input.capabilities && input.capabilities.length > 0
				? { tags: input.capabilities }
				: {},
		);
		await query(
			`SELECT roadmap_workforce.fn_offer_provider_heartbeat($1, $2, NULL, $3::jsonb)`,
			[input.agency_id, projectId, capabilitiesJsonb],
		);

		return ok({
			agency_id: input.agency_id,
			project_slug: input.project_slug,
			project_id: projectId.toString(),
			joined: true,
		});
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return err("join_failed", { agency_id: input.agency_id, project_slug: input.project_slug }, message);
	}
}

// ---------------------------------------------------------------------------
// agency_leave_project
// ---------------------------------------------------------------------------

export interface AgencyLeaveProjectInput {
	agency_id: string;
	project_slug: string;
}

export async function handleAgencyLeaveProject(
	input: AgencyLeaveProjectInput,
): Promise<CallToolResult> {
	try {
		const result = await query<{ agency_identity: string }>(
			`UPDATE roadmap_workforce.provider_registry
			 SET status = 'paused'
			 WHERE agency_identity = $1
			   AND project_id = (
			     SELECT id FROM roadmap_workforce.projects
			     WHERE slug = $2 OR name = $2
			     LIMIT 1
			   )
			   AND status != 'paused'
			 RETURNING agency_identity`,
			[input.agency_id, input.project_slug],
		);

		return ok({
			agency_id: input.agency_id,
			project_slug: input.project_slug,
			removed: (result.rowCount ?? 0) > 0,
		});
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return err("leave_failed", { agency_id: input.agency_id, project_slug: input.project_slug }, message);
	}
}

// ---------------------------------------------------------------------------
// agency_resume  (P765 AC-2: operator short-circuit recovery)
// ---------------------------------------------------------------------------

export interface AgencyResumeInput {
	agency_id: string;
}

export async function handleAgencyResume(
	input: AgencyResumeInput,
): Promise<CallToolResult> {
	try {
		const status = await liaisonResume(input.agency_id);
		return ok({ agency_id: input.agency_id, status });
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return err("resume_failed", { agency_id: input.agency_id }, message);
	}
}

// ---------------------------------------------------------------------------
// agency_liaison_status
// ---------------------------------------------------------------------------

export interface AgencyLiaisonStatusInput {
	agency_id?: string;
}

export async function handleAgencyLiaisonStatus(
	input: AgencyLiaisonStatusInput,
): Promise<CallToolResult> {
	try {
		if (input.agency_id) {
			const status = await getAgencyStatus(input.agency_id);
			if (!status) {
				return err(
					"agency_not_found",
					{ agency_id: input.agency_id },
					`No agency found with id '${input.agency_id}'.`,
				);
			}
			return ok(status);
		}

		const agencies = await listDispatchableAgencies();
		return ok({ dispatchable: agencies });
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return err("status_failed", {}, message);
	}
}
