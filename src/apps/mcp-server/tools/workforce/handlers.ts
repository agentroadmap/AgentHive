import { hostname } from "node:os";
import {
	assignDisplayAlias,
	pascalCaseHost,
} from "../../../../core/identity/agent-registry/agent-name.ts";
import { claimDisplayAlias } from "../../../../core/identity/agent-registry/alias-manager.ts";
import { query } from "../../../../infra/postgres/pool.ts";
import { resolvePermanentAgentMapping } from "../../../../core/identity/agent-registry/permanent-agent-map.ts";
import type { CallToolResult } from "../../types.ts";

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

export const agencyRegisterHandler: ToolHandler = async (args) => {
	const {
		identity,
		agentType = "agency",
		provider,
		model,
		skills,
	} = args as {
		identity: string;
		agentType?: string;
		provider?: string;
		model?: string;
		skills?: string[];
	};
	const permanent = resolvePermanentAgentMapping(identity);
	const agentIdentity = permanent?.agentIdentity ?? identity;
	const agentProvider = provider ?? permanent?.provider ?? null;

	// Register in agent_registry
	const result = await query(
		`INSERT INTO roadmap_workforce.agent_registry
		 (agent_identity, agent_type, status, preferred_provider, preferred_model)
		 VALUES ($1, $2, 'active', $3, $4)
		 ON CONFLICT (agent_identity) DO UPDATE SET
		   agent_type = EXCLUDED.agent_type,
		   status = 'active',
		   preferred_provider = EXCLUDED.preferred_provider,
		   preferred_model = EXCLUDED.preferred_model,
		   updated_at = now()
		 RETURNING id, agent_identity, agent_type`,
		[
			agentIdentity,
			agentType,
			agentProvider,
			model ?? null,
		],
	);

	const row = result.rows[0];

	// P1068 AC-4: Validate and register roles from capability_taxonomy
	// Extract agency_slug from identity (format: provider/agency-name or just agency-name)
	const agencySlug = agentIdentity.includes("/")
		? agentIdentity.split("/").slice(1).join("/")
		: agentIdentity;

	if (skills && skills.length > 0) {
		// Validate that all role_slugs exist in capability_taxonomy and are active
		const { rows: validRoles } = await query<{ role_slug: string }>(
			`SELECT role_slug FROM roadmap_proposal.capability_taxonomy
			 WHERE role_slug = ANY($1::text[]) AND is_active = true`,
			[skills],
		);

		const validRoleSlugs = validRoles.map((r) => r.role_slug);
		const invalidRoles = skills.filter((s) => !validRoleSlugs.includes(s));

		if (invalidRoles.length > 0) {
			console.warn(
				`[agencyRegisterHandler] AC-4: invalid/inactive roles: ${invalidRoles.join(", ")}`,
			);
		}

		// Insert only valid roles into agent_capability (P1068 role-identity registry)
		if (validRoleSlugs.length > 0) {
			await query(
				`INSERT INTO roadmap_proposal.agent_capability (agency_slug, role_slug)
				 SELECT $1, unnest($2::text[])
				 ON CONFLICT (agency_slug, role_slug) DO NOTHING`,
				[agencySlug, validRoleSlugs],
			);
		}

		// Also maintain legacy agent_capability for fn_claim_work_offer compatibility
		await query(
			`INSERT INTO roadmap_workforce.agent_capability (agent_id, capability)
			 SELECT $1, unnest($2::text[])
			 ON CONFLICT DO NOTHING`,
			[row.id, validRoleSlugs],
		);
	}

	// P932: claim Tier 2 display alias for slot-'a' agency workers
	const slotChar = agentIdentity.split("-").pop();
	const expertise = skills?.[0];
	if (slotChar === "a" && expertise && row?.id) {
		const provider = agentIdentity.split("/")[0] ?? agentIdentity;
		const host = process.env.AGENTHIVE_HOST ?? hostname();
		const alias = assignDisplayAlias(provider, pascalCaseHost(host), expertise, slotChar);
		if (alias) {
			const claim = await claimDisplayAlias(row.id, alias, { tier: 2 });
			if (!claim.claimed) {
				console.warn(`[agencyRegisterHandler] ${agentIdentity} alias '${alias}': ${claim.reason}`);
			}
		}
	}

	return {
		content: [
			{
				type: "text" as const,
				text: `Agency registered: ${row.agent_identity} (${row.agent_type}, id=${row.id}) — roles: ${skills?.join(", ") || "none"}`,
			},
		],
	};
};

