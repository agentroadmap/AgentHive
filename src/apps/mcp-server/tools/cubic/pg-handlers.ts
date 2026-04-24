/**
 * Postgres-backed Cubic Orchestration MCP Tools (P058)
 *
 * Replaces the filesystem-based cubic storage with Postgres `cubics` table.
 * Handles cubic lifecycle: create, focus (lock), transition, recycle, list.
 *
 * P196: Added activity tracking (cubic_state updates) and lifecycle stats.
 */

import { query } from "../../../../postgres/pool.ts";
import { CubicIdleDetector } from "../../../../core/orchestration/cubic-idle-detector.ts";
import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";

const WORKTREE_ROOT =
	process.env.AGENTHIVE_WORKTREE_ROOT ?? "/data/code/worktree";

function worktreePathFor(name: string): string {
	const safeName = name.trim().replace(/[^A-Za-z0-9._-]+/g, "-");
	return `${WORKTREE_ROOT}/${safeName}`;
}

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
		agents?: string[];
		proposals?: string[];
	}): Promise<CallToolResult> {
		try {
			const { rows } = await query<{
				cubic_id: string;
			}>(
				`INSERT INTO roadmap.cubics (worktree_path, metadata)
				 VALUES ($1, $2)
				 RETURNING cubic_id`,
				[
					worktreePathFor(args.name),
					JSON.stringify({
						name: args.name,
						agents: args.agents ?? ["coder", "reviewer"],
						assignedProposals: args.proposals ?? [],
						phase: "design",
						phaseGate: "G1",
					}),
				],
			);
			const cubicId = rows[0].cubic_id;
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								success: true,
								cubic: {
									id: cubicId,
									name: args.name,
									phase: "design",
									phaseGate: "G1",
									agents: args.agents ?? ["coder", "reviewer"],
									assignedProposals: args.proposals ?? [],
								},
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to create cubic", err);
		}
	}

	async listCubics(args: {
		status?: string;
		agent?: string;
	}): Promise<CallToolResult> {
		try {
			let sql = `SELECT cubic_id, status, phase, agent_identity, worktree_path, budget_usd,
			              lock_holder, lock_phase, locked_at, created_at, activated_at, completed_at, metadata
			       FROM roadmap.cubics`;
			const params: string[] = [];
			const conditions: string[] = [];

			if (args.status) {
				conditions.push(`status = $${params.length + 1}`);
				params.push(args.status);
			}
			if (args.agent) {
				conditions.push(`agent_identity = $${params.length + 1}`);
				params.push(args.agent);
			}
			if (conditions.length) {
				sql += ` WHERE ${conditions.join(" AND ")}`;
			}
			sql += ` ORDER BY created_at DESC`;

			const { rows } = await query(sql, params);
			if (!rows.length) {
				return { content: [{ type: "text", text: "No cubics found." }] };
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
				...(typeof r.metadata === "object" && r.metadata !== null
					? r.metadata
					: {}),
			}));
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({ total: cubics.length, cubics }, null, 2),
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
					args.worktree_path ?? null,
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
