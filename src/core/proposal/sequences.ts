import type { Proposal, Sequence } from "../../types/index.ts";
import { sortByProposalId } from "../../utils/proposal-sorting.ts";

/**
 * Compute execution sequences (layers) from proposal dependencies.
 * - Sequence 1 contains proposals with no dependencies among the provided set.
 * - Subsequent sequences contain proposals whose dependencies appear in earlier sequences.
 * - Dependencies that reference proposals outside the provided set are ignored for layering.
 * - If cycles exist, any remaining proposals are emitted in a final sequence to ensure each proposal
 *   appears exactly once (consumers may choose to surface a warning in that case).
 */
export function computeSequences(proposals: Proposal[]): {
	unsequenced: Proposal[];
	sequences: Sequence[];
} {
	// Map proposal id -> proposal for fast lookups
	const byId = new Map<string, Proposal>();
	for (const t of proposals) byId.set(t.id, t);

	const allIds = new Set(Array.from(byId.keys()));

	// Build adjacency using only edges within provided set
	const successors = new Map<string, string[]>();
	const indegree = new Map<string, number>();
	for (const id of allIds) {
		successors.set(id, []);
		indegree.set(id, 0);
	}
	for (const t of proposals) {
		const deps = Array.isArray(t.dependencies) ? t.dependencies : [];
		for (const dep of deps) {
			if (!allIds.has(dep)) continue; // ignore external deps for layering
			successors.get(dep)?.push(t.id);
			indegree.set(t.id, (indegree.get(t.id) || 0) + 1);
		}
	}

	// Identify isolated proposals: absolutely no dependencies (even external) AND no internal dependents
	const hasAnyDeps = (t: Proposal) => (t.dependencies || []).length > 0;
	const hasDependents = (id: string) => (successors.get(id) || []).length > 0;

	const unsequenced = sortByProposalId(
		proposals.filter(
			(t) => !hasAnyDeps(t) && !hasDependents(t.id) && t.ordinal === undefined,
		),
	);

	// Build layering set by excluding unsequenced proposals
	const layeringIds = new Set(
		Array.from(allIds).filter((id) => !unsequenced.some((t) => t.id === id)),
	);

	// Kahn-style layered topological grouping on the remainder
	const sequences: Sequence[] = [];
	const remaining = new Set(layeringIds);

	// Prepare local indegree copy considering only remaining proposals
	const indegRem = new Map<string, number>();
	for (const id of remaining) indegRem.set(id, 0);
	for (const id of remaining) {
		const t = byId.get(id);
		if (!t) continue;
		for (const dep of t.dependencies || []) {
			if (remaining.has(dep)) indegRem.set(id, (indegRem.get(id) || 0) + 1);
		}
	}

	while (remaining.size > 0) {
		const layerIds: string[] = [];
		for (const id of remaining) {
			if ((indegRem.get(id) || 0) === 0) layerIds.push(id);
		}

		if (layerIds.length === 0) {
			// Cycle detected; emit all remaining proposals as final layer (deterministic order)
			const finalProposals = sortByProposalId(
				Array.from(remaining)
					.map((id) => byId.get(id))
					.filter((t): t is Proposal => Boolean(t)),
			);
			sequences.push({
				index: sequences.length + 1,
				proposals: finalProposals,
			});
			break;
		}

		const layerProposals = sortByProposalId(
			layerIds
				.map((id) => byId.get(id))
				.filter((t): t is Proposal => Boolean(t)),
		);
		sequences.push({ index: sequences.length + 1, proposals: layerProposals });

		for (const id of layerIds) {
			remaining.delete(id);
			for (const succ of successors.get(id) || []) {
				if (!remaining.has(succ)) continue;
				indegRem.set(succ, (indegRem.get(succ) || 0) - 1);
			}
		}
	}

	return { unsequenced, sequences };
}

