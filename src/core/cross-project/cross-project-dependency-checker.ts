/**
 * Cross-project dependency cycle checker (P602)
 *
 * Adapts the BFS algorithm from dependency-engine.ts:72–99 for composite
 * (project_id, proposal_id) node keys. Works across tenant boundaries
 * using BIGINT IDs from dependency.cross_project_dependency.
 *
 * Node key encoding: "${projectId}:${proposalId}"
 * Safe for BIGSERIAL project_id and proposal_id (no colon in numeric IDs).
 */

export type CrossProjectEdge = {
	edgeId: bigint;
	fromProjectId: bigint;
	fromProposalId: bigint;
	toProjectId: bigint;
	toProposalId: bigint;
	kind: string;
};

export type CycleResult = {
	hasCycle: true;
	cycleEdgeIds: bigint[];
};

function nodeKey(projectId: bigint, proposalId: bigint): string {
	return `${projectId}:${proposalId}`;
}

/**
 * Detects all cycles in the given edge set using BFS (queue-based).
 *
 * Only call with edges where cycle_check = true (nightly job pre-filters).
 * Returns one CycleResult per detected cycle, with the edge IDs involved.
 */
export function detectCycles(edges: CrossProjectEdge[]): CycleResult[] {
	const adjList = new Map<string, Array<{ key: string; edgeId: bigint }>>();

	for (const e of edges) {
		const from = nodeKey(e.fromProjectId, e.fromProposalId);
		const to = nodeKey(e.toProjectId, e.toProposalId);
		if (!adjList.has(from)) adjList.set(from, []);
		adjList.get(from)!.push({ key: to, edgeId: e.edgeId });
	}

	const cycles: CycleResult[] = [];
	const globalVisited = new Set<string>();

	for (const startNode of adjList.keys()) {
		if (globalVisited.has(startNode)) continue;

		// BFS: track path set to detect back-edges (cycles)
		const queue: Array<{
			node: string;
			pathSet: Set<string>;
			edgeIds: bigint[];
		}> = [{ node: startNode, pathSet: new Set([startNode]), edgeIds: [] }];

		const visited = new Set<string>();

		while (queue.length > 0) {
			const { node, pathSet, edgeIds } = queue.shift()!;

			if (visited.has(node)) continue;
			visited.add(node);
			globalVisited.add(node);

			for (const { key: neighbor, edgeId } of adjList.get(node) ?? []) {
				if (pathSet.has(neighbor)) {
					cycles.push({ hasCycle: true, cycleEdgeIds: [...edgeIds, edgeId] });
					continue;
				}
				const nextPathSet = new Set(pathSet);
				nextPathSet.add(neighbor);
				queue.push({
					node: neighbor,
					pathSet: nextPathSet,
					edgeIds: [...edgeIds, edgeId],
				});
			}
		}
	}

	return cycles;
}
