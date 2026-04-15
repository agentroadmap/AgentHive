/**
 * Health Checker — zero-cost agent heartbeat monitor.
 *
 * Periodically checks agent heartbeats in agent_registry and marks agents
 * as 'crashed' if no heartbeat received within the crash threshold.
 * Marks as 'stale' within the stale threshold.
 */

import { query } from "../../infra/postgres/pool.ts";
import type { ToolAgent, ToolTask, ToolResult } from "./registry.ts";

interface HealthCheckerConfig {
	staleThresholdSeconds?: number;
	crashThresholdSeconds?: number;
}

interface HeartbeatRow {
	agent_identity: string;
	last_heartbeat_at: string | null;
	status: string;
}

export class HealthChecker implements ToolAgent {
	identity = "tool/health-checker";
	capabilities = ["heartbeat", "crash-detection", "agent-status"];

	private readonly staleThresholdS: number;
	private readonly crashThresholdS: number;

	constructor(config: Record<string, unknown>) {
		const cfg = config as HealthCheckerConfig;
		this.staleThresholdS = cfg.staleThresholdSeconds ?? 300;
		this.crashThresholdS = cfg.crashThresholdSeconds ?? 600;
	}

	async invoke(_task: ToolTask): Promise<ToolResult> {
		const { rows: agents } = await query<HeartbeatRow>(
			`SELECT agent_identity, last_heartbeat_at, status
			   FROM roadmap.agent_registry
			  WHERE status IN ('active', 'stale')
			    AND agent_type != 'tool'`,
		);

		const now = Date.now();
		let markedStale = 0;
		let markedCrashed = 0;

		for (const agent of agents) {
			if (!agent.last_heartbeat_at) {
				continue; // no heartbeat yet, skip
			}

			const heartbeatMs = new Date(agent.last_heartbeat_at).getTime();
			const ageS = (now - heartbeatMs) / 1000;

			if (ageS >= this.crashThresholdS && agent.status !== "crashed") {
				await query(
					`UPDATE roadmap.agent_registry
					    SET status = 'crashed', updated_at = now()
					  WHERE agent_identity = $1`,
					[agent.agent_identity],
				);
				markedCrashed++;
			} else if (
				ageS >= this.staleThresholdS &&
				agent.status === "active"
			) {
				await query(
					`UPDATE roadmap.agent_registry
					    SET status = 'stale', updated_at = now()
					  WHERE agent_identity = $1`,
					[agent.agent_identity],
				);
				markedStale++;
			}
		}

		return {
			success: true,
			output: `Health check: ${agents.length} agents checked, ${markedStale} stale, ${markedCrashed} crashed`,
			tokensUsed: 0,
		};
	}

	async healthCheck(): Promise<boolean> {
		try {
			await query(`SELECT 1`);
			return true;
		} catch {
			return false;
		}
	}
}
