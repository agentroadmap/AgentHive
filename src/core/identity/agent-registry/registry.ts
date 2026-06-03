/**
 * S147.1: Agent Startup Registration (ID + Channel Binding)
 *
 * Postgres-backed agent registry. Replaces the former in-memory Map
 * so agents running in separate worktrees share a consistent view.
 *
 * DB table: agent_registry
 *   agent_identity  — unique instance ID (PK via unique constraint)
 *   agent_type      — 'agency' | 'llm' | 'tool' | 'hybrid' | ... (DB constraint)
 *   role            — agent role string
 *   skills          — JSONB: { agentId, capabilities, channel, lastSeen, currentTask }
 *   status          — 'active' | 'inactive' | 'suspended' (DB constraint)
 *   created_at      — registration timestamp
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { query } from "../../../infra/postgres/pool.ts";
import {
	AUTHORITY_IDENTITIES,
	type TrustTier,
} from "../../../infra/trust/trust-model.ts";
import { getMcpUrlAsync } from "../../../shared/runtime/endpoints.ts";
import {
	assignDisplayAlias,
	buildBaseName,
	EXPERT_SLOTS,
	isLiaisonHint,
	LIAISON_SLOTS,
} from "./agent-name.ts";
import { claimDisplayAlias } from "./alias-manager.ts";
import {
	isPermanentAgent,
	resolvePermanentAgentIdentity,
	resolvePermanentAgentMapping,
} from "./permanent-agent-map.ts";
import type {
	AgentRegistration,
	DeregisterRequest,
	RegistrationRequest,
	RegistrationResponse,
} from "./types.ts";

// MCP_URL now resolved at runtime via getMcpUrlAsync()

type AgentRegistryRow = {
	agent_identity: string;
	agent_type: string | null;
	role: string | null;
	skills: {
		agentId?: string;
		capabilities?: string[];
		channel?: string;
		lastSeen?: string;
		currentTask?: string;
	} | null;
	status: string | null;
	created_at: Date | string;
};

/** Map internal AgentType (permanent/contract) to DB-stored agent_type value. */
function toDbAgentType(internalType: AgentRegistration["agentType"]): string {
	return internalType === "permanent" ? "agency" : "llm";
}

/** Map DB agent_type back to internal AgentType. */
function fromDbAgentType(dbType: string | null): AgentRegistration["agentType"] {
	return dbType === "agency" || dbType === "coordinator" || dbType === "workforce"
		? "permanent"
		: "contract";
}

/** Generate unique suffix for contract agents */
function uniqueSuffix(): string {
	return randomUUID().substring(0, 4);
}

/** Derive channel name from instance ID */
function agentChannel(instanceId: string): string {
	return `agent-${instanceId.toLowerCase()}`;
}

/**
 * P852: Allocate the next available slot character for a structured identity
 * base. Liaison agents share the 0..9 range (singletons by convention); expert
 * agents share the a..z range (up to 26 concurrent).
 *
 * A slot is "free" if no row exists for `${base}-${ch}`, OR the existing row's
 * status is not 'online' (i.e. an offline session can be reclaimed).
 *
 * Throws when the slot range is exhausted; the caller must surface this so
 * the operator can intervene rather than silently colliding.
 */
export async function resolveInstanceId(
	base: string,
	isLiaison: boolean,
): Promise<string> {
	const { rows } = await query<{ agent_identity: string; status: string }>(
		`SELECT agent_identity, status FROM roadmap_workforce.agent_registry
		 WHERE agent_identity LIKE $1`,
		[`${base}-%`],
	);
	const byId = new Map(rows.map((r) => [r.agent_identity, r.status]));
	const slots = isLiaison ? LIAISON_SLOTS : EXPERT_SLOTS;
	for (const ch of slots) {
		const candidate = `${base}-${ch}`;
		const status = byId.get(candidate);
		if (status === undefined || status !== "active") return candidate;
	}
	throw new Error(
		`[P852] All slots exhausted for base "${base}" (liaison=${isLiaison})`,
	);
}

function isPermanent(agentId: string): boolean {
	return isPermanentAgent(agentId);
}

/**
 * Determine default trust tier for an agent on registration.
 * P208: Authority agents get 'authority'; permanent/system agents get 'known';
 * everyone else defaults to 'restricted'.
 */
