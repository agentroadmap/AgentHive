/**
 * STATE-77: SpacetimeDB Views - Agent Pool Queries
 *
 * Helper functions for querying the agent pool.
 * AC#4: Orchestrator queries idle agents from DB instead of config files
 */

import type {
  AgentProfile,
  AgentStatus,
  AgentProvider,
  AgentWorkClaim,
} from "../tables/agent-pool.ts";

// ═══════════════════════════════════════════════════════════════════════════
// VIEW: queryIdleAgents - Find agents available for work
// AC#4: Orchestrator queries idle agents from DB instead of config files
// ═══════════════════════════════════════════════════════════════════════════
export interface IdleAgentQuery {
  capabilities?: string[];       // Filter by required capabilities
  provider?: AgentProvider;      // Filter by AI provider
  model?: string;                // Filter by specific model
  template?: string;             // Filter by agent template
  minTrustScore?: number;        // Minimum trust score
  excludeIds?: string[];         // Agent IDs to exclude
  maxClaims?: number;            // Max claims an agent can have
}

export function queryIdleAgents(
  agents: Iterable<AgentProfile>,
  query: IdleAgentQuery = {},
): AgentProfile[] {
  const results: AgentProfile[] = [];

  for (const agent of agents) {
    // Must be idle or online (not busy, offline, or error)
    if (agent.status !== "idle" && agent.status !== "online") continue;

    // Filter by capabilities
    if (query.capabilities?.length) {
      const hasAll = query.capabilities.every(cap =>
        agent.capabilities.includes(cap)
      );
      if (!hasAll) continue;
    }

    // Filter by provider
    if (query.provider && agent.provider !== query.provider) continue;

    // Filter by model
    if (query.model && agent.model !== query.model) continue;

    // Filter by template
    if (query.template && agent.template !== query.template) continue;

    // Filter by trust score
    if (query.minTrustScore && agent.trustScore < query.minTrustScore) continue;

    // Exclude specific agents
    if (query.excludeIds?.includes(agent.id)) continue;

    // Filter by max claims
    if (query.maxClaims !== undefined && agent.claimsCount > query.maxClaims) continue;

    results.push(agent);
  }

  // Sort by trust score (descending) then by claims count (ascending)
  results.sort((a, b) => {
    if (b.trustScore !== a.trustScore) return b.trustScore - a.trustScore;
    return a.claimsCount - b.claimsCount;
  });

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// VIEW: getAgentPoolStats - Get pool statistics
// ═══════════════════════════════════════════════════════════════════════════
export interface AgentPoolStats {
  totalAgents: number;
  onlineAgents: number;
  idleAgents: number;
  busyAgents: number;
  offlineAgents: number;
  errorAgents: number;
  byProvider: Record<AgentProvider, number>;
  byTemplate: Record<string, number>;
  byModel: Record<string, number>;
  totalClaims: number;
  avgTrustScore: number;
}

export function getAgentPoolStats(
  agents: Iterable<AgentProfile>,
): AgentPoolStats {
  const stats: AgentPoolStats = {
    totalAgents: 0,
    onlineAgents: 0,
    idleAgents: 0,
    busyAgents: 0,
    offlineAgents: 0,
    errorAgents: 0,
    byProvider: { anthropic: 0, openai: 0, google: 0, local: 0, custom: 0 },
    byTemplate: {},
    byModel: {},
    totalClaims: 0,
    avgTrustScore: 0,
  };

  let trustScoreSum = 0;

  for (const agent of agents) {
    stats.totalAgents++;
    stats.byProvider[agent.provider]++;
    stats.byTemplate[agent.template] = (stats.byTemplate[agent.template] ?? 0) + 1;
    stats.byModel[agent.model] = (stats.byModel[agent.model] ?? 0) + 1;
    stats.totalClaims += agent.claimsCount;
    trustScoreSum += agent.trustScore;

    switch (agent.status) {
      case "online": stats.onlineAgents++; break;
      case "idle": stats.idleAgents++; break;
      case "busy": stats.busyAgents++; break;
      case "offline": stats.offlineAgents++; break;
      case "error": stats.errorAgents++; break;
    }
  }

  stats.avgTrustScore = stats.totalAgents > 0
    ? Math.round(trustScoreSum / stats.totalAgents)
    : 0;

  return stats;
}

// ═══════════════════════════════════════════════════════════════════════════
// VIEW: selectBestAgent - Select the best agent for a task
// ═══════════════════════════════════════════════════════════════════════════
export interface AgentSelectionCriteria {
  requiredCapabilities: string[];
  preferredProvider?: AgentProvider;
  preferredModel?: string;
  preferredTemplate?: string;
  maxTrustScore?: number;
  minTrustScore?: number;
  maxLoadPercent?: number;      // Max claims as percentage of max
}

export function selectBestAgent(
  agents: Iterable<AgentProfile>,
  criteria: AgentSelectionCriteria,
): AgentProfile | null {
  const idle = queryIdleAgents(agents, {
    capabilities: criteria.requiredCapabilities,
    provider: criteria.preferredProvider,
    model: criteria.preferredModel,
    template: criteria.preferredTemplate,
    minTrustScore: criteria.minTrustScore,
  });

  if (idle.length === 0) return null;

  // Score each agent
  const scored = idle.map(agent => {
    let score = agent.trustScore; // Base score from trust

    // Bonus for preferred model match
    if (criteria.preferredModel && agent.model === criteria.preferredModel) {
      score += 20;
    }

    // Bonus for preferred provider match
    if (criteria.preferredProvider && agent.provider === criteria.preferredProvider) {
      score += 10;
    }

    // Bonus for lower load
    score += (100 - agent.claimsCount * 10);

    // Penalty for errors
    score -= agent.errorCount * 5;

    return { agent, score };
  });

  // Sort by score (descending)
  scored.sort((a, b) => b.score - a.score);

  return scored[0].agent;
}

// ═══════════════════════════════════════════════════════════════════════════
// VIEW: getStaleAgents - Find agents that may need investigation
// ═══════════════════════════════════════════════════════════════════════════
export interface StaleAgent {
  agent: AgentProfile;
  lastHeartbeatMs: number;      // Time since last heartbeat
  staleClaims: AgentWorkClaim[]; // Claims that have expired
}

export function getStaleAgents(
  agents: Iterable<AgentProfile>,
  claims: Iterable<AgentWorkClaim>,
  staleThresholdMs: number = 5 * 60 * 1000, // 5 minutes default
): StaleAgent[] {
  const now = Date.now();
  const staleAgents: StaleAgent[] = [];

  const claimsByAgent = new Map<string, AgentWorkClaim[]>();
  for (const claim of claims) {
    const list = claimsByAgent.get(claim.agentId) ?? [];
    list.push(claim);
    claimsByAgent.set(claim.agentId, list);
  }

  for (const agent of agents) {
    if (agent.status === "offline") continue;

    const lastHeartbeat = new Date(agent.heartbeatAt).getTime();
    const age = now - lastHeartbeat;

    if (age > staleThresholdMs) {
      // Find stale claims for this agent
      const agentClaims = claimsByAgent.get(agent.id) ?? [];
      const staleClaims = agentClaims.filter(c =>
        new Date(c.expiresAt).getTime() < now
      );

      staleAgents.push({
        agent,
        lastHeartbeatMs: age,
        staleClaims,
      });
    }
  }

  // Sort by staleness (most stale first)
  staleAgents.sort((a, b) => b.lastHeartbeatMs - a.lastHeartbeatMs);

  return staleAgents;
}

// ═══════════════════════════════════════════════════════════════════════════
// VIEW: formatAgentStatus - Format agent info for display
// ═══════════════════════════════════════════════════════════════════════════
export function formatAgentStatus(agent: AgentProfile): string {
  const statusIcon: Record<AgentStatus, string> = {
    online: "🟢",
    idle: "⚪",
    busy: "🟡",
    offline: "⚫",
    error: "🔴",
  };

  const providerIcon: Record<AgentProvider, string> = {
    anthropic: "🟣",
    openai: "🟢",
    google: "🔵",
    local: "🟤",
    custom: "⚪",
  };

  return [
    `${statusIcon[agent.status]} ${agent.id}`,
    `   Template: ${agent.template}`,
    `   Model: ${providerIcon[agent.provider]} ${agent.model}`,
    `   Status: ${agent.status} (${agent.claimsCount} claims)`,
    `   Capabilities: ${agent.capabilities.join(", ")}`,
    `   Trust: ${agent.trustScore}/100`,
    `   Last seen: ${agent.heartbeatAt}`,
    agent.lastError ? `   ⚠️ Error: ${agent.lastError}` : "",
  ].filter(Boolean).join("\n");
}
