/**
 * STATE-77: SpacetimeDB Reducers - Dynamic Multi-Model Agent Pool
 *
 * Reducers for agent registration, work claiming, heartbeats, spawning, and retirement.
 * These are designed to run inside SpacetimeDB's V8 runtime.
 */

import type {
  AgentProfile,
  AgentProvider,
  AgentStatus,
  AgentWorkClaim,
  AgentSpawnRequest,
  AgentHeartbeatLog,
  AgentTemplate,
  AgentConfig,
} from "../tables/agent-pool.ts";

// ═══════════════════════════════════════════════════════════════════════════
// REDUCER: agent_register - Register or update an agent
// AC#3: Any AI (Claude, GPT, Gemini, local) can register via API
// ═══════════════════════════════════════════════════════════════════════════
export interface RegisterAgentInput {
  id: string;
  template: string;
  model: string;
  provider: AgentProvider;
  capabilities: string[];
  identity: string;
  workspace: string;
  machineId: string;
  config?: Partial<AgentConfig>;
}

export function agent_registerReducer(
  input: RegisterAgentInput,
  ctx: SpacetimeDbContext,
): AgentProfile {
  const now = new Date().toISOString();

  // Check if agent already exists (update scenario)
  const existing = ctx.db.agent_pool.id.find(input.id);

  const profile: AgentProfile = {
    id: input.id,
    template: input.template,
    model: input.model,
    provider: input.provider,
    status: "online",
    capabilities: input.capabilities,
    identity: input.identity,
    workspace: input.workspace,
    machineId: input.machineId,
    heartbeatAt: now,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    config: {
      temperature: input.config?.temperature,
      maxTokens: input.config?.maxTokens,
      rateLimitPerMinute: input.config?.rateLimitPerMinute,
      timeoutMs: input.config?.timeoutMs,
      ...input.config,
    },
    trustScore: existing?.trustScore ?? 50, // Start at neutral trust
    claimsCount: existing?.claimsCount ?? 0,
    completedCount: existing?.completedCount ?? 0,
    errorCount: existing?.errorCount ?? 0,
  };

  if (existing) {
    ctx.db.agent_pool.id.update(existing, profile);
  } else {
    ctx.db.agent_pool.insert(profile);
  }

  // Log the registration
  ctx.db.agent_heartbeat_log.insert({
    id: ctx.db.agent_heartbeat_log.count() + 1,
    agentId: input.id,
    timestamp: now,
    load: 0,
    claimsCount: 0,
    latencyMs: 0,
  });

  return profile;
}

// ═══════════════════════════════════════════════════════════════════════════
// REDUCER: agent_heartbeat - Keep agent alive and detect zombies
// AC#5: Zombie detection via stale heartbeat timestamps
// ═══════════════════════════════════════════════════════════════════════════
export interface HeartbeatInput {
  agentId: string;
  load: number;            // 0-100 self-reported load
  claimsCount: number;     // Current active claims
  latencyMs?: number;      // Network latency
}

