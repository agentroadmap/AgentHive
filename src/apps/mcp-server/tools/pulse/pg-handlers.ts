/**
 * Postgres-backed Pulse Fleet Observability MCP Tools (P063)
 *
 * Tracks agent heartbeats, infers agent status from heartbeat patterns,
 * and provides fleet-level health metrics.
 */

import { query } from "../../../../postgres/pool.ts";
import type { McpServer } from "../../server.ts";
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

/** Thresholds for status inference */
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const OFFLINE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const CRASH_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

type AgentHealthRow = {
	agent_identity: string;
	last_heartbeat_at: string;
	status: string;
	current_task: string | null;
	current_proposal: number | null;
	current_cubic: string | null;
	cpu_percent: string | null;
	memory_mb: number | null;
	active_model: string | null;
	uptime_seconds: number | null;
	metadata: unknown;
	updated_at: string;
};

/**
 * Infer current status from last heartbeat timestamp.
 */
function inferStatus(lastHeartbeat: Date): string {
	const age = Date.now() - lastHeartbeat.getTime();
	if (age < STALE_THRESHOLD_MS) return "healthy";
	if (age < OFFLINE_THRESHOLD_MS) return "stale";
	if (age < CRASH_THRESHOLD_MS) return "offline";
	return "crashed";
}

export class PgPulseHandlers {
	constructor(private readonly core: McpServer) {}

