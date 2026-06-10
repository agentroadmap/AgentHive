/**
 * Postgres-backed Cubic Orchestration MCP Tools (P058)
 *
 * Replaces the filesystem-based cubic storage with Postgres `cubics` table.
 * Handles cubic lifecycle: create, focus (lock), transition, recycle, list.
 *
 * P196: Added activity tracking (cubic_state updates) and lifecycle stats.
 * P462: Added agent identity sanitization to prevent path traversal and collisions.
 */

import { existsSync, statSync } from "node:fs";
import {
	CubicCleanupService,
	checkCubicCreateBudget,
} from "../../../../core/orchestration/cubic-cleanup.ts";
import { CubicIdleDetector } from "../../../../core/orchestration/cubic-idle-detector.ts";
import { query } from "../../../../postgres/pool.ts";
import {
	AgentIdInvalidError,
	safeWorktreePath,
} from "../../../../shared/identity/sanitize-agent-id.ts";
import { getWorktreeRoot } from "../../../../shared/runtime/paths.ts";
import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";

const WORKTREE_ROOT = getWorktreeRoot();

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
	private readonly cleanup = new CubicCleanupService();

	constructor(readonly _core: McpServer) {}

	async createCubic(args: {
		name: string;
		agent_identity?: string;
		agents?: string[];
		proposals?: string[];
		phase?: string;
		project_id?: number;
	}): Promise<CallToolResult> {
		try {
			const project = await this.resolveCubicProject(args.project_id);
			if (!project.ok) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(project.error, null, 2),
						},
					],
				};
			}

			// P462: Sanitize cubic name to safe worktree path
			const worktreePath = safeWorktreePath(project.worktreeRoot, args.name);
			const budget = await checkCubicCreateBudget({
				query,
				worktreeRoot: project.worktreeRoot,
			});
			if (!budget.allowed) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									ok: false,
									error: "BUDGET_EXCEEDED",
									host: budget.hostName,
									active: budget.activeCount,
									max: budget.maxActive,
									message: `Cubic budget exhausted (${budget.activeCount}/${budget.maxActive} active). Wait for cleanup.`,
								},
								null,
								2,
							),
						},
					],
				};
			}

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
				host_name: budget.hostName,
				project_id: project.projectId,
				project_slug: project.projectSlug,
				worktree_root: project.worktreeRoot,
				...(adHocIdentity ? { ad_hoc_identity: adHocIdentity } : {}),
			});

			// P459 AC#102/AC#103: ON CONFLICT on uk_cubics_agent_phase_status (partial index).
			// When two concurrent creates race for the same (agent_identity, phase, status='idle'),
			// the second gets DO UPDATE (no-op) and RETURNING still yields the existing row.
			const { rows } = await query<{
				cubic_id: string;
				was_existing: boolean;
			}>(
				`INSERT INTO roadmap.cubics (worktree_path, phase, status, agent_identity, metadata, project_id)
				 VALUES ($1, $2, 'idle', $3, $4, $5)
				 ON CONFLICT (agent_identity, phase, status)
				     WHERE agent_identity IS NOT NULL
				 DO UPDATE SET metadata = roadmap.cubics.metadata
				 RETURNING cubic_id, (xmax <> 0) AS was_existing`,
				[
					worktreePath,
					phase,
					registeredAgentIdentity,
					metadata,
					project.projectId,
				],
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

	private async resolveCubicProject(projectId?: number): Promise<
		| {
				ok: true;
				projectId: number;
				projectSlug: string | null;
				worktreeRoot: string;
		  }
		| {
				ok: false;
				error: {
					ok: false;
					error: string;
					project_id?: number;
					worktree_root?: string;
					message: string;
				};
		  }
	> {
		if (projectId === undefined || projectId === null) {
			return {
				ok: true,
				projectId: 1,
				projectSlug: "agenthive",
				worktreeRoot: WORKTREE_ROOT,
			};
		}

		const { rows } = await query<{
			project_id: number;
			slug: string;
			worktree_root: string;
		}>(
			`SELECT project_id, slug, worktree_root
			   FROM roadmap.project
			  WHERE project_id = $1
			    AND status = 'active'`,
			[projectId],
		);

		if (!rows.length) {
			return {
				ok: false,
				error: {
					ok: false,
					error: "ERROR_PROJECT_NOT_FOUND",
					project_id: projectId,
					message: `No active project found for project_id=${projectId}`,
				},
			};
		}

		const project = rows[0];
		if (
			!existsSync(project.worktree_root) ||
			!statSync(project.worktree_root).isDirectory()
		) {
			return {
				ok: false,
				error: {
					ok: false,
					error: "ERROR_WORKTREE_NOT_FOUND",
					project_id: project.project_id,
					worktree_root: project.worktree_root,
					message: `Worktree root does not exist for project '${project.slug}'. Run git worktree repair or reprovision the tenant checkout before spawning a cubic.`,
				},
			};
		}

		return {
			ok: true,
			projectId: project.project_id,
			projectSlug: project.slug,
			worktreeRoot: project.worktree_root,
		};
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
									status:
										args.status ?? (includeTerminal ? "all" : "active+idle"),
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
		project_id?: number;
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

			// AC-101: Check project status before acquisition (refuse archived projects)
			if (args.project_id) {
				const projectCheck = await query<{ status: string }>(
					`SELECT status FROM roadmap.project WHERE project_id = $1`,
					[args.project_id],
				);
				if (!projectCheck.rows.length) {
					return errorResult(
						"Project not found",
						new Error(`project_id=${args.project_id} does not exist`),
					);
				}
				if (projectCheck.rows[0].status === "archived") {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										ok: false,
										error: "project_archived",
										project_id: args.project_id,
										message: "Cannot acquire cubic for archived project",
									},
									null,
									2,
								),
							},
						],
					};
				}
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

	async getStats(): Promise<CallToolResult> {
		try {
			const stats = await this.detector.getStats();
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({ stats }, null, 2),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to get cubic stats", err);
		}
	}

	async runCleanup(args: {
		dryRun?: boolean;
		removeWorktrees?: boolean;
	}): Promise<CallToolResult> {
		try {
			const report = await this.cleanup.cleanupStaleCubics({
				dryRun: args.dryRun ?? false,
				removeWorktrees: args.removeWorktrees ?? true,
			});
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								success: true,
								dry_run: args.dryRun ?? false,
								total_stale: report.total_stale,
								expired: report.expired,
								worktrees_removed: report.worktrees_removed,
								errors: report.errors,
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to run cubic cleanup", err);
		}
	}

	async forceReapCubic(args: {
		cubicId: string;
		reason: string;
		actor?: string;
		dryRun?: boolean;
	}): Promise<CallToolResult> {
		try {
			const result = await this.cleanup.forceReapCubic({
				cubicId: args.cubicId,
				reason: args.reason,
				actor: args.actor,
				dryRun: args.dryRun,
			});
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								success: true,
								status: result.action.toLowerCase(),
								cubic_id: result.cubic_id,
								path: result.recovery_path,
								worktree_path: result.worktree_path,
								dirty: result.dirty,
								lease_release_count: result.lease_release_count,
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to force reap cubic", err);
		}
	}
}
