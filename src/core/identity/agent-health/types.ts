/**
 * S147.3: Agent Communication Verification (Ping/Pong)
 */

export type HealthStatus = "alive" | "stale" | "dead" | "unknown";

export interface PingRequest {
	agentId: string;
	timeoutMs?: number;
}

export interface PongResponse {
	agentId: string;
	status: "ready" | "busy" | "error";
	currentTask?: string;
	uptime: number; // seconds
	lastHeartbeat: string;
	timestamp: string;
}

export interface AgentHealth {
	agentId: string;
	health: HealthStatus;
	lastPing: string;
	lastPong: string | null;
	responseTimeMs: number | null;
	pongData?: PongResponse;
}

export interface HealthConfig {
	heartbeatIntervalMs: number; // default 5min
	aliveThresholdMs: number; // default 30s
	staleThresholdMs: number; // default 120s
	deadThresholdMs: number; // default 120s
}