	/**
	 * Record a heartbeat from an agent.
	 * Upserts into agent_health and appends to heartbeat_log.
	 */
	async recordHeartbeat(args: {
		agent_identity: string;
		current_task?: string;
		current_proposal?: string;
		current_cubic?: string;
		cpu_percent?: number;
		memory_mb?: number;
		active_model?: string;
		uptime_seconds?: number;
		metadata?: string;
	}): Promise<CallToolResult> {
		try {
			const now = new Date();
			const metaObj = args.metadata ? JSON.parse(args.metadata) : {};

			// Upsert agent_health
			await query(
				`INSERT INTO roadmap_workforce.agent_health
				 (agent_identity, last_heartbeat_at, status, current_task, current_proposal,
				  current_cubic, cpu_percent, memory_mb, active_model, uptime_seconds, metadata)
				 VALUES ($1, $2, 'healthy', $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
				 ON CONFLICT (agent_identity) DO UPDATE SET
				     last_heartbeat_at = $2,
				     status = 'healthy',
				     current_task = COALESCE($3, agent_health.current_task),
				     current_proposal = COALESCE($4, agent_health.current_proposal),
				     current_cubic = COALESCE($5, agent_health.current_cubic),
				     cpu_percent = $6,
				     memory_mb = $7,
				     active_model = COALESCE($8, agent_health.active_model),
				     uptime_seconds = $9,
				     metadata = agent_health.metadata || $10::jsonb`,
				[
					args.agent_identity,
					now,
					args.current_task ?? null,
					args.current_proposal ? Number(args.current_proposal) : null,
					args.current_cubic ?? null,
					args.cpu_percent ?? null,
					args.memory_mb ?? null,
					args.active_model ?? null,
					args.uptime_seconds ?? null,
					JSON.stringify(metaObj),
				],
			);

			// Append to heartbeat log
			await query(
				`INSERT INTO roadmap_workforce.agent_heartbeat_log
				 (agent_identity, heartbeat_at, cpu_percent, memory_mb, active_model, current_task, metadata)
				 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
				[
					args.agent_identity,
					now,
					args.cpu_percent ?? null,
					args.memory_mb ?? null,
					args.active_model ?? null,
					args.current_task ?? null,
					JSON.stringify(metaObj),
				],
			);

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								success: true,
								agent: args.agent_identity,
								status: "healthy",
								recordedAt: now.toISOString(),
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to record heartbeat", err);
		}
	}

	/**
	 * Get health status for a single agent or all agents.
	 * Infers status from last heartbeat timestamp.
	 */
	async getAgentHealth(args: {
		agent_identity?: string;
	}): Promise<CallToolResult> {
		try {
			let sql: string;
			const params: string[] = [];

			if (args.agent_identity) {
				sql = `SELECT agent_identity, last_heartbeat_at, status, current_task,
				              current_proposal, current_cubic, cpu_percent, memory_mb,
				              active_model, uptime_seconds, metadata, updated_at
				       FROM roadmap_workforce.agent_health
				       WHERE agent_identity = $1`;
				params.push(args.agent_identity);
			} else {
				sql = `SELECT agent_identity, last_heartbeat_at, status, current_task,
				              current_proposal, current_cubic, cpu_percent, memory_mb,
				              active_model, uptime_seconds, metadata, updated_at
				       FROM roadmap_workforce.agent_health
				       ORDER BY last_heartbeat_at DESC`;
			}

			const { rows } = await query<AgentHealthRow>(sql, params);

			if (!rows.length) {
				return {
					content: [{ type: "text", text: "No agent health data found." }],
				};
			}

			const agents = rows.map((r) => {
				const inferredStatus = inferStatus(new Date(r.last_heartbeat_at));
				return {
					agent: r.agent_identity,
					inferredStatus,
					storedStatus: r.status,
					lastHeartbeat: r.last_heartbeat_at,
					currentTask: r.current_task,
					currentProposal: r.current_proposal,
					currentCubic: r.current_cubic,
					cpuPercent: r.cpu_percent ? Number(r.cpu_percent) : null,
					memoryMb: r.memory_mb,
					activeModel: r.active_model,
					uptimeSeconds: r.uptime_seconds,
					...(typeof r.metadata === "object" && r.metadata !== null
						? r.metadata
						: {}),
				};
			});

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({ total: agents.length, agents }, null, 2),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to get agent health", err);
		}
	}

	/**
	 * Get fleet-wide health metrics: counts by status, average uptime,
	 * most active agents, and recent heartbeat rate.
	 */
	async getFleetStatus(): Promise<CallToolResult> {
		try {
			// Get all agents with their last heartbeat
			const { rows } = await query<AgentHealthRow>(
				`SELECT agent_identity, last_heartbeat_at, status, cpu_percent,
				        memory_mb, uptime_seconds, metadata
				 FROM roadmap_workforce.agent_health`,
			);

			if (!rows.length) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									totalAgents: 0,
									healthy: 0,
									stale: 0,
									offline: 0,
									crashed: 0,
									message: "No agents registered.",
								},
								null,
								2,
							),
						},
					],
				};
			}

			// Infer status for each agent
			const statusCounts = { healthy: 0, stale: 0, offline: 0, crashed: 0 };
			let totalUptime = 0;
			let uptimeCount = 0;
			let totalCpu = 0;
			let cpuCount = 0;
			let totalMemory = 0;
			let memoryCount = 0;

			for (const row of rows) {
				const inferred = inferStatus(new Date(row.last_heartbeat_at));
				statusCounts[inferred as keyof typeof statusCounts]++;

				if (row.uptime_seconds) {
					totalUptime += row.uptime_seconds;
					uptimeCount++;
				}
				if (row.cpu_percent) {
					totalCpu += Number(row.cpu_percent);
					cpuCount++;
				}
				if (row.memory_mb) {
					totalMemory += row.memory_mb;
					memoryCount++;
				}
			}

			// Get heartbeat rate in last hour
			const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
			const { rows: recentHeartbeats } = await query<{ cnt: string }>(
				`SELECT COUNT(*) as cnt FROM roadmap_workforce.agent_heartbeat_log
				 WHERE heartbeat_at >= $1`,
				[oneHourAgo],
			);

			// Get top active agents (most heartbeats in last hour)
			const { rows: topAgents } = await query<{
				agent_identity: string;
				cnt: string;
			}>(
				`SELECT agent_identity, COUNT(*) as cnt
				 FROM roadmap_workforce.agent_heartbeat_log
				 WHERE heartbeat_at >= $1
				 GROUP BY agent_identity
				 ORDER BY cnt DESC
				 LIMIT 5`,
				[oneHourAgo],
			);

			// AC#15: cross-reference spending — flag degraded agents with ≥80% daily spend
			const { rows: spendingRows } = await query<{
				agent_identity: string;
				daily_limit_usd: string | null;
				spent_usd: string | null;
				is_frozen: boolean | null;
			}>(
				`SELECT sc.agent_identity,
				        sc.daily_limit_usd,
				        COALESCE(ds.total_usd, 0) AS spent_usd,
				        sc.is_frozen
				 FROM roadmap_efficiency.spending_caps sc
				 LEFT JOIN roadmap.v_daily_spend ds
				   ON ds.agent_identity = sc.agent_identity
				  AND ds.spend_date = CURRENT_DATE`,
			);

			const spendingByAgent = new Map(
				spendingRows.map((r) => [
					r.agent_identity,
					{
						dailyLimitUsd: r.daily_limit_usd ? Number(r.daily_limit_usd) : null,
						spentUsd: Number(r.spent_usd ?? 0),
						isFrozen: r.is_frozen ?? false,
					},
				]),
			);

			// Build status map for quick lookup
			const inferredStatusMap = new Map(
				rows.map((r) => [r.agent_identity, inferStatus(new Date(r.last_heartbeat_at))]),
			);

			const flaggedAgents: Array<{
				agent: string;
				status: string;
				spentUsd: number;
				dailyLimitUsd: number;
				pctUsed: number;
				isFrozen: boolean;
			}> = [];

			for (const [agent, spending] of spendingByAgent) {
				if (spending.dailyLimitUsd === null || spending.dailyLimitUsd === 0) continue;
				const pct = (spending.spentUsd / spending.dailyLimitUsd) * 100;
				if (pct < 80) continue;
				const status = inferredStatusMap.get(agent) ?? "unknown";
				if (status === "healthy") continue; // only flag degraded agents
				flaggedAgents.push({
					agent,
					status,
					spentUsd: spending.spentUsd,
					dailyLimitUsd: spending.dailyLimitUsd,
					pctUsed: Math.round(pct),
					isFrozen: spending.isFrozen,
				});
			}

			const fleet = {
				totalAgents: rows.length,
				...statusCounts,
				healthPercent: Math.round(
					(statusCounts.healthy / rows.length) * 100,
				),
				avgUptimeSeconds: uptimeCount
					? Math.round(totalUptime / uptimeCount)
					: null,
				avgCpuPercent: cpuCount
					? Math.round((totalCpu / cpuCount) * 100) / 100
					: null,
				avgMemoryMb: memoryCount
					? Math.round(totalMemory / memoryCount)
					: null,
				heartbeatsLastHour: Number(recentHeartbeats[0]?.cnt ?? 0),
				topActiveAgents: topAgents.map((r) => ({
					agent: r.agent_identity,
					heartbeats: Number(r.cnt),
				})),
				flaggedAgents,
			};

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(fleet, null, 2),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to get fleet status", err);
		}
	}

	/**
	 * Get heartbeat history for an agent (for trend analysis).
	 */
	async getHeartbeatHistory(args: {
		agent_identity: string;
		limit?: number;
	}): Promise<CallToolResult> {
		try {
			const maxResults = Math.min(args.limit ?? 50, 500);
			const { rows } = await query<{
				heartbeat_at: string;
				cpu_percent: string | null;
				memory_mb: number | null;
				active_model: string | null;
				current_task: string | null;
				metadata: unknown;
			}>(
				`SELECT heartbeat_at, cpu_percent, memory_mb, active_model, current_task, metadata
				 FROM roadmap_workforce.agent_heartbeat_log
				 WHERE agent_identity = $1
				 ORDER BY heartbeat_at DESC
				 LIMIT $2`,
				[args.agent_identity, maxResults],
			);

			if (!rows.length) {
				return {
					content: [
						{
							type: "text",
							text: `No heartbeat history found for agent ${args.agent_identity}.`,
						},
					],
				};
			}

			const history = rows.map((r) => ({
				timestamp: r.heartbeat_at,
				cpuPercent: r.cpu_percent ? Number(r.cpu_percent) : null,
				memoryMb: r.memory_mb,
				activeModel: r.active_model,
				currentTask: r.current_task,
			}));

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								agent: args.agent_identity,
								total: history.length,
								history,
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to get heartbeat history", err);
		}
	}

	/**
	 * Clean up stale agents: mark agents with old heartbeats as stale/offline/crashed.
	 * Returns the number of agents updated.
	 */
	async refreshAgentStatuses(): Promise<CallToolResult> {
		try {
			const now = new Date();
			const staleCutoff = new Date(now.getTime() - STALE_THRESHOLD_MS);
			const offlineCutoff = new Date(now.getTime() - OFFLINE_THRESHOLD_MS);
			const crashCutoff = new Date(now.getTime() - CRASH_THRESHOLD_MS);

			// Mark crashed
			const { rowCount: crashed } = await query(
				`UPDATE roadmap_workforce.agent_health SET status = 'crashed'
				 WHERE last_heartbeat_at < $1 AND status != 'crashed'`,
				[crashCutoff],
			);

			// Mark offline
			const { rowCount: offline } = await query(
				`UPDATE roadmap_workforce.agent_health SET status = 'offline'
				 WHERE last_heartbeat_at < $2 AND last_heartbeat_at >= $1 AND status != 'offline'`,
				[crashCutoff, offlineCutoff],
			);

			// Mark stale
			const { rowCount: stale } = await query(
				`UPDATE roadmap_workforce.agent_health SET status = 'stale'
				 WHERE last_heartbeat_at < $2 AND last_heartbeat_at >= $1 AND status != 'stale'`,
				[offlineCutoff, staleCutoff],
			);

			// Clean old heartbeat logs
			await query(
				`DELETE FROM roadmap_workforce.agent_heartbeat_log WHERE heartbeat_at < $1`,
				[new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)],
			);

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								success: true,
								updated: {
									crashed: crashed ?? 0,
									offline: offline ?? 0,
									stale: stale ?? 0,
								},
								timestamp: now.toISOString(),
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to refresh agent statuses", err);
		}
	}
}