export function agent_heartbeatReducer(
  input: HeartbeatInput,
  ctx: SpacetimeDbContext,
): void {
  const agent = ctx.db.agent_pool.id.find(input.agentId);
  if (!agent) {
    throw new Error(`Agent ${input.agentId} not registered`);
  }

  const now = new Date().toISOString();

  // Update agent heartbeat
  ctx.db.agent_pool.id.update(agent, {
    ...agent,
    heartbeatAt: now,
    updatedAt: now,
    claimsCount: input.claimsCount,
    // Update status based on load
    status: input.load >= 90 ? "busy" : input.claimsCount > 0 ? "busy" : "idle",
  });

  // Log heartbeat for history
  ctx.db.agent_heartbeat_log.insert({
    id: ctx.db.agent_heartbeat_log.count() + 1,
    agentId: input.agentId,
    timestamp: now,
    load: input.load,
    claimsCount: input.claimsCount,
    latencyMs: input.latencyMs ?? 0,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// REDUCER: agent_claim_work - Agent claims a proposal for work
// AC#6: MCP command for agent assign
// ═══════════════════════════════════════════════════════════════════════════
export interface ClaimWorkInput {
  agentId: string;
  proposalId: string;
  priority?: "critical" | "high" | "normal" | "low";
  notes?: string;
  ttlMinutes?: number;     // How long the claim lasts (default 60 min)
}

export function agent_claim_workReducer(
  input: ClaimWorkInput,
  ctx: SpacetimeDbContext,
): AgentWorkClaim {
  const agent = ctx.db.agent_pool.id.find(input.agentId);
  if (!agent) {
    throw new Error(`Agent ${input.agentId} not registered`);
  }

  if (agent.status === "offline" || agent.status === "error") {
    throw new Error(`Agent ${input.agentId} is ${agent.status} and cannot claim work`);
  }

  // Check if proposal is already claimed by another agent
  for (const claim of ctx.db.agent_work_claim.iter()) {
    if (claim.proposalId === input.proposalId && claim.expiresAt > new Date().toISOString()) {
      throw new Error(`Proposal ${input.proposalId} already claimed by ${claim.agentId}`);
    }
  }

  const now = new Date();
  const ttlMs = (input.ttlMinutes ?? 60) * 60000;
  const expiresAt = new Date(now.getTime() + ttlMs);

  const claim: AgentWorkClaim = {
    id: `claim-${input.agentId}-${input.proposalId}-${now.getTime()}`,
    agentId: input.agentId,
    proposalId: input.proposalId,
    claimedAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    priority: input.priority ?? "normal",
    notes: input.notes,
  };

  ctx.db.agent_work_claim.insert(claim);

  // Update agent claims count
  ctx.db.agent_pool.id.update(agent, {
    ...agent,
    claimsCount: agent.claimsCount + 1,
    status: "busy",
    updatedAt: now.toISOString(),
  });

  return claim;
}

// ═══════════════════════════════════════════════════════════════════════════
// REDUCER: agent_retire - Retire an agent from the pool
// AC#2: Reducer for retire
// ═══════════════════════════════════════════════════════════════════════════
export interface RetireAgentInput {
  agentId: string;
  reason: string;
  releaseClaims?: boolean;  // Whether to release all claims (default true)
}

export function agent_retireReducer(
  input: RetireAgentInput,
  ctx: SpacetimeDbContext,
): void {
  const agent = ctx.db.agent_pool.id.find(input.agentId);
  if (!agent) {
    throw new Error(`Agent ${input.agentId} not found`);
  }

  const now = new Date().toISOString();

  // Release all claims if requested
  if (input.releaseClaims !== false) {
    for (const claim of ctx.db.agent_work_claim.iter()) {
      if (claim.agentId === input.agentId) {
        ctx.db.agent_work_claim.id.delete(claim);
      }
    }
  }

  // Mark agent as offline
  ctx.db.agent_pool.id.update(agent, {
    ...agent,
    status: "offline",
    claimsCount: 0,
    updatedAt: now,
    lastError: `Retired: ${input.reason}`,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// REDUCER: agent_spawn_request - Request to spawn a new agent
// AC#2: Reducer for spawn
// ═══════════════════════════════════════════════════════════════════════════
export interface SpawnRequestInput {
  requestedBy: string;
  template: string;
  model: string;
  provider: AgentProvider;
  capabilities: string[];
  targetProposalId?: string;
  reason: string;
}

export function agent_spawn_requestReducer(
  input: SpawnRequestInput,
  ctx: SpacetimeDbContext,
): AgentSpawnRequest {
  const now = new Date().toISOString();

  const request: AgentSpawnRequest = {
    id: `spawn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    requestedBy: input.requestedBy,
    template: input.template,
    model: input.model,
    provider: input.provider,
    capabilities: input.capabilities,
    targetProposalId: input.targetProposalId,
    status: "pending",
    reason: input.reason,
    createdAt: now,
  };

  ctx.db.agent_spawn_request.insert(request);
  return request;
}

// ═══════════════════════════════════════════════════════════════════════════
// REDUCER: agent_resolve_spawn - Approve/deny a spawn request
// ═══════════════════════════════════════════════════════════════════════════
export interface ResolveSpawnInput {
  requestId: string;
  approved: boolean;
  resolvedBy: string;
  denialReason?: string;
  spawnedAgentId?: string;
}

export function agent_resolve_spawnReducer(
  input: ResolveSpawnInput,
  ctx: SpacetimeDbContext,
): void {
  const request = ctx.db.agent_spawn_request.id.find(input.requestId);
  if (!request) {
    throw new Error(`Spawn request ${input.requestId} not found`);
  }

  const now = new Date().toISOString();

  ctx.db.agent_spawn_request.id.update(request, {
    ...request,
    status: input.approved ? "completed" : "denied",
    resolvedAt: now,
    spawnedAgentId: input.spawnedAgentId,
    denialReason: input.denialReason,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SCHEDULED REDUCER: agent_detect_zombies - Scheduled heartbeat check
// AC#5: Zombie detection via stale heartbeat timestamps
// Runs every 5 minutes to detect stale agents
// ═══════════════════════════════════════════════════════════════════════════
export const ZOMBIE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes without heartbeat = zombie

export function agent_detect_zombiesReducer(
  _input: void,
  ctx: SpacetimeDbContext,
): { zombified: string[] } {
  const now = Date.now();
  const zombified: string[] = [];

  for (const agent of ctx.db.agent_pool.iter()) {
    if (agent.status === "offline") continue; // Already offline, skip

    const lastHeartbeat = new Date(agent.heartbeatAt).getTime();
    const age = now - lastHeartbeat;

    if (age > ZOMBIE_THRESHOLD_MS) {
      // Mark as offline
      ctx.db.agent_pool.id.update(agent, {
        ...agent,
        status: "offline",
        updatedAt: new Date().toISOString(),
        lastError: `Zombie detected: no heartbeat for ${Math.round(age / 60000)} minutes`,
      });

      // Release all claims
      for (const claim of ctx.db.agent_work_claim.iter()) {
        if (claim.agentId === agent.id) {
          ctx.db.agent_work_claim.id.delete(claim);
        }
      }

      zombified.push(agent.id);
    }
  }

  return { zombified };
}

// ═══════════════════════════════════════════════════════════════════════════
// SCHEDULED REDUCER: agent_expire_claims - Scheduled claim expiry check
// Runs every 2 minutes to expire stale claims
// ═══════════════════════════════════════════════════════════════════════════
export function agent_expire_claimsReducer(
  _input: void,
  ctx: SpacetimeDbContext,
): { expired: string[] } {
  const now = new Date().toISOString();
  const expired: string[] = [];

  for (const claim of ctx.db.agent_work_claim.iter()) {
    if (claim.expiresAt < now) {
      ctx.db.agent_work_claim.id.delete(claim);

      // Update agent claims count
      const agent = ctx.db.agent_pool.id.find(claim.agentId);
      if (agent && agent.claimsCount > 0) {
        ctx.db.agent_pool.id.update(agent, {
          ...agent,
          claimsCount: agent.claimsCount - 1,
          status: agent.claimsCount - 1 > 0 ? "busy" : "idle",
        });
      }

      expired.push(claim.id);
    }
  }

  return { expired };
}

// ═══════════════════════════════════════════════════════════════════════════
// REDUCER: agent_release_claim - Agent releases a work claim
// ═══════════════════════════════════════════════════════════════════════════
export interface ReleaseClaimInput {
  agentId: string;
  proposalId: string;
  completed?: boolean;  // Whether the work was completed
}

export function agent_release_claimReducer(
  input: ReleaseClaimInput,
  ctx: SpacetimeDbContext,
): void {
  let claimId: string | null = null;

  for (const claim of ctx.db.agent_work_claim.iter()) {
    if (claim.agentId === input.agentId && claim.proposalId === input.proposalId) {
      claimId = claim.id;
      ctx.db.agent_work_claim.id.delete(claim);
      break;
    }
  }

  if (!claimId) {
    throw new Error(`No claim found for agent ${input.agentId} on proposal ${input.proposalId}`);
  }

  const agent = ctx.db.agent_pool.id.find(input.agentId);
  if (agent) {
    ctx.db.agent_pool.id.update(agent, {
      ...agent,
      claimsCount: Math.max(0, agent.claimsCount - 1),
      completedCount: input.completed ? agent.completedCount + 1 : agent.completedCount,
      status: agent.claimsCount - 1 > 0 ? "busy" : "idle",
      updatedAt: new Date().toISOString(),
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// REDUCER: agent_update_status - Agent updates its own status
// ═══════════════════════════════════════════════════════════════════════════
export interface UpdateStatusInput {
  agentId: string;
  status: AgentStatus;
  lastError?: string;
}

export function agent_update_statusReducer(
  input: UpdateStatusInput,
  ctx: SpacetimeDbContext,
): void {
  const agent = ctx.db.agent_pool.id.find(input.agentId);
  if (!agent) {
    throw new Error(`Agent ${input.agentId} not found`);
  }

  ctx.db.agent_pool.id.update(agent, {
    ...agent,
    status: input.status,
    lastError: input.lastError,
    updatedAt: new Date().toISOString(),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Placeholder for SpacetimeDB context type
// In actual SpacetimeDB module, this is provided by the runtime
// ═══════════════════════════════════════════════════════════════════════════
export interface SpacetimeDbContext {
  db: {
    agent_pool: {
      id: { find: (id: string) => AgentProfile | undefined; update: (old: AgentProfile, newProfile: AgentProfile) => void };
      iter: () => Iterable<AgentProfile>;
      count: () => number;
      insert: (profile: AgentProfile) => void;
      status: { indexed: boolean };
    };
    agent_work_claim: {
      id: { find: (id: string) => AgentWorkClaim | undefined; delete: (claim: AgentWorkClaim) => void };
      iter: () => Iterable<AgentWorkClaim>;
      count: () => number;
      insert: (claim: AgentWorkClaim) => void;
    };
    agent_spawn_request: {
      id: { find: (id: string) => AgentSpawnRequest | undefined; update: (old: AgentSpawnRequest, newRequest: AgentSpawnRequest) => void };
      iter: () => Iterable<AgentSpawnRequest>;
      count: () => number;
      insert: (request: AgentSpawnRequest) => void;
    };
    agent_heartbeat_log: {
      iter: () => Iterable<AgentHeartbeatLog>;
      count: () => number;
      insert: (log: AgentHeartbeatLog) => void;
    };
    agent_template: {
      name: { find: (name: string) => AgentTemplate | undefined };
      iter: () => Iterable<AgentTemplate>;
    };
  };
  identity: { toString: () => string };
}
