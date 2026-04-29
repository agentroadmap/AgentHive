/**
 * Postgres-backed Cubic Orchestration MCP Tools (P058)
 *
 * Replaces the filesystem-based cubic storage with Postgres `cubics` table.
 * Handles cubic lifecycle: create, focus (lock), transition, recycle, list.
 *
 * P196: Added activity tracking (cubic_state updates) and lifecycle stats.
 * P462: Added agent identity sanitization to prevent path traversal and collisions.
 */

import { query } from "../../../../postgres/pool.ts";
import { CubicIdleDetector } from "../../../../core/orchestration/cubic-idle-detector.ts";
import {
	safeWorktreePath,
	AgentIdInvalidError,
} from "../../../../shared/identity/sanitize-agent-id.ts";
import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";

const WORKTREE_ROOT =
	process.env.AGENTHIVE_WORKTREE_ROOT ?? "/data/code/worktree";

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

export class PgCubicHandlers {
	private readonly detector = new CubicIdleDetector();

	constructor(private readonly core: McpServer) {}

	async createCubic(args: {
		name: string;
		agent_identity?: string;
		agents?: string[];
		proposals?: string[];
		phase?: string;
	}): Promise<CallToolResult> {
		try {
			// P462: Sanitize cubic name to safe worktree path
			const worktreePath = safeWorktreePath(WORKTREE_ROOT, args.name);

			// P459: Phase-driven role allocation
			const phase = args.phase ?? "design";

			// Fetch phase role configuration
			const phaseRoleResult = await query<{
				default_roles: string[];
				allowed_roles: string[];
			}>(
				`SELECT default_roles, allowed_roles FROM roadmap.cubic_phase_roles WHERE phase = $1`,
				[phase],
			);

			if (!phaseRoleResult.rows.length) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									ok: false,
									error: "invalid_phase",
									phase,
									message: `Phase '${phase}' not found in cubic_phase_roles`,
								},
								null,
								2,
							),
						},
					],
				};
			}

			const phaseRoles = phaseRoleResult.rows[0];
			let agentRoles: string[] = args.agents ?? [];
			// Tracks whether agent_identity is a registered FK-eligible agent or an ad-hoc label
			let registeredAgentIdentity: string | null = null;
			let adHocIdentity: string | undefined;

			// P459: If agent_identity provided, resolve its role and validate against phase
			if (args.agent_identity) {
				// Look up agent's registered role (single query — result used for both validation and FK resolution)
				const agentResult = await query<{ role: string }>(
					`SELECT role FROM roadmap.agent_registry WHERE agent_identity = $1`,
					[args.agent_identity],
				);

				if (agentResult.rows.length) {
					// Registered agent: validate role against phase, store FK-eligible identity
					registeredAgentIdentity = args.agent_identity;
					const agentRole = agentResult.rows[0].role || "developer";

					const roleTokens = agentRole
						.toLowerCase()
						.split(/\s+/)
						.filter((r) => r.length > 0);

					const matchedRole = roleTokens.find((token) =>
						phaseRoles.allowed_roles.includes(token),
					);

					if (!matchedRole) {
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify(
										{
											ok: false,
											error: "phase_role_mismatch",
											phase,
											agent_role: agentRole,
											allowed_roles: phaseRoles.allowed_roles,
											message: `Agent role '${agentRole}' not allowed in phase '${phase}'`,
										},
										null,
										2,
									),
								},
							],
						};
					}

					agentRoles = args.agents ?? [matchedRole];
				} else {
					// P459 design §4: ad-hoc identity — accept as slot label, tag in metadata
					adHocIdentity = args.agent_identity;
					agentRoles = args.agents ?? phaseRoles.default_roles;
				}
			} else if (!args.agents) {
				// P459 AC2: No agent_identity, use phase defaults
				agentRoles = phaseRoles.default_roles;
			}

			// Final validation: all agents must be in allowed_roles (optional arg override still validated)
			const invalidRoles = agentRoles.filter(
				(role) => !phaseRoles.allowed_roles.includes(role),
			);
			if (invalidRoles.length > 0) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									ok: false,
									error: "invalid_agents_for_phase",
									phase,
									invalid_roles: invalidRoles,
									allowed_roles: phaseRoles.allowed_roles,
									message: `Agents ${invalidRoles.join(", ")} not allowed in phase '${phase}'`,
								},
								null,
								2,
							),
						},
					],
				};
			}

			const metadata = JSON.stringify({
				name: args.name,
				agents: agentRoles,
				assignedProposals: args.proposals ?? [],
				phase,
				phaseGate: "G1",
				...(adHocIdentity ? { ad_hoc_identity: adHocIdentity } : {}),
			});

			// P459 AC#102/AC#103: ON CONFLICT on uk_cubics_agent_phase_status (partial index).
			// When two concurrent creates race for the same (agent_identity, phase, status='idle'),
			// the second gets DO UPDATE (no-op) and RETURNING still yields the existing row.
			const { rows } = await query<{
				cubic_id: string;
				was_existing: boolean;
			}>(
				`INSERT INTO roadmap.cubics (worktree_path, phase, status, agent_identity, metadata)
				 VALUES ($1, $2, 'idle', $3, $4)
				 ON CONFLICT (agent_identity, phase, status)
				     WHERE agent_identity IS NOT NULL
				 DO UPDATE SET metadata = roadmap.cubics.metadata
				 RETURNING cubic_id, (xmax <> 0) AS was_existing`,
				[worktreePath, phase, registeredAgentIdentity, metadata],
			);
			const { cubic_id: cubicId, was_existing: wasExisting } = rows[0];
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								success: true,
								was_existing: wasExisting,
								cubic: {
									id: cubicId,
									name: args.name,
									phase,
									phaseGate: "G1",
									agents: agentRoles,
									assignedProposals: args.proposals ?? [],
									...(adHocIdentity ? { ad_hoc_identity: adHocIdentity } : {}),
								},
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			if (err instanceof AgentIdInvalidError) {
				return errorResult("Invalid cubic name", err);
			}
			return errorResult("Failed to create cubic", err);
		}
	}

	async listCubics(args: {
		status?: string;
		agent?: string;
		limit?: number;
		include_metadata?: boolean;
		include_terminal?: boolean;
	}): Promise<CallToolResult> {
		try {
			const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);
			const includeMetadata = args.include_metadata === true;
			const includeTerminal = args.include_terminal === true;

			let sql = `SELECT cubic_id, status, phase, agent_identity, worktree_path, budget_usd,
			              lock_holder, lock_phase, locked_at, created_at, activated_at, completed_at${includeMetadata ? ", metadata" : ""}
			       FROM roadmap.cubics`;
			const params: (string | number)[] = [];
			const conditions: string[] = [];

			if (args.status) {
				conditions.push(`status = $${params.length + 1}`);
				params.push(args.status);
			} else if (!includeTerminal) {
				conditions.push(`status NOT IN ('expired','completed','recycled')`);
			}
			if (args.agent) {
				conditions.push(`agent_identity = $${params.length + 1}`);
				params.push(args.agent);
			}
			if (conditions.length) {
				sql += ` WHERE ${conditions.join(" AND ")}`;
			}
			sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
			params.push(limit);

			const [{ rows }, countResult] = await Promise.all([
				query(sql, params),
				query<{ total: string }>(
					`SELECT COUNT(*)::text AS total FROM roadmap.cubics${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""}`,
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
									note: includeTerminal
										? "No cubics match the filter."
										: "No active/idle cubics. Pass include_terminal=true to see expired/completed.",
								},
								null,
								2,
							),
						},
					],
				};
			}

			const cubics = rows.map((r) => ({
				id: r.cubic_id,
				status: r.status,
				phase: r.phase,
				agent: r.agent_identity,
				worktree: r.worktree_path,
				budget_usd: r.budget_usd,
				lock: r.lock_holder
					? {
							holder: r.lock_holder,
							phase: r.lock_phase,
							lockedAt: r.locked_at,
						}
					: null,
				createdAt: r.created_at,
				activatedAt: r.activated_at,
				completedAt: r.completed_at,
				...(includeMetadata &&
				typeof r.metadata === "object" &&
				r.metadata !== null
					? r.metadata
					: {}),
			}));
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								total: totalMatching,
								returned: cubics.length,
								truncated,
								limit,
								filter: {
									status: args.status ?? (includeTerminal ? "all" : "active+idle"),
									agent: args.agent ?? null,
									include_metadata: includeMetadata,
								},
								cubics,
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to list cubics", err);
		}
	}

	async focusCubic(args: {
		cubicId: string;
		agent: string;
		task: string;
		phase?: string;
	}): Promise<CallToolResult> {
		try {
			// P462: Validate agent identity (note: not stored, just validated)
			const { normalizeAgentId } = await import(
				"../../../../shared/identity/sanitize-agent-id.ts"
			);
			normalizeAgentId(args.agent); // Will throw if invalid

			const { rows: existing } = await query<{
				cubic_id: string;
				status: string;
			}>(`SELECT cubic_id, status FROM roadmap.cubics WHERE cubic_id = $1`, [
				args.cubicId,
			]);
			if (!existing.length) {
				return {
					content: [{ type: "text", text: `Cubic ${args.cubicId} not found.` }],
				};
			}

			await query(
				`UPDATE roadmap.cubics
				 SET lock_holder = $2,
				     lock_phase = COALESCE($3, phase),
				     locked_at = NOW(),
				     status = 'active',
				     activated_at = COALESCE(activated_at, NOW()),
				     metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb
				 WHERE cubic_id = $1`,
				[
					args.cubicId,
					args.agent,
					args.phase ?? null,
					JSON.stringify({ currentTask: args.task }),
				],
			);
			// P196: Update cubic_state activity tracking
			await this.detector.updateActivity(args.cubicId);

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								success: true,
								lock: {
									holder: args.agent,
									phase: args.phase ?? existing[0].status,
									lockedAt: new Date().toISOString(),
								},
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
			return errorResult("Failed to focus cubic", err);
		}
	}

	async transitionCubic(args: {
		cubicId: string;
		toPhase: string;
	}): Promise<CallToolResult> {
		try {
			const { rows: existing } = await query<{ cubic_id: string }>(
				`SELECT cubic_id FROM roadmap.cubics WHERE cubic_id = $1`,
				[args.cubicId],
			);
			if (!existing.length) {
				return {
					content: [{ type: "text", text: `Cubic ${args.cubicId} not found.` }],
				};
			}

			const isComplete = args.toPhase === "complete";
			await query(
				`UPDATE roadmap.cubics
				 SET phase = $2,
				     status = $3,
				     lock_holder = NULL,
				     lock_phase = NULL,
				     locked_at = NULL,
				     completed_at = CASE WHEN $4 THEN NOW() ELSE completed_at END
				 WHERE cubic_id = $1`,
				[
					args.cubicId,
					args.toPhase,
					isComplete ? "complete" : "active",
					isComplete,
				],
			);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								success: true,
								phase: args.toPhase,
								status: isComplete ? "complete" : "active",
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to transition cubic", err);
		}
	}

	async acquireCubic(args: {
		agent_identity: string;
		proposal_id: number;
		phase?: string;
		budget_usd?: number;
		worktree_path?: string;
	}): Promise<CallToolResult> {
		try {
			// P462: Sanitize agent identity (will throw if invalid or collides)
			const { normalizeAgentId, detectCollision } = await import(
				"../../../../shared/identity/sanitize-agent-id.ts"
			);
			normalizeAgentId(args.agent_identity); // Throws if invalid
			const collision = await detectCollision(args.agent_identity);
			if (collision) {
				return errorResult(
					`Agent identity collision`,
					`"${args.agent_identity}" collides with existing "${collision}"`,
				);
			}

			// P462: Sanitize worktree path if provided
			let safePath = args.worktree_path;
			if (args.worktree_path) {
				safePath = safeWorktreePath(WORKTREE_ROOT, args.worktree_path);
			}

			const { rows } = await query<{
				cubic_id: string;
				was_recycled: boolean;
				was_created: boolean;
				status: string;
				worktree_path: string | null;
			}>(
				`SELECT cubic_id, was_recycled, was_created, status, worktree_path
				 FROM roadmap.fn_acquire_cubic($1, $2, $3, $4, $5)`,
				[
					args.agent_identity,
					args.proposal_id,
					args.phase ?? "design",
					args.budget_usd ?? null,
					safePath ?? null,
				],
			);
			const r = rows[0];

			// P196: Update cubic_state activity tracking
			await this.detector.updateActivity(r.cubic_id);

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								success: true,
								cubic_id: r.cubic_id,
								was_recycled: r.was_recycled,
								was_created: r.was_created,
								status: r.status,
								worktree_path: r.worktree_path,
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
			return errorResult("Failed to acquire cubic", err);
		}
	}

	async recycleCubic(args: {
		cubicId: string;
		resetCode?: boolean;
	}): Promise<CallToolResult> {
		try {
			const { rows: existing } = await query<{ cubic_id: string }>(
				`SELECT cubic_id FROM roadmap.cubics WHERE cubic_id = $1`,
				[args.cubicId],
			);
			if (!existing.length) {
				return {
					content: [{ type: "text", text: `Cubic ${args.cubicId} not found.` }],
				};
			}

			await query(
				`UPDATE roadmap.cubics
				 SET phase = 'design',
				     status = 'idle',
				     lock_holder = NULL,
				     lock_phase = NULL,
				     locked_at = NULL,
				     activated_at = NULL,
				     completed_at = NULL,
				     metadata = COALESCE(metadata, '{}'::jsonb) || '{"recycled": true}'::jsonb
				 WHERE cubic_id = $1`,
				[args.cubicId],
			);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{ success: true, message: `Cubic ${args.cubicId} recycled` },
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to recycle cubic", err);
		}
	}
}
