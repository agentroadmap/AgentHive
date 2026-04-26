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
import type { CallToolResult } from "../../types.ts";

function errorResult(msg: string, err: unknown): CallToolResult {
	return {
		content: [
			{
				type: "text",
				text: `⚠️ ${msg}: ${err instanceof Error ? err.message : String(err)}`,
			},
		],
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
}
