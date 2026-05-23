/**
 * Postgres-backed Agent Registry MCP Tools for AgentHive.
 *
 * Workforce management via the `agent_registry`, `team`, and `team_member` tables.
 * All handler methods catch errors and return MCP text responses instead of throwing.
 * P462: Added agent identity sanitization to prevent collisions and path traversal.
 */

import { query } from "../../../../postgres/pool.ts";
import {
	normalizeAgentId,
	detectCollision,
	AgentIdInvalidError,
} from "../../../../shared/identity/sanitize-agent-id.ts";
import {
	forceReleaseAlias,
	type AliasReclaimResult,
	type AliasReclaimError,
} from "../../../../core/identity/agent-registry/alias-manager.ts";
import type { CallToolResult } from "../../types.ts";

function errorResult(msg: string, err: unknown): CallToolResult {
	return {
		content: [
			{
				type: "text",
				text: `⚠️ ${msg}: ${err instanceof Error ? err.message : String(err)}`,
			},
		],
		isError: true,
	};
}

export class PgAgentHandlers {
	async listAgents(args: {
		status?: string;
		limit?: number;
		include_terminal?: boolean;
		include_metadata?: boolean;
	}): Promise<CallToolResult> {
		try {
			const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);
			const includeTerminal = args.include_terminal === true;
			const includeMetadata = args.include_metadata === true;

			let sql = `SELECT agent_identity, agent_type, role, status, created_at${includeMetadata ? ", skills, metadata" : ""}
			       FROM agent_registry`;
			const params: (string | number)[] = [];
			const conditions: string[] = [];

			if (args.status) {
				conditions.push(`status = $${params.length + 1}`);
				params.push(args.status);
			} else if (!includeTerminal) {
				conditions.push(`status NOT IN ('inactive', 'retired')`);
			}

			if (conditions.length) {
				sql += ` WHERE ${conditions.join(" AND ")}`;
			}
			sql += ` ORDER BY agent_identity LIMIT $${params.length + 1}`;
			params.push(limit);

			const [{ rows }, countResult] = await Promise.all([
				query(sql, params),
				query<{ total: string }>(
					`SELECT COUNT(*)::text AS total FROM agent_registry${
						conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""
					}`,
					params.slice(0, -1),
				),
			]);

			const totalMatching = Number(countResult.rows[0]?.total ?? rows.length);
			const truncated = totalMatching > rows.length;

			if (!rows.length) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									total: 0,
									returned: 0,
									truncated: false,
									limit,
									filter: { status: args.status, includeTerminal },
									note: includeTerminal
										? "No agents match the filter."
										: "No active agents. Pass include_terminal=true to see inactive/retired.",
								},
								null,
								2,
							),
						},
					],
				};
			}

			const items = rows.map((r: any) => ({
				agent_identity: r.agent_identity,
				agent_type: r.agent_type,
				role: r.role,
				status: r.status,
				created_at: r.created_at,
				...(includeMetadata && {
					skills: r.skills,
					metadata: r.metadata,
				}),
			}));

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								total: totalMatching,
								returned: rows.length,
								truncated,
								limit,
								filter: { status: args.status, includeTerminal },
								items,
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to list agents", err);
		}
	}

	async getAgent(args: { identity: string }): Promise<CallToolResult> {
		try {
			const { rows } = await query(
				`SELECT * FROM agent_registry WHERE agent_identity = $1`,
				[args.identity],
			);
			if (!rows.length) {
				return {
					content: [
						{ type: "text", text: `Agent ${args.identity} not found.` },
					],
				};
			}
			return {
				content: [{ type: "text", text: JSON.stringify(rows[0], null, 2) }],
			};
		} catch (err) {
			return errorResult("Failed to get agent", err);
		}
	}

	async registerAgent(args: {
		identity: string;
		agent_type?: string;
		role?: string;
		skills?: string;
	}): Promise<CallToolResult> {
		try {
			// P462: Sanitize and validate agent identity
			const normalizedIdentity = normalizeAgentId(args.identity);

			// P462: Check for collisions with existing identities
			const collision = await detectCollision(args.identity);
			if (collision && collision !== args.identity) {
				return errorResult(
					"Agent identity collision",
					`"${args.identity}" normalizes to same as "${collision}"`,
				);
			}

			const { rows } = await query(
				`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, role, skills)
         VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (agent_identity)
         DO UPDATE SET agent_type = EXCLUDED.agent_type, role = EXCLUDED.role, skills = EXCLUDED.skills
         RETURNING agent_identity, role, status`,
				[
					normalizedIdentity,
					args.agent_type || null,
					args.role || null,
					args.skills
						? typeof args.skills === "string"
							? args.skills.trim().startsWith("[") || args.skills.trim().startsWith("{")
								? args.skills
								: JSON.stringify(args.skills.split(",").map((s) => s.trim()).filter(Boolean))
							: JSON.stringify(args.skills)
						: null,
				],
			);
			return {
				content: [
					{
						type: "text",
						text: `Agent registered: ${rows[0].agent_identity} (${rows[0].role})`,
					},
				],
			};
		} catch (err) {
			if (err instanceof AgentIdInvalidError) {
				return errorResult("Invalid agent identity", err);
			}
			return errorResult("Failed to register agent", err);
		}
	}

	async listTeams(_args: Record<string, never>): Promise<CallToolResult> {
		try {
			const { rows } = await query(`SELECT * FROM team ORDER BY team_name`);
			if (!rows.length) {
				return { content: [{ type: "text", text: "No teams found." }] };
			}
			const lines = rows.map(
				(r) => `${r.team_name} (${r.team_type}) — ${r.status}`,
			);
			return { content: [{ type: "text", text: lines.join("\n") }] };
		} catch (err) {
			return errorResult("Failed to list teams", err);
		}
	}

	async createTeam(args: {
		name: string;
		team_type?: string;
	}): Promise<CallToolResult> {
		try {
			const { rows } = await query(
				`INSERT INTO team (team_name, team_type) VALUES ($1, $2) RETURNING *`,
				[args.name, args.team_type || null],
			);
			return {
				content: [{ type: "text", text: `Team created: ${rows[0].team_name}` }],
			};
		} catch (err) {
			return errorResult("Failed to create team", err);
		}
	}

	async addTeamMember(args: {
		team_name: string;
		agent_identity: string;
		role?: string;
	}): Promise<CallToolResult> {
		try {
			const teamRes = await query(`SELECT id FROM team WHERE team_name = $1`, [
				args.team_name,
			]);
			if (!teamRes.rows.length) {
				return {
					content: [
						{ type: "text", text: `Team ${args.team_name} not found.` },
					],
				};
			}
			const agentRes = await query(
				`SELECT id FROM agent_registry WHERE agent_identity = $1`,
				[args.agent_identity],
			);
			if (!agentRes.rows.length) {
				return {
					content: [
						{ type: "text", text: `Agent ${args.agent_identity} not found.` },
					],
				};
			}
			const teamId = teamRes.rows[0].id;
			const agentId = agentRes.rows[0].id;

			await query(
				`INSERT INTO team_member (team_id, agent_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
				[teamId, agentId, args.role || null],
			);
			return {
				content: [
					{
						type: "text",
						text: `${args.agent_identity} added to ${args.team_name}`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to add team member", err);
		}
	}

	/**
	 * P995: Resolve a named agent by identity or display_alias.
	 * Returns the full registry row, including host_affinity and preferred_provider.
	 */
	async resolveAgent(args: {
		name: string;
	}): Promise<CallToolResult> {
		try {
			const { rows } = await query(
				`SELECT agent_identity, agent_type, role, status, preferred_provider,
				        host_affinity, display_alias, created_at, updated_at
				 FROM   roadmap_workforce.agent_registry
				 WHERE  agent_identity = $1
				    OR  display_alias  = $1
				 ORDER  BY (agent_identity = $1) DESC
				 LIMIT  1`,
				[args.name],
			);

			if (!rows.length) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ found: false, query: args.name },
								null,
								2,
							),
						},
					],
				};
			}

			const r = rows[0];
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								found: true,
								agent_identity: r.agent_identity,
								agent_type: r.agent_type,
								role: r.role,
								status: r.status,
								preferred_provider: r.preferred_provider,
								host_affinity: r.host_affinity,
								display_alias: r.display_alias,
								created_at: r.created_at,
								updated_at: r.updated_at,
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to resolve agent", err);
		}
	}

	/**
	 * P919 AC-4: Force-release a display alias from an agent.
	 * Two paths:
	 *   1. Clean: target row status='inactive' → always succeeds
	 *   2. Stuck: target row status='active' BUT last_heartbeat < now()-90s → requires force=true
	 */
	async forceReleaseAlias(args: {
		identity: string;
		force?: boolean;
	}): Promise<CallToolResult> {
		try {
			const result = await forceReleaseAlias({
				identity: args.identity,
				force: args.force ?? false,
			});

			// Check if result is an error
			if ("code" in result && "message" in result) {
				const err = result as AliasReclaimError;
				return {
					content: [
						{
							type: "text",
							text: `Error [${err.code}]: ${err.message}`,
						},
					],
					isError: true,
				};
			}

			// Success case
			const success = result as AliasReclaimResult;
			const lines = [
				`✓ Alias released successfully`,
				`Reason: ${success.reason}`,
				success.priorIdentity ? `Prior owner: ${success.priorIdentity}` : "",
			].filter(Boolean);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
			};
		} catch (err) {
			return errorResult("Failed to force-release alias", err);
		}
	}

	/**
	 * P1372: Register an agency in roadmap.agency.
	 * Validates that agency_id exists in agent_registry as an active agency type,
	 * then idempotently inserts into roadmap.agency.
	 *
	 * Input aliases: agent_identity (canonical), identity, agency_id.
	 * Validates regex: ^[a-zA-Z0-9._-]{1,64}$ for agency_id and host_id.
	 * Metadata (if supplied) must be an object, not array/scalar.
	 *
	 * Response shapes:
	 * - Created: {action: 'created', agency_id, provider, host_id}
	 * - Noop (already exists): {action: 'noop', agency_id, existing_provider, existing_host_id}
	 * - Errors include: missing identity, missing agent_registry row, inactive/non-agency type, invalid format, missing provider, metadata type error
	 */
	async registerAgency(args: {
		agent_identity?: string;
		identity?: string;
		agency_id?: string;
		display_name?: string;
		provider?: string;
		host_id?: string;
		metadata?: Record<string, unknown>;
	}): Promise<CallToolResult> {
		try {
			// Step 1: Resolve identity from aliases
			const agencyId =
				args.agent_identity || args.identity || args.agency_id;
			if (!agencyId || !agencyId.trim()) {
				return errorResult(
					"Missing identity",
					new Error(
						"One of agent_identity, identity, or agency_id is required",
					),
				);
			}

			const trimmedId = agencyId.trim();
			const idRegex = /^[a-zA-Z0-9._-]{1,64}$/;
			if (!idRegex.test(trimmedId)) {
				return errorResult(
					"Invalid agency_id format",
					new Error(
						`agency_id must match ^[a-zA-Z0-9._-]{1,64}$; got: ${trimmedId}`,
					),
				);
			}

			// Step 2: Validate metadata (if supplied) is an object
			if (args.metadata !== undefined) {
				if (
					typeof args.metadata !== "object" ||
					args.metadata === null ||
					Array.isArray(args.metadata)
				) {
					return errorResult(
						"Invalid metadata type",
						new Error(
							`metadata must be an object, not ${Array.isArray(args.metadata) ? "array" : typeof args.metadata}`,
						),
					);
				}
			}

			// Step 3: Query agent_registry to validate prerequisite
			const regResult = await query<{
				agent_type: string;
				status: string;
				preferred_provider: string | null;
				host_affinity: string | null;
			}>(
				`SELECT agent_type, status, preferred_provider, host_affinity
				 FROM roadmap_workforce.agent_registry
				 WHERE agent_identity = $1`,
				[trimmedId],
			);

			if (!regResult.rows.length) {
				return {
					content: [
						{
							type: "text",
							text: `Error: Agency '${trimmedId}' not found in agent_registry. Prerequisite path: mcp_agent action='register' args={agent_identity: '${trimmedId}', agent_type: 'agency', ...}`,
						},
					],
					isError: true,
				};
			}

			const regRow = regResult.rows[0];
			if (regRow.agent_type !== "agency") {
				return {
					content: [
						{
							type: "text",
							text: `Error: agent_registry row for '${trimmedId}' has agent_type='${regRow.agent_type}', not 'agency'. Cannot promote non-agency agents to roadmap.agency.`,
						},
					],
					isError: true,
				};
			}

			if (regRow.status !== "active") {
				return {
					content: [
						{
							type: "text",
							text: `Error: agent_registry row for '${trimmedId}' has status='${regRow.status}', not 'active'. Only active agencies can be registered.`,
						},
					],
					isError: true,
				};
			}

			// Step 4: Resolve insert values
			const resolvedDisplayName = args.display_name || trimmedId;
			const resolvedProvider =
				args.provider || regRow.preferred_provider;

			if (!resolvedProvider || !resolvedProvider.trim()) {
				return {
					content: [
						{
							type: "text",
							text: `Error: provider cannot be determined. No provider specified in args, and agent_registry.preferred_provider is null/blank. Please supply provider in args.`,
						},
					],
					isError: true,
				};
			}

			const resolvedHostId =
				(args.host_id || regRow.host_affinity || "bot").trim();

			// Validate host_id format
			if (!idRegex.test(resolvedHostId)) {
				return errorResult(
					"Invalid host_id format",
					new Error(
						`host_id must match ^[a-zA-Z0-9._-]{1,64}$; got: ${resolvedHostId}`,
					),
				);
			}

			// Step 5: Build metadata with registration context
			const finalMetadata = {
				registered_via: "mcp_agent.register_agency",
				source_agent_registry: true,
				...(args.metadata || {}),
			};

			// Step 6: Idempotent insert
			const insertResult = await query<{
				agency_id: string;
				provider: string;
				host_id: string;
				status: string;
				presence_state: string;
			}>(
				`INSERT INTO roadmap.agency (
					agency_id, display_name, provider, host_id, capability_tags,
					status, presence_state, metadata
				)
				 VALUES ($1, $2, $3, $4, '{}', 'active', 'offline', $5::jsonb)
				 ON CONFLICT (agency_id) DO NOTHING
				 RETURNING agency_id, provider, host_id, status, presence_state`,
				[
					trimmedId,
					resolvedDisplayName,
					resolvedProvider.trim(),
					resolvedHostId,
					JSON.stringify(finalMetadata),
				],
			);

			// Step 7: Handle result
			if (insertResult.rows.length > 0) {
				// Successfully inserted
				const row = insertResult.rows[0];
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									action: "created",
									agency_id: row.agency_id,
									provider: row.provider,
									host_id: row.host_id,
									status: row.status,
									presence_state: row.presence_state,
									registered_via: "mcp_agent.register_agency",
								},
								null,
								2,
							),
						},
					],
				};
			}

			// No rows returned: conflict on duplicate agency_id, fetch existing
			const existingResult = await query<{
				agency_id: string;
				provider: string;
				host_id: string;
				status: string;
				presence_state: string;
			}>(
				`SELECT agency_id, provider, host_id, status, presence_state
				 FROM roadmap.agency
				 WHERE agency_id = $1`,
				[trimmedId],
			);

			if (existingResult.rows.length > 0) {
				const existing = existingResult.rows[0];
				const mismatch: string[] = [];
				if (
					existing.provider !== resolvedProvider.trim() &&
					args.provider
				) {
					mismatch.push(
						`provider: existing='${existing.provider}', resolved='${resolvedProvider.trim()}'`,
					);
				}
				if (existing.host_id !== resolvedHostId && args.host_id) {
					mismatch.push(
						`host_id: existing='${existing.host_id}', resolved='${resolvedHostId}'`,
					);
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									action: "noop",
									reason: "already_exists",
									agency_id: existing.agency_id,
									existing_provider: existing.provider,
									existing_host_id: existing.host_id,
									existing_status: existing.status,
									existing_presence_state:
										existing.presence_state,
									...(mismatch.length > 0 && {
										mismatches: mismatch,
										note: "Existing roadmap.agency rows are never modified by this action; provider/host changes require a separate proposal",
									}),
								},
								null,
								2,
							),
						},
					],
				};
			}

			// Fallback: neither insert nor select succeeded (race condition or constraint)
			return errorResult(
				"Unexpected state",
				new Error(
					`INSERT ON CONFLICT DO NOTHING succeeded (row was inserted) but RETURNING returned no rows, and subsequent SELECT also found no rows. This is an impossible state.`,
				),
			);
		} catch (err) {
			return errorResult("Failed to register agency", err);
		}
	}
}
