/**
 * Postgres-backed Agent Registry MCP Tools for AgentHive.
 *
 * Workforce management via the `agent_registry`, `team`, and `team_member` tables.
 * All handler methods catch errors and return MCP text responses instead of throwing.
 * P462: Added agent identity sanitization to prevent collisions and path traversal.
 * P1129: Added agency self-registration fields, registerModel, agencyStart, agencyStatus.
 */

import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
	type AliasReclaimError,
	type AliasReclaimResult,
	forceReleaseAlias,
} from "../../../../core/identity/agent-registry/alias-manager.ts";
import { resolveAgentByIdentityOrAlias } from "../../../../core/identity/agent-registry/registry.ts";
import { resumeAgency } from "../../../../core/orchestration/resolvers/agency-resolver.ts";
import { liaisonResume } from "../../../../infra/agency/liaison-service.ts";
import { query } from "../../../../postgres/pool.ts";
import {
	AgentIdInvalidError,
	detectCollision,
	normalizeAgentId,
} from "../../../../shared/identity/sanitize-agent-id.ts";
import type { CallToolResult } from "../../types.ts";

const execAsync = promisify(exec);

const ALIAS_FORMAT = /^[A-Z][A-Za-z0-9-]{2,63}$/;

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
		display_name?: string;
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

			// P1129: reconcile legacy provider vocabulary
			const PROVIDER_MAP: Record<string, string> = {
				openai: "codex",
				google: "gemini",
			};
			const preferred_provider = args.preferred_provider
				? (PROVIDER_MAP[args.preferred_provider] ?? args.preferred_provider)
				: null;

			const skillsJson = args.skills
				? typeof args.skills === "string"
					? args.skills.trim().startsWith("[") ||
						args.skills.trim().startsWith("{")
						? args.skills
						: JSON.stringify(
								args.skills
									.split(",")
									.map((s) => s.trim())
									.filter(Boolean),
							)
					: JSON.stringify(args.skills)
				: null;

			const { rows } = await query(
				`INSERT INTO roadmap_workforce.agent_registry
				  (agent_identity, agent_type, role, skills,
				   preferred_provider, agent_cli, host_affinity, display_name)
				 VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
				 ON CONFLICT (agent_identity) DO UPDATE SET
				   agent_type        = EXCLUDED.agent_type,
				   role              = EXCLUDED.role,
				   skills            = COALESCE(EXCLUDED.skills, agent_registry.skills),
				   preferred_provider = COALESCE(EXCLUDED.preferred_provider, agent_registry.preferred_provider),
				   agent_cli         = COALESCE(EXCLUDED.agent_cli, agent_registry.agent_cli),
				   host_affinity     = COALESCE(EXCLUDED.host_affinity, agent_registry.host_affinity),
				   display_name      = COALESCE(EXCLUDED.display_name, agent_registry.display_name),
				   updated_at        = now()
				 RETURNING agent_identity, role, status, preferred_provider, display_name`,
				[
					normalizedIdentity,
					args.agent_type || null,
					args.role || null,
					skillsJson,
					preferred_provider,
					args.agent_cli || null,
					args.host_affinity || null,
					args.display_name || null,
				],
			);
			const row = rows[0];
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							agent_identity: row.agent_identity,
							role: row.role,
							status: row.status,
							preferred_provider: row.preferred_provider,
							display_name: row.display_name,
						}),
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
	 * P925: Rename the display_alias of a permanent agent (Tier 1 / Tier 2).
	 * Lookup is by agent_identity OR current display_alias; writes the new alias
	 * and appends an audit entry. Collision is rejected unless force=true + prior
	 * owner is inactive or stale-heartbeat (>90 s).
	 */
	async renameAgent(args: {
		identity: string;
		alias: string;
		force?: boolean;
		operator?: string;
	}): Promise<CallToolResult> {
		try {
			if (!ALIAS_FORMAT.test(args.alias)) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: "invalid_alias_format",
								message: `Alias "${args.alias}" must match ^[A-Z][A-Za-z0-9-]{2,63}$`,
							}),
						},
					],
					isError: true,
				};
			}

			const target = await resolveAgentByIdentityOrAlias(args.identity);
			if (!target) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: "agent_not_found",
								message: `No agent found for identity or alias "${args.identity}"`,
							}),
						},
					],
					isError: true,
				};
			}

			const prior_alias = target.display_alias;

			// No-op if alias is unchanged
			if (prior_alias === args.alias) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								identity: target.agent_identity,
								prior_alias,
								new_alias: args.alias,
								note: "no-op: alias unchanged",
							}),
						},
					],
				};
			}

			// Check collision: another active row holds the new alias
			const { rows: colliders } = await query<{
				id: number;
				agent_identity: string;
				last_heartbeat_at: string | null;
			}>(
				`SELECT ar.id, ar.agent_identity,
				        (SELECT last_heartbeat_at FROM roadmap.agency WHERE agency_id = ar.id) AS last_heartbeat_at
				   FROM roadmap_workforce.agent_registry ar
				  WHERE ar.display_alias = $1
				    AND ar.status NOT IN ('inactive', 'retired')
				    AND ar.id != $2
				  LIMIT 1`,
				[args.alias, target.id],
			);

			if (colliders.length > 0) {
				const collider = colliders[0]!;
				if (!args.force) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									error: "alias_in_use",
									message: `Alias "${args.alias}" is held by active agent "${collider.agent_identity}". Use force=true to override if stale.`,
								}),
							},
						],
						isError: true,
					};
				}
				// force=true: gate on heartbeat freshness
				const hbAt = collider.last_heartbeat_at
					? new Date(collider.last_heartbeat_at)
					: null;
				const isStuck = !hbAt || Date.now() - hbAt.getTime() > 90_000;
				if (!isStuck) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									error: "alias_in_use",
									message: `Agent "${collider.agent_identity}" has a fresh heartbeat; cannot force-override.`,
								}),
							},
						],
						isError: true,
					};
				}
				const releaseResult = await forceReleaseAlias({
					identity: collider.agent_identity,
					force: true,
				});
				if ("code" in releaseResult) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									error: releaseResult.code,
									message: `Failed to release prior alias: ${releaseResult.message}`,
								}),
							},
						],
						isError: true,
					};
				}
			}

			// Write new alias — catch unique constraint race
			const now = new Date().toISOString();
			const auditEntry = JSON.stringify([
				{
					action: "renamed",
					from: prior_alias,
					to: args.alias,
					by: args.operator ?? "operator",
					at: now,
				},
			]);
			try {
				const { rows: updated } = await query<{ id: number }>(
					`UPDATE roadmap_workforce.agent_registry
					    SET display_alias = $2,
					        alias_audit   = COALESCE(alias_audit, '[]'::jsonb) || $3::jsonb
					  WHERE id = $1
					  RETURNING id`,
					[target.id, args.alias, auditEntry],
				);
				if (!updated.length) {
					return errorResult("Rename failed", "UPDATE returned no rows");
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								identity: target.agent_identity,
								prior_alias,
								new_alias: args.alias,
								audit_id: String(updated[0]!.id),
							}),
						},
					],
				};
			} catch (err) {
				const pgErr = err as { code?: string };
				if (pgErr.code === "23505") {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									error: "alias_in_use",
									message: `Alias "${args.alias}" was claimed by another agent concurrently.`,
								}),
							},
						],
						isError: true,
					};
				}
				throw err;
			}
		} catch (err) {
			return errorResult("Failed to rename agent", err);
		}
	}

	/**
	 * P765 AC-2: Operator short-circuit — resume an agency to 'active' from any
	 * non-retired state. Updates both roadmap.agency and provider_registry so
	 * routing and alerting see a consistent status.
	 */
	async resumeAgency(args: { agency_id: string }): Promise<CallToolResult> {
		try {
			await liaisonResume(args.agency_id);
			await resumeAgency(args.agency_id);
			return {
				content: [
					{
						type: "text",
						text: `Agency ${args.agency_id} resumed to 'active'.`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to resume agency", err);
		}
	}

	/**
	 * P1129 AC-2: Agency declares a model it supports.
	 * Upserts into roadmap.model_metadata (FK anchor) then roadmap.model_routes.
	 * Optional probe=true runs `<agent_cli> --model <model_name> -p "x"` and rejects
	 * models that fail the liveness check.
	 */
	async registerModel(args: {
		model_name: string;
		route_provider: string;
		agent_provider: string;
		agent_cli?: string;
		base_url?: string;
		cost_per_1k_input?: number;
		cost_per_1k_output?: number;
		plan_type?: string;
		priority?: number;
		probe?: boolean;
	}): Promise<CallToolResult> {
		try {
			// Optional CLI liveness probe
			if (args.probe && args.agent_cli) {
				try {
					await execAsync(
						`${args.agent_cli} --model ${args.model_name} -p "x"`,
						{ timeout: 5000 },
					);
				} catch (probeErr) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									error: "probe_failed",
									model_name: args.model_name,
									agent_cli: args.agent_cli,
									message: `CLI probe rejected the model: ${probeErr instanceof Error ? probeErr.message : String(probeErr)}`,
								}),
							},
						],
						isError: true,
					};
				}
			}

			// Ensure model_metadata FK anchor exists
			await query(
				`INSERT INTO roadmap.model_metadata (model_name, provider)
				 VALUES ($1, $2)
				 ON CONFLICT (model_name) DO NOTHING`,
				[args.model_name, args.route_provider],
			);

			// Upsert route
			const { rows } = await query(
				`INSERT INTO roadmap.model_routes
				  (model_name, route_provider, agent_provider, agent_cli,
				   base_url, cost_per_1k_input, cost_per_1k_output,
				   plan_type, priority, last_validated_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
				         CASE WHEN $10 THEN now() ELSE NULL END)
				 ON CONFLICT (model_name, route_provider, agent_provider) DO UPDATE SET
				   agent_cli          = COALESCE(EXCLUDED.agent_cli, model_routes.agent_cli),
				   base_url           = COALESCE(EXCLUDED.base_url, model_routes.base_url),
				   cost_per_1k_input  = EXCLUDED.cost_per_1k_input,
				   cost_per_1k_output = EXCLUDED.cost_per_1k_output,
				   plan_type          = COALESCE(EXCLUDED.plan_type, model_routes.plan_type),
				   priority           = EXCLUDED.priority,
				   last_validated_at  = CASE WHEN $10 THEN now() ELSE model_routes.last_validated_at END
				 RETURNING id, model_name, route_provider, agent_provider, priority, plan_type`,
				[
					args.model_name,
					args.route_provider,
					args.agent_provider,
					args.agent_cli ?? null,
					args.base_url ?? null,
					args.cost_per_1k_input ?? 0,
					args.cost_per_1k_output ?? 0,
					args.plan_type ?? null,
					args.priority ?? 10,
					args.probe ?? false,
				],
			);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							registered: true,
							probed: args.probe ?? false,
							route: rows[0],
						}),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to register model", err);
		}
	}

	/**
	 * P1129 AC-3: Start the liaison systemd service for an agency.
	 * Optionally writes an env file before starting.
	 */
	async agencyStart(args: {
		identity: string;
		worktree?: string;
		provider?: string;
	}): Promise<CallToolResult> {
		try {
			const serviceName = `agenthive-agency@${args.identity}.service`;
			const envDir = "/etc/agenthive/agency";
			const envFile = path.join(envDir, `${args.identity}.env`);

			// Write env file if caller supplied optional context values
			if (args.worktree || args.provider) {
				const lines: string[] = [];
				if (args.provider) lines.push(`AGENTHIVE_PROVIDER=${args.provider}`);
				if (args.worktree) lines.push(`AGENTHIVE_WORKTREE=${args.worktree}`);
				try {
					await fs.mkdir(envDir, { recursive: true });
					await fs.writeFile(envFile, lines.join("\n") + "\n", { flag: "w" });
				} catch (fsErr) {
					// Non-fatal: log and continue. Service may already have a valid env.
					console.error(`[agencyStart] env file write failed: ${fsErr}`);
				}
			}

			await execAsync(`sudo systemctl start ${serviceName}`, { timeout: 10000 });

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							started: true,
							service: serviceName,
							env_file: args.worktree || args.provider ? envFile : null,
						}),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to start agency service", err);
		}
	}

	/**
	 * P1129 AC-4: Per-agency runtime state — combines roadmap.agency DB row,
	 * open liaison session, and systemctl ActiveState into one response.
	 */
	async agencyStatus(args: { identity: string }): Promise<CallToolResult> {
		try {
			const [agencyRes, sessionRes] = await Promise.all([
				query<{
					agency_id: string;
					status: string;
					status_reason: string | null;
					provider: string | null;
					host_id: string | null;
					last_heartbeat_at: string | null;
				}>(
					`SELECT agency_id, status, status_reason, provider, host_id, last_heartbeat_at
					   FROM roadmap.agency
					  WHERE agency_id = $1`,
					[args.identity],
				),
				query<{
					session_id: string;
					liaison_host: string | null;
					started_at: string | null;
				}>(
					`SELECT session_id, liaison_host, started_at
					   FROM roadmap.agency_liaison_session
					  WHERE agency_id = $1 AND ended_at IS NULL
					  ORDER BY started_at DESC
					  LIMIT 1`,
					[args.identity],
				),
			]);

			const serviceName = `agenthive-agency@${args.identity}.service`;
			let systemdState: string | null = null;
			try {
				const { stdout } = await execAsync(
					`systemctl show --no-pager -p ActiveState ${serviceName}`,
					{ timeout: 3000 },
				);
				systemdState = stdout.trim().replace("ActiveState=", "");
			} catch {
				systemdState = "unknown";
			}

			const agency = agencyRes.rows[0] ?? null;
			const session = sessionRes.rows[0] ?? null;

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								identity: args.identity,
								db: agency
									? {
											status: agency.status,
											status_reason: agency.status_reason,
											provider: agency.provider,
											host_id: agency.host_id,
											last_heartbeat_at: agency.last_heartbeat_at,
										}
									: null,
								session: session
									? {
											session_id: session.session_id,
											liaison_host: session.liaison_host,
											started_at: session.started_at,
										}
									: null,
								systemd: { service: serviceName, active_state: systemdState },
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to get agency status", err);
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