/**
 * Return true if the proposal has no dependencies and no dependents among the provided set.
 * Note: Ordinal is intentionally ignored here; computeSequences handles ordinal when grouping.
 */
export function canMoveToUnsequenced(
	proposals: Proposal[],
	proposalId: string,
): boolean {
	const byId = new Map<string, Proposal>(proposals.map((t) => [t.id, t]));
	const t = byId.get(proposalId);
	if (!t) return false;
	const allIds = new Set(byId.keys());
	const hasDeps = (t.dependencies || []).some((d) => allIds.has(d));
	if (hasDeps) return false;
	const hasDependents = proposals.some((x) =>
		(x.dependencies || []).includes(proposalId),
	);
	return !hasDependents;
}

/**
 * Adjust dependencies when moving a proposal to a target sequence index.
 *
 * Rules:
 * - Set moved proposal's dependencies to all proposal IDs from the immediately previous
 *   sequence (targetIndex - 1). If targetIndex is 1, dependencies become [].
 * - Add the moved proposal as a dependency to all proposals in the immediately next
 *   sequence (targetIndex + 1). Duplicates are removed.
 * - Other dependencies remain unchanged for other proposals.
 */
export function adjustDependenciesForMove(
	proposals: Proposal[],
	sequences: Sequence[],
	movedProposalId: string,
	targetSequenceIndex: number,
): Proposal[] {
	// Join semantics: set moved.dependencies to previous sequence proposals (if any),
	// do NOT add moved as a dependency to next-sequence proposals, and do not touch others.
	const byId = new Map<string, Proposal>(
		proposals.map((t) => [t.id, { ...t }]),
	);
	const moved = byId.get(movedProposalId);
	if (!moved) return proposals;

	const prevSeq = sequences.find((s) => s.index === targetSequenceIndex - 1);
	// Exclude the moved proposal itself to avoid creating a self-dependency when moving from seq N to N+1
	const prevIds = prevSeq
		? prevSeq.proposals.map((t) => t.id).filter((id) => id !== movedProposalId)
		: [];

	moved.dependencies = [...prevIds];
	byId.set(moved.id, moved);

	return Array.from(byId.values());
}

/**
 * Insert a new sequence by dropping a proposal between two existing sequences.
 *
 * Semantics (K in [0..N]):
 * - Dropping between Sequence K and K+1 creates a new Sequence K+1 containing the moved proposal.
 * - Update dependencies so that:
 *   - moved.dependencies = all proposal IDs from Sequence K (or [] when K = 0), excluding itself.
 *   - every proposal currently in Sequence K+1 adds the moved proposal ID to its dependencies (deduped).
 * - No other proposals are modified.
 * - Special case when there is no next sequence (K = N): only moved.dependencies are updated.
 * - Special case when K = 0 and there is no next sequence and moved.dependencies remain empty:
 *   assign moved.ordinal = 0 to ensure it participates in layering (avoids Unsequenced bucket).
 */
export function adjustDependenciesForInsertBetween(
	proposals: Proposal[],
	sequences: Sequence[],
	movedProposalId: string,
	betweenK: number,
): Proposal[] {
	const byId = new Map<string, Proposal>(
		proposals.map((t) => [t.id, { ...t }]),
	);
	const moved = byId.get(movedProposalId);
	if (!moved) return proposals;

	// Normalize K to integer within [0..N]
	const maxK = sequences.length;
	const K = Math.max(0, Math.min(maxK, Math.floor(betweenK)));

	const prevSeq = sequences.find((s) => s.index === K);
	const nextSeq = sequences.find((s) => s.index === K + 1);

	const prevIds = prevSeq
		? prevSeq.proposals.map((t) => t.id).filter((id) => id !== movedProposalId)
		: [];
	moved.dependencies = [...prevIds];

	// Update next sequence proposals to depend on moved proposal
	if (nextSeq) {
		for (const t of nextSeq.proposals) {
			const orig = byId.get(t.id);
			if (!orig) continue;
			const deps = Array.isArray(orig.dependencies) ? orig.dependencies : [];
			if (!deps.includes(movedProposalId))
				orig.dependencies = [...deps, movedProposalId];
			byId.set(orig.id, orig);
		}
	} else {
		// No next sequence; if K = 0 and moved has no deps, ensure it stays sequenced
		if (K === 0 && (!moved.dependencies || moved.dependencies.length === 0)) {
			if (moved.ordinal === undefined) moved.ordinal = 0;
		}
	}

	byId.set(moved.id, moved);
	return Array.from(byId.values());
}

