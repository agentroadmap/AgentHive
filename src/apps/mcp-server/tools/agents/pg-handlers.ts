/**
 * Postgres-backed Agent Registry MCP Tools for AgentHive.
 *
 * Workforce management via the `agent_registry`, `team`, and `team_member` tables.
 * All handler methods catch errors and return MCP text responses instead of throwing.
 */

import { query } from "../../../../postgres/pool.ts";
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
	async listAgents(args: { status?: string }): Promise<CallToolResult> {
		try {
			const where = args.status ? `WHERE status = $1` : "";
			const params = args.status ? [args.status] : [];
			const { rows } = await query(
				`SELECT agent_identity, agent_type, role, status, skills, created_at
         FROM agent_registry ${where} ORDER BY agent_identity`,
				params,
			);
			if (!rows || rows.length === 0) {
				return { content: [{ type: "text", text: "No agents found." }] };
			}
			const lines = rows.map(
				(r) =>
					`${r.agent_identity} (${r.agent_type}) — role: ${r.role}, status: ${r.status}`,
			);
			return { content: [{ type: "text", text: lines.join("\n") }] };
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
			const { rows } = await query(
				`INSERT INTO agent_registry (agent_identity, agent_type, role, skills)
         VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT ON CONSTRAINT agent_registry_agent_identity_key
         DO UPDATE SET agent_type = EXCLUDED.agent_type, role = EXCLUDED.role, skills = EXCLUDED.skills
         RETURNING agent_identity, role, status`,
				[
					args.identity,
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
