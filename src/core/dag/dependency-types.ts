/**
 * Proposal Dependency Types
 *
 * Types and interfaces for the DAG dependency engine.
 * Manages proposal_dependencies table and dependency resolution.
 */

/** Dependency relationship types between proposals */
export type DependencyType = "blocks" | "relates" | "duplicates";

/** A single dependency edge in the proposal DAG */
export interface ProposalDependency {
	/** Unique identifier for this dependency */
	id: number;
	/** The proposal that depends on another */
	fromProposalId: string;
	/** The proposal being depended on */
	toProposalId: string;
	/** Type of dependency relationship */
	dependencyType: DependencyType;
	/** Whether the blocking dependency has been resolved */
	resolved: boolean;
	/** When the dependency was created */
	createdAt: string;
	/** When the dependency was last updated */
	updatedAt: string;
	/** Optional notes about the dependency */
	notes?: string;
}

/** Input for creating a new dependency */
export interface CreateDependencyInput {
	fromProposalId: string;
	toProposalId: string;
	dependencyType?: DependencyType;
	notes?: string;
}

/** Input for resolving a dependency */
export interface ResolveDependencyInput {
	id: number;
	resolved: boolean;
	notes?: string;
}

/** Dependency query filters */
export interface DependencyQueryFilters {
	/** Filter by source proposal */
	fromProposalId?: string;
	/** Filter by target proposal */
	toProposalId?: string;
	/** Filter by dependency type */
	dependencyType?: DependencyType;
	/** Filter by resolved status */
	resolved?: boolean;
}

/** DAG queue priority calculation factors */
export interface QueuePriorityFactors {
	/** Depth in the dependency graph */
	dependencyDepth: number;
	/** How long the proposal has been waiting (age in ms) */
	ageMs: number;
	/** Number of proposals that depend on this one */
	blockingCount: number;
	/** Computed priority score */
	priorityScore: number;
}

/** Result of cycle detection check */
export interface CycleCheckResult {
	/** Whether adding the dependency would create a cycle */
	wouldCreateCycle: boolean;
	/** The cycle path if one exists */
	cyclePath?: string[];
	/** Error message describing the cycle */
	message?: string;
}

/** Dependency resolution summary for a proposal */
export interface DependencyResolutionSummary {
	/** Proposal ID */
	proposalId: string;
	/** Total number of blocking dependencies */
	totalBlocking: number;
	/** Number of resolved blocking dependencies */
	resolvedBlocking: number;
	/** Number of unresolved blocking dependencies */
	unresolvedBlocking: number;
	/** Whether all blocking dependencies are resolved */
	allResolved: boolean;
	/** List of unresolved dependency details */
	unresolvedDetails: Array<{
		id: number;
		dependsOn: string;
		dependencyType: DependencyType;
	}>;
}

/** Oscillation detection result */
export interface OscillationResult {
	/** Proposal ID that is oscillating */
	proposalId: string;
	/** Number of state transitions detected */
	transitionCount: number;
	/** Time window of the transitions */
	timeWindowMs: number;
	/** Whether oscillation was detected */
	isOscillating: boolean;
	/** The detected state transition pattern */
	pattern?: string[];
}