/**
 * Reorder proposals within a sequence by assigning ordinal values.
 * Does not modify dependencies. Only proposals in the provided sequenceProposalIds are re-assigned ordinals.
 */
export function reorderWithinSequence(
	proposals: Proposal[],
	sequenceProposalIds: string[],
	movedProposalId: string,
	newIndex: number,
): Proposal[] {
	const seqIds = sequenceProposalIds.filter(
		(id) => id && proposals.some((t) => t.id === id),
	);
	const withoutMoved = seqIds.filter((id) => id !== movedProposalId);
	const clampedIndex = Math.max(0, Math.min(withoutMoved.length, newIndex));
	const newOrder = [
		...withoutMoved.slice(0, clampedIndex),
		movedProposalId,
		...withoutMoved.slice(clampedIndex),
	];

	const byId = new Map<string, Proposal>(
		proposals.map((t) => [t.id, { ...t }]),
	);
	newOrder.forEach((id, idx) => {
		const t = byId.get(id);
		if (t) {
			t.ordinal = idx;
			byId.set(id, t);
		}
	});
	return Array.from(byId.values());
}

/**
 * Plan a move into a target sequence using join semantics.
 * Returns only the proposals that changed (dependencies and/or ordinal).
 */
export function planMoveToSequence(
	allProposals: Proposal[],
	sequences: Sequence[],
	movedProposalId: string,
	targetSequenceIndex: number,
): Proposal[] {
	const updated = adjustDependenciesForMove(
		allProposals,
		sequences,
		movedProposalId,
		targetSequenceIndex,
	);
	// If moving to Sequence 1 and resulting deps are empty, anchor with ordinal 0
	if (targetSequenceIndex === 1) {
		const movedU = updated.find((x) => x.id === movedProposalId);
		if (movedU && (!movedU.dependencies || movedU.dependencies.length === 0)) {
			if (movedU.ordinal === undefined) movedU.ordinal = 0;
		}
	}
	const byIdOrig = new Map(allProposals.map((t) => [t.id, t]));
	const changed: Proposal[] = [];
	for (const u of updated) {
		const orig = byIdOrig.get(u.id);
		if (!orig) continue;
		const depsChanged =
			JSON.stringify(orig.dependencies) !== JSON.stringify(u.dependencies);
		const ordChanged = (orig.ordinal ?? null) !== (u.ordinal ?? null);
		if (depsChanged || ordChanged) changed.push(u);
	}
	return changed;
}

/**
 * Plan a move to Unsequenced. Returns changed proposals or an error message when not eligible.
 */
export function planMoveToUnsequenced(
	allProposals: Proposal[],
	movedProposalId: string,
): { ok: true; changed: Proposal[] } | { ok: false; error: string } {
	if (!canMoveToUnsequenced(allProposals, movedProposalId)) {
		return {
			ok: false,
			error:
				"Cannot move to Unsequenced: proposal has dependencies or dependents",
		};
	}
	const byId = new Map(allProposals.map((t) => [t.id, { ...t }]));
	const moved = byId.get(movedProposalId);
	if (!moved) return { ok: false, error: "Proposal not found" };
	moved.dependencies = [];
	// Clear ordinal to ensure it is considered Unsequenced (no ordinal)
	if (moved.ordinal !== undefined) moved.ordinal = undefined;
	return { ok: true, changed: [moved] };
}
