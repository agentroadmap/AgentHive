/**
 * Postgres-backed Agent Registry MCP Tools for AgentHive.
 *
 * Workforce management via the `agent_registry`, `team`, and `team_member` tables.
 * All handler methods catch errors and return MCP text responses instead of throwing.
 * P462: Added agent identity sanitization to prevent collisions and path traversal.
 * P1129: Extended registerAgent with agency-shape fields; added registerModel with probe gate.
 */

import { spawnSync } from "node:child_process";
import { query, getPool } from "../../../../postgres/pool.ts";
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
		// P1129: agency-shape fields
		preferred_provider?: string;
		agent_cli?: string;
		host_affinity?: string;
		display_alias?: string;
		display_name?: string;
	}): Promise<CallToolResult> {
		try {
			const normalizedIdentity = normalizeAgentId(args.identity);

			const collision = await detectCollision(args.identity);
			if (collision && collision !== args.identity) {
				return errorResult(
					"Agent identity collision",
					`"${args.identity}" normalizes to same as "${collision}"`,
				);
			}

			const skillsJson = args.skills
				? typeof args.skills === "string"
					? args.skills.trim().startsWith("[") || args.skills.trim().startsWith("{")
						? args.skills
						: JSON.stringify(args.skills.split(",").map((s) => s.trim()).filter(Boolean))
					: JSON.stringify(args.skills)
				: null;

			// AC-10: wrap INSERT/UPDATE in a transaction with an advisory lock keyed on
			// the normalized identity so concurrent same-identity callers serialize.
			const pool = getPool();
			const client = await pool.connect();
			let r: Record<string, unknown>;
			try {
				await client.query("BEGIN");
				// Advisory lock: serializes concurrent callers for the same identity.
				await client.query(
					`SELECT pg_advisory_xact_lock(hashtext('agentRegister:' || $1)::int4)`,
					[normalizedIdentity],
				);
				const { rows } = await client.query(
					`INSERT INTO roadmap_workforce.agent_registry
					   (agent_identity, agent_type, role, skills,
					    preferred_provider, agent_cli, host_affinity, display_alias, display_name)
					 VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)
					 ON CONFLICT (agent_identity) DO UPDATE SET
					   agent_type        = COALESCE(EXCLUDED.agent_type,        agent_registry.agent_type),
					   role              = COALESCE(EXCLUDED.role,              agent_registry.role),
					   skills            = COALESCE(EXCLUDED.skills,            agent_registry.skills),
					   preferred_provider = COALESCE(EXCLUDED.preferred_provider, agent_registry.preferred_provider),
					   agent_cli         = COALESCE(EXCLUDED.agent_cli,         agent_registry.agent_cli),
					   host_affinity     = COALESCE(EXCLUDED.host_affinity,     agent_registry.host_affinity),
					   display_alias     = COALESCE(EXCLUDED.display_alias,     agent_registry.display_alias),
					   display_name      = COALESCE(EXCLUDED.display_name,      agent_registry.display_name),
					   updated_at        = now()
					 RETURNING agent_identity, role, status, preferred_provider`,
					[
						normalizedIdentity,
						args.agent_type || null,
						args.role || null,
						skillsJson,
						args.preferred_provider || null,
						args.agent_cli || null,
						args.host_affinity || null,
						args.display_alias || null,
						args.display_name || null,
					],
				);
				await client.query("COMMIT");
				r = rows[0];
			} catch (txErr) {
				await client.query("ROLLBACK").catch(() => {});
				throw txErr;
			} finally {
				client.release();
			}

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								agent_identity: r.agent_identity,
								role: r.role,
								status: r.status,
								preferred_provider: r.preferred_provider,
							},
							null,
							2,
						),
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

	/**
	 * P1129: Probe a CLI to verify a model name is accepted.
	 * Returns { ok: true } if probe succeeds or CLI is unrecognised (permissive default).
	 * Returns { ok: false, error } if the CLI explicitly rejects the model name.
	 */
	private probeModel(
		agentProvider: string,
		modelName: string,
	): { ok: boolean; error?: string } {
		type CliProbeSpec = { cli: string; args: string[]; rejectPattern: RegExp; rejectOnNonZero: boolean };
		const specs: Record<string, CliProbeSpec> = {
			claude: {
				cli: "claude",
				args: ["--model", modelName, "-p", "x"],
				rejectPattern: /unknown model/i,
				rejectOnNonZero: false,
			},
			codex: {
				cli: "codex",
				args: ["--model", modelName, "--no-git", "-q", "x"],
				rejectPattern: /invalid model/i,
				rejectOnNonZero: true,
			},
			gemini: {
				cli: "gemini",
				args: ["--model", modelName, "-p", "x"],
				rejectPattern: /model not found/i,
				rejectOnNonZero: false,
			},
			copilot: {
				cli: "copilot",
				args: ["--model", modelName, "-p", "x"],
				rejectPattern: /model not found|invalid/i,
				rejectOnNonZero: true,
			},
		};

		const spec = specs[agentProvider];
		if (!spec) {
			return { ok: true };
		}

		try {
			const result = spawnSync(spec.cli, spec.args, {
				timeout: 5000,
				encoding: "utf-8",
			});
			const output = ((result.stdout as string) || "") + ((result.stderr as string) || "");

			if (spec.rejectPattern.test(output)) {
				return { ok: false, error: output.slice(0, 500) };
			}
			if (spec.rejectOnNonZero && result.status !== 0 && result.status !== null) {
				return { ok: false, error: output.slice(0, 500) };
			}
			return { ok: true };
		} catch {
			return { ok: true };
		}
	}

	/**
	 * P1129: Register a model into model_metadata + model_routes.
	 * Performs a live CLI probe before persisting (bypass with skip_probe=true if authority).
	 * Two-step FK-safe UPSERT: model_metadata first, then model_routes.
	 */
	async registerModel(args: {
		agent_identity: string;
		model_name: string;
		route_provider: string;
		agent_provider: string;
		agent_cli?: string;
		base_url?: string;
		api_spec?: string;
		tier?: string;
		skip_probe?: boolean;
	}): Promise<CallToolResult> {
		try {
			if (args.skip_probe) {
				const trustCheck = await query(
					`SELECT trust_tier FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
					[args.agent_identity],
				);
				if (!trustCheck.rows.length || trustCheck.rows[0].trust_tier !== "authority") {
					return errorResult(
						"Permission denied",
						"skip_probe=true requires trust_tier='authority'",
					);
				}
			}

			if (!args.skip_probe) {
				const probe = this.probeModel(args.agent_provider, args.model_name);
				if (!probe.ok) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										registered: false,
										probe_failed: true,
										probe_error: probe.error,
										model_name: args.model_name,
										agent_provider: args.agent_provider,
									},
									null,
									2,
								),
							},
						],
					};
				}
			}

			// Step 1: UPSERT model_metadata (FK source required before model_routes INSERT)
			await query(
				`INSERT INTO roadmap.model_metadata (model_name, provider, is_active)
				 VALUES ($1, $2, true)
				 ON CONFLICT (provider, model_name) DO UPDATE SET is_active = true`,
				[args.model_name, args.route_provider],
			);

			// Resolve agent_cli from registry if not supplied
			let agentCli = args.agent_cli || null;
			if (!agentCli) {
				const reg = await query(
					`SELECT agent_cli FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
					[args.agent_identity],
				);
				agentCli = (reg.rows[0]?.agent_cli as string) || null;
			}

			// Step 2: UPSERT model_routes
			const { rows } = await query(
				`INSERT INTO roadmap.model_routes
				   (model_name, route_provider, agent_provider, agent_cli, base_url, api_spec, tier, is_enabled)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, true)
				 ON CONFLICT (model_name, route_provider, agent_provider) DO UPDATE SET
				   agent_cli  = COALESCE(EXCLUDED.agent_cli,  model_routes.agent_cli),
				   base_url   = COALESCE(EXCLUDED.base_url,   model_routes.base_url),
				   api_spec   = COALESCE(EXCLUDED.api_spec,   model_routes.api_spec),
				   tier       = COALESCE(EXCLUDED.tier,       model_routes.tier),
				   is_enabled = true
				 RETURNING id`,
				[
					args.model_name,
					args.route_provider,
					args.agent_provider,
					agentCli,
					args.base_url || null,
					args.api_spec || null,
					args.tier || null,
				],
			);

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								registered: true,
								route_id: rows[0].id,
								model_name: args.model_name,
								route_provider: args.route_provider,
								agent_provider: args.agent_provider,
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to register model", err);
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
}
