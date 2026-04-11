/**
 * DAG Dependency Engine
 *
 * Core module for managing proposal dependencies and enforcing DAG constraints.
 * Provides cycle detection, dependency resolution tracking, and queue priority computation.
 *
 * P050: DAG Dependency Engine
 */

import type {
	CycleCheckResult,
	CreateDependencyInput,
	DependencyQueryFilters,
	DependencyResolutionSummary,
	DependencyType,
	OscillationResult,
	ProposalDependency,
	QueuePriorityFactors,
	ResolveDependencyInput,
} from "./dependency-types.ts";

/** In-memory dependency store (to be replaced with DB in production) */
interface DependencyStore {
	dependencies: Map<number, ProposalDependency>;
	nextId: number;
}

/** Create a new dependency store */
export function createStore(): DependencyStore {
	return {
		dependencies: new Map(),
		nextId: 1,
	};
}

/**
 * Check if adding a dependency would create a cycle using DFS.
 * Returns the cycle path if one would be created.
 */
export function checkCycle(
	store: DependencyStore,
	input: CreateDependencyInput,
): CycleCheckResult {
	const { fromProposalId, toProposalId } = input;

	// Self-reference is always a cycle
	if (fromProposalId === toProposalId) {
		return {
			wouldCreateCycle: true,
			cyclePath: [fromProposalId, toProposalId],
			message: `Self-reference: ${fromProposalId} cannot depend on itself`,
		};
	}

	// Build adjacency list from existing dependencies
	const adjList = new Map<string, string[]>();
	for (const dep of store.dependencies.values()) {
		if (!dep.resolved) {
			if (!adjList.has(dep.fromProposalId)) {
				adjList.set(dep.fromProposalId, []);
			}
			adjList.get(dep.fromProposalId)!.push(dep.toProposalId);
		}
	}

	// Add the proposed dependency
	if (!adjList.has(fromProposalId)) {
		adjList.set(fromProposalId, []);
	}
	adjList.get(fromProposalId)!.push(toProposalId);

	// BFS from toProposalId to see if we can reach fromProposalId
	const visited = new Set<string>();
	const queue: Array<{ node: string; path: string[] }> = [
		{ node: toProposalId, path: [toProposalId] },
	];

	while (queue.length > 0) {
		const { node, path } = queue.shift()!;

		if (node === fromProposalId) {
			// Found a cycle
			const cyclePath = [...path, fromProposalId];
			return {
				wouldCreateCycle: true,
				cyclePath,
				message: `Cycle detected: ${cyclePath.join(" → ")}`,
			};
		}

		if (visited.has(node)) continue;
		visited.add(node);

		const deps = adjList.get(node) ?? [];
		for (const dep of deps) {
			if (!visited.has(dep)) {
				queue.push({ node: dep, path: [...path, dep] });
			}
		}
	}

	return { wouldCreateCycle: false };
}

/**
 * Add a new dependency to the store.
 * Validates that the dependency doesn't create a cycle.
 */
export function addDependency(
	store: DependencyStore,
	input: CreateDependencyInput,
): { success: boolean; dependency?: ProposalDependency; error?: string } {
	// Check for cycles
	const cycleCheck = checkCycle(store, input);
	if (cycleCheck.wouldCreateCycle) {
		return {
			success: false,
			error: cycleCheck.message ?? "Dependency would create a cycle",
		};
	}

	// Check for duplicate dependency
	for (const dep of store.dependencies.values()) {
		if (
			dep.fromProposalId === input.fromProposalId &&
			dep.toProposalId === input.toProposalId &&
			!dep.resolved
		) {
			return {
				success: false,
				error: `Dependency from ${input.fromProposalId} to ${input.toProposalId} already exists`,
			};
		}
	}

	const now = new Date().toISOString();
	const id = store.nextId++;

	const dependency: ProposalDependency = {
		id,
		fromProposalId: input.fromProposalId,
		toProposalId: input.toProposalId,
		dependencyType: input.dependencyType ?? "blocks",
		resolved: false,
		createdAt: now,
		updatedAt: now,
		notes: input.notes,
	};

	store.dependencies.set(id, dependency);

	return { success: true, dependency };
}

/**
 * Resolve or unresolve a dependency.
 */
