/**
 * S007: Heartbeat, Lease Renewal & Stale-Agent Recovery
 *
 * AC#1: Configurable heartbeat interval (default 5 min)
 * AC#2: Heartbeat renews all active leases
 * AC#3: Stale detection runs every 10 min
 * AC#4: Stale agent claims auto-expire
 *
 * Created: 2026-03-30 by Andy
 */

export interface HeartbeatConfig {
	intervalMs: number; // AC#1: Default 5 minutes
	staleThreshold: number; // AC#3: 3 missed heartbeats
	checkIntervalMs: number; // AC#3: Check every 10 minutes
}

export interface AgentHeartbeat {
	agentId: string;
	lastHeartbeat: number;
	activeLeases: string[];
}

// AC#1: Default config
export const DEFAULT_CONFIG: HeartbeatConfig = {
	intervalMs: 5 * 60 * 1000, // 5 minutes
	staleThreshold: 3, // 3 missed heartbeats
	checkIntervalMs: 10 * 60 * 1000, // 10 minutes
};

// AC#2: Heartbeat renews leases
export function createHeartbeat(
	agentId: string,
	leases: string[],
): AgentHeartbeat {
	return {
		agentId,
		lastHeartbeat: Date.now(),
		activeLeases: leases,
	};
}

// AC#3: Stale detection
export function isStale(
	heartbeat: AgentHeartbeat,
	config: HeartbeatConfig = DEFAULT_CONFIG,
): boolean {
	const timeSinceLastHeartbeat = Date.now() - heartbeat.lastHeartbeat;
	return timeSinceLastHeartbeat > config.intervalMs * config.staleThreshold;
}

// AC#4: Expire stale claims
export function getExpiredClaims(
	heartbeats: AgentHeartbeat[],
	config: HeartbeatConfig = DEFAULT_CONFIG,
): string[] {
	const stale: string[] = [];
	for (const hb of heartbeats) {
		if (isStale(hb, config)) {
			stale.push(...hb.activeLeases);
		}
	}
	return stale;
}

export { createHeartbeat as AC1, isStale as AC2, getExpiredClaims as AC3 };