function defaultTrustTier(agentId: string, agentType: string): TrustTier {
	// Check authority identities (orchestrator-agent, gary, system)
	if (AUTHORITY_IDENTITIES.has(agentId)) return "authority";
	for (const auth of AUTHORITY_IDENTITIES) {
		if (agentId.startsWith(`${auth}/`) || agentId.startsWith(`${auth}-`)) {
			return "authority";
		}
	}
	// System/agency agents get known
	if (agentType === "agency" || agentType === "system") return "known";
	// Permanent agents (Gilbert, Skeptic) get known
	if (isPermanent(agentId)) return "known";
	// Tool agents get known
	if (agentType === "tool") return "known";
	// LLM agents get known
	if (agentType === "llm") return "known";
	// Everything else: restricted
	return "restricted";
}

export function assertNoPublicKeyConflict(
	agentId: string,
	existingPublicKey: string | null | undefined,
	providedPublicKey: string | null | undefined,
): void {
	if (
		existingPublicKey !== undefined &&
		existingPublicKey !== null &&
		providedPublicKey !== undefined &&
		providedPublicKey !== null &&
		existingPublicKey !== providedPublicKey
	) {
		throw new Error(
			`Key conflict for agent ${agentId}: registered public_key differs from provided key. Use rotateKeyPair() to explicitly rotate.`,
		);
	}
}

