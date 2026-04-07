/**
 * S147.1: Agent Startup Registration (ID + Channel Binding)
 *
 * Postgres-backed agent registry. Replaces the former in-memory Map
 * so agents running in separate worktrees share a consistent view.
 *
 * DB table: agent_registry
 *   agent_identity  — unique instance ID (PK via unique constraint)
 *   agent_type      — 'permanent' | 'contract'
 *   role            — agent role string
 *   skills          — JSONB: { agentId, capabilities, channel, lastSeen, currentTask }
 *   status          — 'online' | 'offline' | 'busy' | 'error'
 *   created_at      — registration timestamp
 */

import { randomUUID } from "node:crypto";
import { query } from "../../../infra/postgres/pool.ts";
import type {
	AgentRegistration,
	DeregisterRequest,
	RegistrationRequest,
	RegistrationResponse,
} from "./types.ts";

const MCP_URL = process.env.MCP_URL || "http://localhost:6421/mcp";

/** Generate unique suffix for contract agents */
function uniqueSuffix(): string {
	return randomUUID().substring(0, 4);
}

/** Derive channel name from instance ID */
function agentChannel(instanceId: string): string {
	return `agent-${instanceId.toLowerCase()}`;
}

/** Determine if agent is permanent (well-known identities) */
// OpenClaw core team + specialist roles
const PERMANENT_AGENTS = new Set(["Gilbert", "Skeptic"]);
function isPermanent(agentId: string): boolean {
	return PERMANENT_AGENTS.has(agentId);
}

/** Map a DB row to AgentRegistration */
function hydrate(row: any): AgentRegistration {
	const skills = row.skills ?? {};
	return {
		agentId: skills.agentId ?? row.agent_identity,
		instanceId: row.agent_identity,
		agentType: row.agent_type ?? "contract",
		role: row.role ?? undefined,
		capabilities: skills.capabilities ?? [],
		channel: skills.channel ?? agentChannel(row.agent_identity),
		status: row.status ?? "offline",
		registeredAt:
			row.created_at instanceof Date
				? row.created_at.toISOString()
				: String(row.created_at),
		lastSeen:
			skills.lastSeen ??
			(row.created_at instanceof Date
				? row.created_at.toISOString()
				: String(row.created_at)),
		currentTask: skills.currentTask ?? undefined,
	};
}

/**
 * Register agent on startup.
 * Creates or updates the agent record in Postgres.
 */
export async function registerAgent(
	request: RegistrationRequest,
): Promise<RegistrationResponse> {
	const { agentId, capabilities = [], role } = request;
	const permanent = isPermanent(agentId);
	const agentType = request.agentType || (permanent ? "permanent" : "contract");

	const instanceId =
		request.instanceId ||
		(agentType === "contract" ? `${agentId}-${uniqueSuffix()}` : agentId);

	const channel = request.channel || agentChannel(instanceId);
	const now = new Date().toISOString();

	const skills = { agentId, capabilities, channel, lastSeen: now };

	await query(
		`INSERT INTO agent_registry (agent_identity, agent_type, role, skills, status)
     VALUES ($1, $2, $3, $4::jsonb, 'online')
     ON CONFLICT ON CONSTRAINT agent_registry_agent_identity_key
     DO UPDATE SET
       agent_type = EXCLUDED.agent_type,
       role       = EXCLUDED.role,
       skills     = agent_registry.skills || EXCLUDED.skills,
       status     = 'online'`,
		[instanceId, agentType, role ?? null, JSON.stringify(skills)],
	);

	await announcePresence(
		"general",
		`[${agentId}] Registered and online. Channel: ${channel}`,
	);

	return {
		success: true,
		agentId: instanceId,
		channel,
		message: `Registered ${agentType} agent`,
	};
}

/**
 * Deregister agent on shutdown.
 * Marks as offline, preserves history.
 */
export async function deregisterAgent(
	request: DeregisterRequest,
): Promise<void> {
	const { agentId, reason = "graceful shutdown" } = request;

	await query(
		`UPDATE agent_registry SET status = 'offline' WHERE agent_identity = $1`,
		[agentId],
	);

	await announcePresence("general", `[${agentId}] Offline: ${reason}`);
}

/**
 * List all registered agents, optionally filtered by status.
 */
export async function listAgents(filter?: {
	status?: AgentRegistration["status"];
}): Promise<AgentRegistration[]> {
	const where = filter?.status ? `WHERE status = $1` : "";
	const params = filter?.status ? [filter.status] : [];
	const { rows } = await query(
		`SELECT agent_identity, agent_type, role, skills, status, created_at
     FROM agent_registry ${where} ORDER BY agent_identity`,
		params,
	);
	return rows.map(hydrate);
}

/**
 * Get agent by instance ID.
 */
export async function getAgent(
	agentId: string,
): Promise<AgentRegistration | undefined> {
	const { rows } = await query(
		`SELECT agent_identity, agent_type, role, skills, status, created_at
     FROM agent_registry WHERE agent_identity = $1`,
		[agentId],
	);
	return rows.length > 0 ? hydrate(rows[0]) : undefined;
}

/**
 * Update agent status and optionally current task.
 */
export async function updateAgentStatus(
	agentId: string,
	status: AgentRegistration["status"],
	currentTask?: string,
): Promise<void> {
	const now = new Date().toISOString();
	const skillsPatch: Record<string, unknown> = { lastSeen: now };
	if (currentTask !== undefined) skillsPatch.currentTask = currentTask;

	await query(
		`UPDATE agent_registry
     SET status = $1,
         skills = skills || $2::jsonb
     WHERE agent_identity = $3`,
		[status, JSON.stringify(skillsPatch), agentId],
	);
}

/** Send announcement via MCP (best-effort, non-blocking) */
async function announcePresence(
	channel: string,
	content: string,
): Promise<void> {
	try {
		const response = await fetch(MCP_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				method: "tools/call",
				params: {
					name: "msg_send",
					arguments: { channel, content, msg_type: "system" },
				},
			}),
		});
		await response.json();
	} catch {
		// MCP not available — non-fatal, Postgres is the source of truth
	}
}
