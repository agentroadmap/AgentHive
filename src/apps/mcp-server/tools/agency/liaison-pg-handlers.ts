/**
 * P917: MCP agency lifecycle action handlers.
 *
 * agency_bootstrap   — register an agency and open a liaison session (idempotent UPSERT).
 * agency_join_project — opt an agency into a project's dispatch pool.
 * agency_leave_project — remove an agency from a project's dispatch pool.
 * agency_liaison_status — query current liveness + status from v_agency_status.
 */

import {
	liaisonRegister,
	getAgencyStatus,
	type LiaisonRegisterPayload,
} from "../../../../infra/agency/liaison-service.ts";
import { query } from "../../../../infra/postgres/pool.ts";

// ──────────────────────────────────────────────────────────────────────────────
// agency_bootstrap
// ──────────────────────────────────────────────────────────────────────────────

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

export async function agencyBootstrapHandler(
	args: AgencyBootstrapInput,
): Promise<{ session_id: string; agency_id: string; status: string }> {
	const payload: LiaisonRegisterPayload = {
		agency_id: args.agency_id,
		display_name: args.display_name,
		provider: args.provider,
		host_id: args.host_id,
		capabilities: args.capabilities ?? [],
		capacity_envelope: args.capacity_envelope ?? {},
		public_key: args.public_key,
		metadata: args.metadata ?? {},
	};
	return liaisonRegister(payload);
}

// ──────────────────────────────────────────────────────────────────────────────
// agency_join_project
// ──────────────────────────────────────────────────────────────────────────────

export interface AgencyJoinProjectInput {
	agency_id: string;
	project_id: number;
}

export async function agencyJoinProjectHandler(
	args: AgencyJoinProjectInput,
): Promise<{ agency_id: string; project_id: number; joined: boolean }> {
	if (!args.agency_id?.trim()) throw new Error("agency_id is required");
	if (!args.project_id) throw new Error("project_id is required");

	// Resolve the bigint PK in agent_registry for the FK in provider_registry.
	const registryRow = await query<{ id: string }>(
		`SELECT id FROM roadmap_workforce.agent_registry WHERE agent_identity = $1 LIMIT 1`,
		[args.agency_id],
	);
	if (registryRow.rows.length === 0) {
		throw new Error(
			`Agency ${args.agency_id} not found in agent_registry — call agency_bootstrap first`,
		);
	}
	const agentRegistryId = registryRow.rows[0].id;

	await query(
		`INSERT INTO roadmap_workforce.provider_registry
		   (agency_id, agency_identity, project_id, squad_name, is_active)
		 VALUES ($1, $2, $3, NULL, true)
		 ON CONFLICT (agency_id, project_id, squad_name) DO UPDATE SET
		   is_active = true`,
		[agentRegistryId, args.agency_id, args.project_id],
	);

	return { agency_id: args.agency_id, project_id: args.project_id, joined: true };
}

// ──────────────────────────────────────────────────────────────────────────────
// agency_leave_project
// ──────────────────────────────────────────────────────────────────────────────

export interface AgencyLeaveProjectInput {
	agency_id: string;
	project_id: number;
}

export async function agencyLeaveProjectHandler(
	args: AgencyLeaveProjectInput,
): Promise<{ agency_id: string; project_id: number; left: boolean }> {
	if (!args.agency_id?.trim()) throw new Error("agency_id is required");
	if (!args.project_id) throw new Error("project_id is required");

	const result = await query(
		`UPDATE roadmap_workforce.provider_registry pr
		    SET is_active = false
		   FROM roadmap_workforce.agent_registry ar
		  WHERE ar.id = pr.agency_id
		    AND ar.agent_identity = $1
		    AND pr.project_id = $2`,
		[args.agency_id, args.project_id],
	);

	return {
		agency_id: args.agency_id,
		project_id: args.project_id,
		left: (result.rowCount ?? 0) > 0,
	};
}

// ──────────────────────────────────────────────────────────────────────────────
// agency_liaison_status
// ──────────────────────────────────────────────────────────────────────────────

export interface AgencyLiaisonStatusInput {
	agency_id: string;
}

export async function agencyLiaisonStatusHandler(args: AgencyLiaisonStatusInput): Promise<{
	agency_id: string;
	display_name: string;
	status: string;
	silence_seconds: number;
	dispatchable: boolean;
	liveness_state: string;
}> {
	if (!args.agency_id?.trim()) throw new Error("agency_id is required");

	const row = await getAgencyStatus(args.agency_id);
	if (!row) throw new Error(`Agency ${args.agency_id} not found`);
	return row;
}