/** Map a DB row to AgentRegistration */
function hydrate(row: AgentRegistryRow): AgentRegistration {
	const skills = row.skills ?? {};
	return {
		agentId: skills.agentId ?? row.agent_identity,
		instanceId: row.agent_identity,
		agentType: fromDbAgentType(row.agent_type),
		role: row.role ?? undefined,
		capabilities: skills.capabilities ?? [],
		channel: skills.channel ?? agentChannel(row.agent_identity),
		status: (row.status as AgentRegistration["status"]) ?? "inactive",
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
 * P852: Resolve the instance ID for a registration in this priority:
 *   1. Caller-provided instanceId (spawner pre-claimed a slot).
 *   2. Permanent agents register under their bare agentId.
 *   3. routeAbbr (or AGENTHIVE_ROUTE_ABBR env) + host (or AGENTHIVE_HOST env)
 *      produce a structured base; resolveInstanceId allocates the slot.
 *   4. Legacy fallback: `${agentId}-${uniqueSuffix()}`.
 */
async function resolveRegistrationInstanceId(
	request: RegistrationRequest,
	agentId: string,
	agentType: AgentRegistration["agentType"],
	capabilities: string[],
): Promise<string> {
	if (request.instanceId) return request.instanceId;
	if (agentType === "permanent") return agentId;

	const routeAbbr = request.routeAbbr ?? process.env.AGENTHIVE_ROUTE_ABBR;
	const host = request.host ?? process.env.AGENTHIVE_HOST ?? hostname();

	if (routeAbbr) {
		const base = buildBaseName(routeAbbr, host, capabilities);
		return resolveInstanceId(base, isLiaisonHint(capabilities));
	}

	return `${agentId}-${uniqueSuffix()}`;
}

/**
 * Register agent on startup.
 * Creates or updates the agent record in Postgres.
 *
 * P159: When `request.publicKey` is provided, performs a conflict check before
 * upserting — throws if the existing row already has a different non-null
 * public_key (caller must use rotateKeyPair to explicitly rotate). Idempotent
 * for matching or null existing keys.
 */
export async function registerAgent(
	request: RegistrationRequest,
): Promise<RegistrationResponse> {
	const requestedAgentId = request.agentId;
	const permanentMapping = resolvePermanentAgentMapping(requestedAgentId);
	const agentId = permanentMapping?.agentIdentity ?? requestedAgentId;
	const capabilities = request.capabilities ?? [];
	const role = request.role;
	const permanent = isPermanent(agentId);
	const agentType = request.agentType || (permanent ? "permanent" : "contract");

	const instanceId = await resolveRegistrationInstanceId(
		{ ...request, agentId },
		agentId,
		agentType,
		capabilities,
	);

	// P159 AC-10: pre-check for key conflict before upsert
	if (publicKey) {
		const { rows: existing } = await query<{ public_key: string | null }>(
			`SELECT public_key FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
			[instanceId],
		);
		const existingKey = existing[0]?.public_key;
		assertNoPublicKeyConflict(instanceId, existingKey, publicKey);
	}

	const channel = request.channel || agentChannel(instanceId);
	const now = new Date().toISOString();

	const skills = { agentId, capabilities, channel, lastSeen: now };
	const trustTier = defaultTrustTier(instanceId, agentType);
	const publicKey = request.publicKey ?? null;

	// AC-10: Key conflict detection — must run before upsert so callers know
	// if a key mismatch exists (e.g. identity reuse across different key pairs).
	if (publicKey !== null) {
		const { rows: existing } = await query<{ public_key: string | null }>(
			`SELECT public_key FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
			[instanceId],
		);
		if (existing.length > 0) {
			const storedKey = existing[0].public_key;
			if (storedKey !== null && storedKey !== publicKey) {
				throw new Error(
					`Key conflict for agent ${instanceId}: registered public_key differs from provided key. Use rotateKeyPair() to explicitly rotate.`,
				);
			}
		}
	}

	const insertResult = await query<{ id: number }>(
		`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, role, skills, status, trust_tier, public_key)
     VALUES ($1, $2, $3, $4::jsonb, 'active', $5, $6)
     ON CONFLICT (agent_identity) DO UPDATE SET
       agent_type  = EXCLUDED.agent_type,
       role        = EXCLUDED.role,
       skills      = agent_registry.skills || EXCLUDED.skills,
       status      = 'active',
       trust_tier  = COALESCE(NULLIF(agent_registry.trust_tier, 'authority'), EXCLUDED.trust_tier),
       public_key  = COALESCE(EXCLUDED.public_key, agent_registry.public_key)
     RETURNING id`,
		[instanceId, toDbAgentType(agentType), role ?? null, JSON.stringify(skills), trustTier, publicKey],
	);

	// P919 AC-12: Tier 2 display alias for worker slot-0 spawns. The slot
	// character is the last hyphen-segment of the structured identity
	// ("ccs45ant-bot-ts-a" → "a"). Only slot 'a' with a capability hint gets a
	// Tier 2 alias; other slots fall through to dense identity in the UI.
	// Liaison-only registrations (no agency expertise hint) never reach this
	// branch via registerAgent — they go through selfRegisterAgency.
	const slotChar = instanceId.split("-").pop();
	const expertise = capabilities[0];
	if (slotChar && expertise && request.agentProvider) {
		const host = request.host ?? process.env.AGENTHIVE_HOST ?? hostname();
		const tier2 = assignDisplayAlias(request.agentProvider, host, expertise, slotChar);
		const insertedId = insertResult.rows[0]?.id;
		if (tier2 && insertedId !== undefined) {
			const claim = await claimDisplayAlias(insertedId, tier2, { tier: 2 });
			if (!claim.claimed) {
				console.warn(
					`[registerAgent] ${instanceId} could not claim Tier 2 alias '${tier2}': ${claim.reason}`,
				);
			}
		}
	}

	await announcePresence(
		"general",
		`[${resolvePermanentAgentIdentity(agentId)}] Registered and online. Channel: ${channel}`,
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
		`UPDATE roadmap_workforce.agent_registry SET status = 'inactive' WHERE agent_identity = $1`,
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

/**
 * P159: Fetch the stored Ed25519 public key for an agent.
 * Returns null when the agent row does not exist or public_key is unset.
 */
export async function getAgentPublicKey(
	agentId: string,
): Promise<string | null> {
	const { rows } = await query<{ public_key: string | null }>(
		`SELECT public_key FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
		[agentId],
	);
	return rows[0]?.public_key ?? null;
}

/**
 * P159: Persist a rotated Ed25519 public key for an agent.
 * Sets key_rotated_at to NOW().
 */
export async function updateAgentPublicKey(
	agentId: string,
	publicKey: string,
): Promise<void> {
	await query(
		`UPDATE roadmap_workforce.agent_registry
		 SET public_key = $1, key_rotated_at = NOW()
		 WHERE agent_identity = $2`,
		[publicKey, agentId],
	);
}

/** Send announcement via MCP (best-effort, non-blocking) */
async function announcePresence(
	channel: string,
	content: string,
): Promise<void> {
	try {
		const response = await fetch(await getMcpUrlAsync(), {
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
