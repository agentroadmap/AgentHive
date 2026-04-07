/**
 * S147.3: Agent Health Check (Ping/Pong)
 *
 * Verifies agent liveness via ping/pong protocol.
 * Supports heartbeat (periodic) and on-demand pings.
 */

import type {
	AgentHealth,
	HealthConfig,
	HealthStatus,
	PingRequest,
	PongResponse,
} from "./types.ts";

const MCP_URL = process.env.MCP_URL || "http://localhost:6421/mcp";

/** Default health config */
const DEFAULT_CONFIG: HealthConfig = {
	heartbeatIntervalMs: 5 * 60 * 1000, // 5 minutes
	aliveThresholdMs: 30 * 1000, // 30 seconds
	staleThresholdMs: 2 * 60 * 1000, // 2 minutes
	deadThresholdMs: 2 * 60 * 1000, // 2 minutes
};

/** In-memory health proposal */
const healthProposal = new Map<string, AgentHealth>();
const pongHistory = new Map<string, PongResponse[]>();

/**
 * Send ping to agent and wait for pong.
 */
export async function pingAgent(request: PingRequest): Promise<AgentHealth> {
	const { agentId, timeoutMs = 30000 } = request;
	const startTime = Date.now();
	const now = new Date().toISOString();

	// Send ping via MCP message
	await sendPing(agentId);

	// Wait for pong (simulated - in real implementation, would await message)
	const pong = await waitForPong(agentId, timeoutMs);

	const responseTimeMs = Date.now() - startTime;
	const health: AgentHealth = {
		agentId,
		health: classifyHealth(responseTimeMs, timeoutMs),
		lastPing: now,
		lastPong: pong ? now : null,
		responseTimeMs: pong ? responseTimeMs : null,
		pongData: pong || undefined,
	};

	healthProposal.set(agentId, health);
	return health;
}

/**
 * Record a pong response from an agent.
 */
export function recordPong(agentId: string, pong: PongResponse): void {
	// Store pong history
	const history = pongHistory.get(agentId) || [];
	history.push(pong);
	pongHistory.set(agentId, history.slice(-100)); // Keep last 100

	// Update health proposal
	const existing = healthProposal.get(agentId);
	healthProposal.set(agentId, {
		agentId,
		health: "alive",
		lastPing: existing?.lastPing || new Date().toISOString(),
		lastPong: new Date().toISOString(),
		responseTimeMs: null, // Will be calculated on next ping
		pongData: pong,
	});
}

/**
 * Get current health status for an agent.
 */
export function getAgentHealth(agentId: string): AgentHealth {
	return (
		healthProposal.get(agentId) || {
			agentId,
			health: "unknown",
			lastPing: "",
			lastPong: null,
			responseTimeMs: null,
		}
	);
}

/**
 * Get health status for all agents.
 */
export function getAllHealth(): AgentHealth[] {
	return Array.from(healthProposal.values());
}

/**
 * Classify health based on response time.
 */
function classifyHealth(
	responseTimeMs: number,
	_timeoutMs: number,
): HealthStatus {
	if (responseTimeMs < DEFAULT_CONFIG.aliveThresholdMs) {
		return "alive";
	} else if (responseTimeMs < DEFAULT_CONFIG.staleThresholdMs) {
		return "stale";
	} else {
		return "dead";
	}
}

/**
 * Check if agent is healthy enough to receive work.
 */
export function isAgentHealthy(agentId: string): boolean {
	const health = getAgentHealth(agentId);
	return health.health === "alive" || health.health === "stale";
}

/**
 * Get agents that need heartbeat check.
 */
export function getStaleAgents(
	thresholdMs: number = DEFAULT_CONFIG.staleThresholdMs,
): string[] {
	const now = Date.now();
	const stale: string[] = [];

	for (const [agentId, health] of healthProposal) {
		const lastSeen = health.lastPong ? new Date(health.lastPong).getTime() : 0;
		if (now - lastSeen > thresholdMs) {
			stale.push(agentId);
		}
	}

	return stale;
}

/** Send ping via MCP */
async function sendPing(agentId: string): Promise<void> {
	try {
		const channel = `agent-${agentId.toLowerCase()}`;
		await fetch(MCP_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "msg_send",
					arguments: { channel, content: "[PING]", msg_type: "ping" },
				},
			}),
		});
	} catch (error) {
		console.error("Ping failed:", error);
	}
}

/** Wait for pong response (placeholder - real impl would use message subscription) */
async function waitForPong(
	_agentId: string,
	_timeoutMs: number,
): Promise<PongResponse | null> {
	// In real implementation, this would wait for a pong message on the agent's channel
	// For now, return null (timeout) since we can't do async waiting in tests easily
	return null;
}

/**
 * Clear health proposal (for testing).
 */
export function clearHealthProposal(): void {
	healthProposal.clear();
	pongHistory.clear();
}
