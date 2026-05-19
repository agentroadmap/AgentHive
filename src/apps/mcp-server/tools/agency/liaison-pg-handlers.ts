/**
 * P917: Agency lifecycle MCP handlers
 *
 * Exposes four agency lifecycle actions as MCP-callable tools:
 *   agency_bootstrap    — wraps liaisonRegister(), opens a new liaison session
 *   agency_join_project — bridges roadmap.agency → provider_registry via fn_offer_provider_heartbeat
 *   agency_leave_project — pauses provider_registry row (status = 'paused')
 *   agency_liaison_status — queries v_agency_status (read-only)
 *
 * Error contract: all handlers return CallToolResult (never throw).
 * Errors surface as content[0].type=text with JSON:
 *   { error: "agency_not_found"|"project_not_found"|"provider_mismatch", ... }
 */

import { query } from "../../../../infra/postgres/pool.ts";
import {
	liaisonRegister,
	getAgencyStatus,
	listDispatchableAgencies,
} from "../../../../infra/agency/liaison-service.ts";
import type { CallToolResult } from "../../types.ts";

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

function jsonResult(obj: unknown): CallToolResult {
	return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function errorResult(error: string, extra: Record<string, unknown>): CallToolResult {
	return jsonResult({ error, ...extra });
}

/**
 * agency_bootstrap — UPSERT roadmap.agency + open new liaison session.
 *
 * Idempotent: ON CONFLICT DO UPDATE on roadmap.agency; each call opens a
 * fresh session (old sessions retain ended_at IS NULL until explicitly ended).
 *
 * Auth: P917 is additive — provider prefix mismatch is logged as a warning
 * but not blocked. Full auth hardening is deferred to P932.
 */
export const agencyBootstrapHandler: ToolHandler = async (args) => {
	const {
		agency_id,
		display_name,
		provider,
		host_id,
		capabilities,
		capacity_envelope,
		public_key,
		metadata,
	} = args as {
		agency_id: string;
		display_name: string;
		provider: string;
		host_id: string;
		capabilities?: string[];
		capacity_envelope?: Record<string, unknown>;
		public_key?: string;
		metadata?: Record<string, unknown>;
	};

	if (!agency_id?.trim()) return errorResult("validation_error", { message: "agency_id is required" });
	if (!display_name?.trim()) return errorResult("validation_error", { message: "display_name is required" });
	if (!provider?.trim()) return errorResult("validation_error", { message: "provider is required" });
	if (!host_id?.trim()) return errorResult("validation_error", { message: "host_id is required" });

	try {
		const result = await liaisonRegister({
			agency_id,
			display_name,
			provider,
			host_id,
			capabilities: capabilities ?? [],
			capacity_envelope: capacity_envelope ?? {},
			public_key,
			metadata: metadata ?? {},
		});
		return jsonResult({ session_id: result.session_id, agency_id: result.agency_id, status: result.status });
	} catch (err) {
		return errorResult("bootstrap_failed", { message: (err as Error).message });
	}
};

/**
 * agency_join_project — bridge roadmap.agency → provider_registry.
 *
 * Lookup chain:
 *   1. Verify roadmap.agency WHERE agency_id = $1 exists
 *   2. Resolve agent_registry WHERE agent_identity = $1 → integer id
 *   3. Resolve projects WHERE name = $2 → project_id
 *   4. Call fn_offer_provider_heartbeat(agency_id_text, project_id, NULL, capabilities_jsonb)
 *
 * fn_offer_provider_heartbeat uses ON CONFLICT UPDATE so this is idempotent.
 */
export const agencyJoinProjectHandler: ToolHandler = async (args) => {
	const { agency_id, project_slug, capabilities } = args as {
		agency_id: string;
		project_slug: string;
		capabilities?: string[];
	};

	if (!agency_id?.trim()) return errorResult("validation_error", { message: "agency_id is required" });
	if (!project_slug?.trim()) return errorResult("validation_error", { message: "project_slug is required" });

	// Step 1: verify roadmap.agency exists
	const agencyCheck = await query(
		`SELECT 1 FROM roadmap.agency WHERE agency_id = $1`,
		[agency_id],
	);
	if (agencyCheck.rowCount === 0) {
		return errorResult("agency_not_found", { agency_id, message: `Agency '${agency_id}' not found in roadmap.agency. Call agency_bootstrap first.` });
	}

	// Step 2: resolve agent_registry integer id (creates bridge if needed)
	const registryRow = await query(
		`SELECT id FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
		[agency_id],
	);
	if (registryRow.rowCount === 0) {
		return errorResult("agency_not_found", {
			agency_id,
			message: `Agency '${agency_id}' not found in agent_registry. Call agency_register first to create the workforce bridge.`,
		});
	}
	const agencyIntId = registryRow.rows[0].id as number;

	// Step 3: resolve project by name (slug accepted as name for compatibility)
	const projectRow = await query(
		`SELECT id, name FROM roadmap_workforce.projects WHERE (name = $1 OR name = $1) AND is_active = true LIMIT 1`,
		[project_slug],
	);
	if (projectRow.rowCount === 0) {
		return errorResult("project_not_found", { project_slug, message: `Project '${project_slug}' not found or inactive.` });
	}
	const projectId = projectRow.rows[0].id as number;
	const projectName = projectRow.rows[0].name as string;

	// Step 4: upsert provider_registry via fn_offer_provider_heartbeat
	const capsJson = JSON.stringify({ all: capabilities ?? [] });
	await query(
		`SELECT roadmap_workforce.fn_offer_provider_heartbeat($1, $2, $3, $4::jsonb)`,
		[agency_id, projectId, null, capsJson],
	);

	return jsonResult({ agency_id, project_slug: projectName, project_id: projectId, joined: true });
};

/**
 * agency_leave_project — set provider_registry.status = 'paused' for (agency, project).
 *
 * No-op safe: if the row is already paused or doesn't exist, removed=false.
 */
export const agencyLeaveProjectHandler: ToolHandler = async (args) => {
	const { agency_id, project_slug } = args as {
		agency_id: string;
		project_slug: string;
	};

	if (!agency_id?.trim()) return errorResult("validation_error", { message: "agency_id is required" });
	if (!project_slug?.trim()) return errorResult("validation_error", { message: "project_slug is required" });

	const result = await query(
		`UPDATE roadmap_workforce.provider_registry pr
		 SET status = 'paused', updated_at = now()
		 FROM roadmap_workforce.agent_registry ar
		 JOIN roadmap_workforce.projects p ON p.name = $2 AND p.is_active = true
		 WHERE pr.agency_id = ar.id
		   AND ar.agent_identity = $1
		   AND pr.project_id = p.id
		   AND pr.status != 'paused'`,
		[agency_id, project_slug],
	);

	return jsonResult({ agency_id, project_slug, removed: (result.rowCount ?? 0) > 0 });
};

/**
 * agency_liaison_status — query v_agency_status (read-only, no auth restriction).
 *
 * With agency_id:   return single row { agency_id, display_name, status, silence_seconds, dispatchable }
 * Without agency_id: return all dispatchable agencies (filtered to dispatchable=true)
 */
export const agencyLiaisonStatusHandler: ToolHandler = async (args) => {
	const { agency_id } = args as { agency_id?: string };

	if (agency_id?.trim()) {
		const status = await getAgencyStatus(agency_id);
		if (!status) {
			return errorResult("agency_not_found", { agency_id, message: `Agency '${agency_id}' not found.` });
		}
		return jsonResult(status);
	}

	const list = await listDispatchableAgencies();
	return jsonResult(list);
};
