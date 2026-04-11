/**
 * STATE-77: SpacetimeDB Agent Registry - Dynamic Multi-Model Agent Pool
 *
 * Tables for managing a dynamic pool of agents running different AI models.
 * Supports: Claude, GPT, Gemini, local models, and any custom AI backend.
 */

// ═══════════════════════════════════════════════════════════════════════════
// TABLE: agent_pool - Core agent profiles
// ═══════════════════════════════════════════════════════════════════════════
export interface AgentProfile {
  id: string;                    // Unique agent identifier (e.g., "agent-claude-1")
  template: string;              // Agent template type (e.g., "senior-developer", "tester")
  model: string;                 // AI model (e.g., "claude-3-opus", "gpt-4o", "gemini-pro", "local-llama")
  provider: AgentProvider;       // AI provider: "anthropic", "openai", "google", "local", "custom"
  status: AgentStatus;           // "online" | "idle" | "busy" | "offline" | "error"
  capabilities: string[];        // JSON array of capabilities (e.g., ["typescript", "testing", "threejs"])
  identity: string;              // Agent identity (email, handle, or URI)
  workspace: string;             // Workspace path or identifier
  machineId: string;             // Machine identifier (for multi-host)
  heartbeatAt: string;           // ISO timestamp of last heartbeat
  createdAt: string;             // ISO timestamp when agent registered
  updatedAt: string;             // ISO timestamp of last update
  config: AgentConfig;           // Model-specific configuration
  trustScore: number;            // Trust score 0-100 based on reliability
  claimsCount: number;           // Number of currently claimed proposals
  completedCount: number;        // Number of completed proposals
  errorCount: number;            // Number of errors in recent operations
  lastError?: string;            // Last error message (if any)
}

export type AgentProvider = "anthropic" | "openai" | "google" | "local" | "custom";
export type AgentStatus = "online" | "idle" | "busy" | "offline" | "error";

export interface AgentConfig {
  apiKeyRef?: string;            // Reference to API key (not stored directly)
  baseUrl?: string;              // Custom API endpoint (for local/custom models)
  temperature?: number;          // Model temperature
  maxTokens?: number;            // Max output tokens
  rateLimitPerMinute?: number;   // Rate limit for this agent
  timeoutMs?: number;            // Request timeout in milliseconds
  tags?: Record<string, string>; // Custom metadata tags
}

// ═══════════════════════════════════════════════════════════════════════════
// TABLE: agent_work_claim - Agent claims on roadmap proposals
// ═══════════════════════════════════════════════════════════════════════════
export interface AgentWorkClaim {
  id: string;                    // Unique claim identifier
  agentId: string;               // FK to agent_pool.id
  proposalId: string;               // FK to proposal.id
  claimedAt: string;             // ISO timestamp when claimed
  heartbeatAt: string;           // Last heartbeat for this claim
  expiresAt: string;             // Auto-expire time
  priority: "critical" | "high" | "normal" | "low";
  notes?: string;                // Agent's notes on the claim
}

// ═══════════════════════════════════════════════════════════════════════════
// TABLE: agent_spawn_request - Requests to spawn new agents
// ═══════════════════════════════════════════════════════════════════════════
export interface AgentSpawnRequest {
  id: string;                    // Unique request ID
  requestedBy: string;           // Agent or user who requested the spawn
  template: string;              // Agent template (e.g., "senior-developer")
  model: string;                 // Desired model
  provider: AgentProvider;       // Desired provider
  capabilities: string[];        // Required capabilities
  targetProposalId?: string;        // Optional: proposal to assign to new agent
  status: "pending" | "approved" | "denied" | "completed" | "failed";
  reason: string;                // Reason for spawn request
  createdAt: string;             // ISO timestamp
  resolvedAt?: string;           // ISO timestamp when resolved
  spawnedAgentId?: string;       // ID of spawned agent (if completed)
  denialReason?: string;         // Reason if denied
}

// ═══════════════════════════════════════════════════════════════════════════
// TABLE: agent_heartbeat_log - Heartbeat history for zombie detection
// ═══════════════════════════════════════════════════════════════════════════
export interface AgentHeartbeatLog {
  id: number;                    // Auto-increment
  agentId: string;               // FK to agent_pool.id
  timestamp: string;             // ISO timestamp of heartbeat
  load: number;                  // Agent's self-reported load (0-100)
  claimsCount: number;           // Number of active claims at time of heartbeat
  latencyMs: number;             // Network latency when heartbeat sent
}

// ═══════════════════════════════════════════════════════════════════════════
// TABLE: agent_template - Predefined agent templates
// ═══════════════════════════════════════════════════════════════════════════
export interface AgentTemplate {
  name: string;                  // Template name (e.g., "senior-developer")
  description: string;           // What this template is for
  defaultModel: string;          // Default model for this template
  defaultProvider: AgentProvider;
  requiredCapabilities: string[]; // Capabilities this template must have
  optionalCapabilities: string[]; // Nice-to-have capabilities
  defaultConfig: Partial<AgentConfig>;
  maxConcurrentClaims: number;   // Max proposals this template can claim
  priority: number;              // Template priority (for fallback selection)
}

// ═══════════════════════════════════════════════════════════════════════════
// TABLE: model_registry - Available AI models and providers
// ═══════════════════════════════════════════════════════════════════════════
export interface ModelRegistry {
  id: string;                    // Model identifier (e.g., "claude-3-opus-20240229")
  provider: AgentProvider;       // Provider name
  displayName: string;           // Human-readable name
  modelFamily: string;           // Model family (e.g., "claude", "gpt", "gemini")
  capabilities: string[];        // Model capabilities
  maxContextTokens: number;      // Maximum context window
  costPerInputToken: number;     // Cost per input token (in cents)
  costPerOutputToken: number;    // Cost per output token (in cents)
  isAvailable: boolean;          // Whether this model is currently available
  rateLimitRpm: number;          // Rate limit requests per minute
  rateLimitTpm: number;          // Rate limit tokens per minute
  defaultTemperature: number;
  defaultMaxTokens: number;
  tags: string[];                // Feature tags (e.g., ["vision", "code", "reasoning"])
}