export function resolveDependency(
	store: DependencyStore,
	input: ResolveDependencyInput,
): { success: boolean; dependency?: ProposalDependency; error?: string } {
	const dependency = store.dependencies.get(input.id);
	if (!dependency) {
		return { success: false, error: `Dependency ${input.id} not found` };
	}

	dependency.resolved = input.resolved;
	dependency.updatedAt = new Date().toISOString();
	if (input.notes) {
		dependency.notes = input.notes;
	}

	store.dependencies.set(input.id, dependency);
	return { success: true, dependency };
}

/**
 * Query dependencies with filters.
 */
export function getDependencies(
	store: DependencyStore,
	filters: DependencyQueryFilters = {},
): ProposalDependency[] {
	const results: ProposalDependency[] = [];

	for (const dep of store.dependencies.values()) {
		if (filters.fromProposalId && dep.fromProposalId !== filters.fromProposalId) {
			continue;
		}
		if (filters.toProposalId && dep.toProposalId !== filters.toProposalId) {
			continue;
		}
		if (filters.dependencyType && dep.dependencyType !== filters.dependencyType) {
			continue;
		}
		if (filters.resolved !== undefined && dep.resolved !== filters.resolved) {
			continue;
		}
		results.push(dep);
	}

	return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Get dependency resolution summary for a proposal.
 */
export function getResolutionSummary(
	store: DependencyStore,
	proposalId: string,
): DependencyResolutionSummary {
	const blockingDeps = getDependencies(store, {
		fromProposalId: proposalId,
		dependencyType: "blocks",
	});

	const unresolved = blockingDeps.filter((d) => !d.resolved);
	const resolved = blockingDeps.filter((d) => d.resolved);

	return {
		proposalId,
		totalBlocking: blockingDeps.length,
		resolvedBlocking: resolved.length,
		unresolvedBlocking: unresolved.length,
		allResolved: unresolved.length === 0,
		unresolvedDetails: unresolved.map((d) => ({
			id: d.id,
			dependsOn: d.toProposalId,
			dependencyType: d.dependencyType,
		})),
	};
}

/**
 * Check if a proposal can be promoted (all blocking dependencies resolved).
 */
export function canPromote(store: DependencyStore, proposalId: string): boolean {
	const summary = getResolutionSummary(store, proposalId);
	return summary.allResolved;
}

/**
 * Get all proposals that depend on a given proposal (dependents).
 */
export function getDependents(
	store: DependencyStore,
	proposalId: string,
): string[] {
	const dependents = new Set<string>();

	for (const dep of store.dependencies.values()) {
		if (dep.toProposalId === proposalId && !dep.resolved) {
			dependents.add(dep.fromProposalId);
		}
	}

	return Array.from(dependents);
}

/**
 * Get all proposals that a given proposal depends on (dependencies).
 */
export function getDependencyIds(
	store: DependencyStore,
	proposalId: string,
): string[] {
	const deps = new Set<string>();

	for (const dep of store.dependencies.values()) {
		if (dep.fromProposalId === proposalId && !dep.resolved) {
			deps.add(dep.toProposalId);
		}
	}

	return Array.from(deps);
}

/**
 * Compute queue priority factors for a proposal.
 * Higher priority = should be processed sooner.
 */
export function computeQueuePriority(
	store: DependencyStore,
	proposalId: string,
	createdAt: string,
): QueuePriorityFactors {
	// Calculate dependency depth using BFS
	const depth = calculateDependencyDepth(store, proposalId);

	// Calculate age in ms
	const ageMs = Date.now() - new Date(createdAt).getTime();

	// Count how many proposals depend on this one (blocking count)
	const blockingCount = getDependents(store, proposalId).length;

	// Priority formula: higher blocking count = higher priority
	// Lower depth = higher priority (closer to being promotable)
	// Older = higher priority (fairness)
	const ageHours = ageMs / (1000 * 60 * 60);
	const priorityScore = blockingCount * 100 - depth * 10 + ageHours;

	return {
		dependencyDepth: depth,
		ageMs,
		blockingCount,
		priorityScore: Math.round(priorityScore * 100) / 100,
	};
}

/**
 * Calculate the maximum dependency depth for a proposal.
 */
function calculateDependencyDepth(
	store: DependencyStore,
	proposalId: string,
	visited: Set<string> = new Set(),
): number {
	if (visited.has(proposalId)) return 0;
	visited.add(proposalId);

	const deps = getDependencyIds(store, proposalId);
	if (deps.length === 0) return 0;

	let maxDepth = 0;
	for (const depId of deps) {
		const depDepth = calculateDependencyDepth(store, depId, visited);
		maxDepth = Math.max(maxDepth, depDepth + 1);
	}

	return maxDepth;
}

/**
 * Detect oscillation patterns in state transitions.
 * A proposal oscillating between states indicates a problem.
 */
export function detectOscillation(
	transitions: Array<{ proposalId: string; fromState: string; toState: string; timestamp: string }>,
	proposalId: string,
	timeWindowMs: number = 60 * 60 * 1000, // 1 hour default
	minTransitions: number = 4,
): OscillationResult {
	const now = Date.now();
	const recentTransitions = transitions.filter((t) => {
		const ts = new Date(t.timestamp).getTime();
		return t.proposalId === proposalId && now - ts <= timeWindowMs;
	});

	if (recentTransitions.length < minTransitions) {
		return {
			proposalId,
			transitionCount: recentTransitions.length,
			timeWindowMs,
			isOscillating: false,
		};
	}

	// Check for alternating pattern (A→B, B→A, A→B, B→A)
	const pattern = recentTransitions.map((t) => `${t.fromState}→${t.toState}`);

	// Detect if same state pair appears repeatedly in alternating form
	const statePairs = new Map<string, number>();
	for (let i = 0; i < recentTransitions.length - 1; i++) {
		const current = recentTransitions[i]!;
		const next = recentTransitions[i + 1]!;
		if (
			current.toState === next.fromState &&
			current.fromState === next.toState
		) {
			const key = `${current.fromState}↔${current.toState}`;
			statePairs.set(key, (statePairs.get(key) ?? 0) + 1);
		}
	}

	const isOscillating = Array.from(statePairs.values()).some((count) => count >= 2);

	return {
		proposalId,
		transitionCount: recentTransitions.length,
		timeWindowMs,
		isOscillating,
		pattern: isOscillating ? pattern : undefined,
	};
}

/**
 * Get the topological order of proposals based on dependencies.
 * Returns proposals in the order they should be processed.
 */
export function topologicalSort(
	store: DependencyStore,
	proposalIds: string[],
): string[] {
	const inDegree = new Map<string, number>();
	const adjList = new Map<string, string[]>();

	// Initialize
	for (const id of proposalIds) {
		inDegree.set(id, 0);
		adjList.set(id, []);
	}

	// Build graph (toProposal depends on fromProposal)
	for (const dep of store.dependencies.values()) {
		if (!dep.resolved && proposalIds.includes(dep.fromProposalId) && proposalIds.includes(dep.toProposalId)) {
			adjList.get(dep.toProposalId)!.push(dep.fromProposalId);
			inDegree.set(dep.fromProposalId, (inDegree.get(dep.fromProposalId) ?? 0) + 1);
		}
	}

	// Kahn's algorithm
	const queue: string[] = [];
	for (const [id, degree] of inDegree) {
		if (degree === 0) queue.push(id);
	}

	const result: string[] = [];
	while (queue.length > 0) {
		const node = queue.shift()!;
		result.push(node);

		for (const neighbor of adjList.get(node) ?? []) {
			const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
			inDegree.set(neighbor, newDegree);
			if (newDegree === 0) queue.push(neighbor);
		}
	}

	return result;
}

/**
 * Remove a dependency by ID.
 */
export function removeDependency(
	store: DependencyStore,
	id: number,
): { success: boolean; error?: string } {
	if (!store.dependencies.has(id)) {
		return { success: false, error: `Dependency ${id} not found` };
	}
	store.dependencies.delete(id);
	return { success: true };
}

/**
 * Get all dependencies for a proposal (both as source and target).
 */
export function getAllRelatedDependencies(
	store: DependencyStore,
	proposalId: string,
): {
	asSource: ProposalDependency[];
	asTarget: ProposalDependency[];
} {
	const asSource: ProposalDependency[] = [];
	const asTarget: ProposalDependency[] = [];

	for (const dep of store.dependencies.values()) {
		if (dep.fromProposalId === proposalId) {
			asSource.push(dep);
		}
		if (dep.toProposalId === proposalId) {
			asTarget.push(dep);
		}
	}

	return { asSource, asTarget };
}