export const providerRegisterHandler: ToolHandler = async (args) => {
	const { agencyIdentity, projectId, squadName, capabilities } = args as {
		agencyIdentity: string;
		projectId?: string;
		squadName?: string;
		capabilities?: string[];
	};

	// Look up agency
	const agency = await query(
		`SELECT id FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
		[agencyIdentity],
	);
	if (agency.rows.length === 0) {
		return {
			content: [
				{
					type: "text" as const,
					text: `Error: Agency '${agencyIdentity}' not registered. Call agency_register first.`,
				},
			],
		};
	}

	const agencyId = agency.rows[0].id;

	// Upsert provider registration
	await query(
		`INSERT INTO roadmap_workforce.provider_registry
		 (agency_id, project_id, squad_name, capabilities)
		 VALUES ($1, $2, $3, $4::jsonb)
		 ON CONFLICT (agency_id, project_id, squad_name) DO UPDATE SET
		   capabilities = EXCLUDED.capabilities,
		   is_active = true,
		   updated_at = now()`,
		[
			agencyId,
			projectId ?? null,
			squadName ?? null,
			JSON.stringify({ all: capabilities ?? [] }),
		],
	);

	return {
		content: [
			{
				type: "text" as const,
				text: `Provider registered: ${agencyIdentity} for project=${projectId ?? "all"}, squad=${squadName ?? "all"}`,
			},
		],
	};
};

export const dispatchListHandler: ToolHandler = async (args) => {
	const { status, limit = 20 } = args as {
		status?: string;
		limit?: number;
	};

	let sql = `SELECT id, proposal_id, agent_identity, worker_identity, squad_name,
	                   dispatch_role, dispatch_status, offer_status,
	                   claim_expires_at, assigned_at, completed_at
	            FROM roadmap_workforce.squad_dispatch`;
	const params: unknown[] = [];

	if (status) {
		sql += ` WHERE offer_status = $1`;
		params.push(status);
	}

	sql += ` ORDER BY assigned_at DESC LIMIT $${params.length + 1}`;
	params.push(limit);

	const result = await query(sql, params);

	const lines = result.rows.map(
		(r: any) =>
			`${r.id}: ${r.squad_name}/${r.dispatch_role} — ${r.offer_status} (agency=${r.agent_identity ?? "?"}, worker=${r.worker_identity ?? "none"})`,
	);

	return {
		content: [
			{
				type: "text" as const,
				text: lines.length > 0 ? lines.join("\n") : "No dispatches found.",
			},
		],
	};
};

export const workerRegisterHandler: ToolHandler = async (args) => {
	const { workerIdentity, agencyIdentity, skills, model } = args as {
		workerIdentity: string;
		agencyIdentity: string;
		skills?: string[];
		model?: string;
	};

	const result = await query(
		`SELECT roadmap_workforce.fn_register_worker($1, $2, $3, $4::jsonb, $5) AS worker_id`,
		[
			workerIdentity,
			agencyIdentity,
			"workforce",
			JSON.stringify({ all: skills ?? [] }),
			model ?? null,
		],
	);

	const workerId = result.rows[0]?.worker_id;

	// P932: claim Tier 2 display alias for slot-'a' workers
	const slotChar = workerIdentity.split("-").pop();
	const expertise = skills?.[0];
	if (slotChar === "a" && expertise && workerId) {
		const provider = agencyIdentity.split("/")[0] ?? agencyIdentity;
		const host = process.env.AGENTHIVE_HOST ?? hostname();
		const alias = assignDisplayAlias(provider, pascalCaseHost(host), expertise, slotChar);
		if (alias) {
			const claim = await claimDisplayAlias(workerId, alias, { tier: 2 });
			if (!claim.claimed) {
				console.warn(`[workerRegisterHandler] ${workerIdentity} alias '${alias}': ${claim.reason}`);
			}
		}
	}

	return {
		content: [
			{
				type: "text" as const,
				text: `Worker registered: ${workerIdentity} under ${agencyIdentity} (id=${workerId})`,
			},
		],
	};
};

/**
 * P1698 AC-1/5: List all agencies with current dispatch capacity.
 * Returns: [{agency_identity, project_id, max_in_flight, in_flight_count, status}]
 */
export const agencyCapListHandler: ToolHandler = async () => {
	const result = await query(
		`SELECT ar.agent_identity,
		        pr.project_id,
		        pr.max_in_flight,
		        COALESCE(inf.in_flight_count, 0) AS in_flight_count,
		        pr.status
		 FROM roadmap_workforce.provider_registry pr
		 JOIN roadmap_workforce.agent_registry ar ON ar.id = pr.agency_id
		 LEFT JOIN roadmap_workforce.v_agency_in_flight inf ON inf.provider_registry_id = pr.id
		 ORDER BY ar.agent_identity, pr.project_id NULLS LAST`,
	);

	const lines = result.rows.map(
		(r: any) =>
			`${r.agent_identity} (project=${r.project_id ?? "all"}): max=${r.max_in_flight}, in_flight=${r.in_flight_count}, status=${r.status}`,
	);

	return {
		content: [
			{
				type: "text" as const,
				text: lines.length > 0 ? lines.join("\n") : "No agencies found.",
			},
		],
	};
};

/**
 * P1698 AC-2/6: Set max_in_flight capacity for an agency.
 * Validates agency exists, max_in_flight >= 0.
 * Writes audit row to message_ledger, fires NOTIFY core_changed.
 */
export const agencyCapSetHandler: ToolHandler = async (args) => {
	const { agencyIdentity, maxInFlight, projectId } = args as {
		agencyIdentity: string;
		maxInFlight: number;
		projectId?: string;
	};

	// Validate input
	if (maxInFlight < 0) {
		return {
			content: [
				{
					type: "text" as const,
					text: `Error: max_in_flight must be >= 0, got ${maxInFlight}`,
				},
			],
		};
	}

	// Check if agency exists in agent_registry
	const agencyCheck = await query(
		`SELECT id FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
		[agencyIdentity],
	);
	if (agencyCheck.rows.length === 0) {
		return {
			content: [
				{
					type: "text" as const,
					text: `Error: Agency '${agencyIdentity}' not found in agent_registry`,
				},
			],
		};
	}

	const agencyId = agencyCheck.rows[0].id;

	// Get current max_in_flight before update
	let oldMaxInFlight: number | null = null;
	const currentResult = await query(
		`SELECT max_in_flight FROM roadmap_workforce.provider_registry
		 WHERE agency_id = $1 AND (project_id = $2 OR ($2 IS NULL AND project_id IS NULL))
		 LIMIT 1`,
		[agencyId, projectId ?? null],
	);
	if (currentResult.rows.length > 0) {
		oldMaxInFlight = currentResult.rows[0].max_in_flight;
	}

	// Update provider_registry
	const updateResult = await query(
		`UPDATE roadmap_workforce.provider_registry
		 SET max_in_flight = $1, updated_at = now()
		 WHERE agency_id = $2 AND (project_id = $3 OR ($3 IS NULL AND project_id IS NULL))
		 RETURNING id`,
		[maxInFlight, agencyId, projectId ?? null],
	);

	if (updateResult.rows.length === 0) {
		return {
			content: [
				{
					type: "text" as const,
					text: `Error: No provider_registry entry found for agency '${agencyIdentity}' (project=${projectId ?? "all"})`,
				},
			],
		};
	}

	// Write audit row to message_ledger
	try {
		await query(
			`INSERT INTO roadmap.message_ledger
			 (from_agent, channel, message_type, metadata, project_id)
			 VALUES ('system:agency_cap_manager', 'system:audit', $1, $2, $3)`,
			[
				"agency_cap_change",
				JSON.stringify({
					actor: "claude-bot-gary-gating",
					agency_identity: agencyIdentity,
					old_max_in_flight: oldMaxInFlight,
					new_max_in_flight: maxInFlight,
					project_id: projectId ?? null,
				}),
				1, // project_id
			],
		);

		// Fire NOTIFY core_changed
		await query("SELECT pg_notify('core_changed', $1)", [
			JSON.stringify({ type: "agency_cap_change", agency_identity: agencyIdentity }),
		]);
	} catch (err) {
		console.error("[agencyCapSetHandler] Audit write or notify failed:", err);
		// Continue anyway — capacity change is the critical update
	}

	return {
		content: [
			{
				type: "text" as const,
				text: `Agency capacity updated: ${agencyIdentity} max_in_flight ${oldMaxInFlight ?? "?"} → ${maxInFlight} (project=${projectId ?? "all"})`,
			},
		],
	};
};
