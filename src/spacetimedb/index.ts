/**
 * SpacetimeDB Module
 *
 * Implements STATE-80: SpacetimeDB Agent Registry Implementation
 * Implements STATE-74: SpacetimeDB Proposal Storage Implementation
 *
 * This module provides:
 * - Agent registry replacing agents.yml with database-backed coordination
 * - Proposal storage replacing file-based proposal management with ACID transactions
 *
 * Usage:
 * ```typescript
 * import { AgentRegistry, globalRegistry, SpacetimeDBProposalStorage, globalProposalStorage } from './spacetimedb';
 *
 * // Agent Registry
 * globalRegistry.registerAgent({ id: 'carter', name: 'Carter', ... });
 *
 * // Proposal Storage
 * globalProposalStorage.createProposal({ id: 'STATE-1', title: 'First Proposal', ... });
 * ```
 */

// Core registry
export { AgentRegistry, globalRegistry } from "./registry.ts";
export type { SubscriptionHandle } from "./registry.ts";

// Proposal storage
export { SpacetimeDBProposalStorage, globalProposalStorage } from "./proposal-storage.ts";
export type { ProposalChangeType, ProposalSubscriptionCallback, ProposalSubscriptionHandle } from "./proposal-storage.ts";

// CLI adapter
export {
	SpacetimeDBAdapter,
	createStorage,
	getDefaultAdapter,
	initDefaultAdapter,
	getStorageBackend,
} from "./cli-adapter.ts";
export type {
	CLIProposal,
	CLIProposalQuery,
	StorageBackend,
	SpacetimeDBConfig,
	StorageConfig,
} from "./cli-adapter.ts";
export type {
	CreateProposalInput,
	UpdateProposalInput,
	ProposalQueryFilter,
	ProposalQueryOptions,
	ProposalSortOptions,
	PaginationOptions,
	RoadmapProposalRow,
	ProposalLabelRow,
	ActivityLogRow,
	DatabaseProposalStatus,
	ProposalPriority,
	ProposalLifecycleStatus,
} from "./proposal-types.ts";

// Proposal lifecycle utilities
export {
	STATE_LIFECYCLE_TRANSITIONS,
	toLifecycleStatus,
	validateProposalTransition,
} from "./proposal-types.ts";

// Types
export type {
	AgentAssignment,
	AgentDiscoveryFilter,
	AgentRecord,
	AgentRole,
	AgentStatus,
	ClaimProposalInput,
	HeartbeatConfig,
	PoolSummary,
	RegisterAgentInput,
	ProductTeamRole,
	BuildingTeamRole,
	OperationsTeamRole,
} from "./types.ts";

// Constants from types
export {
	INCOMPATIBLE_ROLE_PAIRS,
	MANDATORY_ROLES,
	MAX_WORKLOAD_PCT,
	STATUS_TRANSITIONS,
	WORKLOAD_PER_STATE,
} from "./types.ts";
