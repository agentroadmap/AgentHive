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
