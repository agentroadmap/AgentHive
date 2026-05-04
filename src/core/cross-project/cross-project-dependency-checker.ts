/**
 * Cross-project dependency cycle checker (P602)
 *
 * Detects circular blocking chains across projects using BFS.
 * Works across tenant boundaries using BIGINT project IDs from
 * dependency.cross_project_dependency.
 *
 * Node key encoding: "${projectId}"
 * A cycle means projectA blocks projectB blocks … blocks projectA.
 */

export type CrossProjectEdge = {
	edgeId: bigint;
	fromProjectId: bigint;
	toProjectId: bigint;
	kindId: bigint;
	referenceId: string;
	referenceType: string;
	isBlocking: boolean;
};

export type CycleResult = {
	hasCycle: true;
	cycleEdgeIds: bigint[];
};

function nodeKey(projectId: bigint): string {
	return `${projectId}`;
}

/**
 * Detects all cross-project cycles in the given edge set using BFS.
 *
 * Only call with edges where isBlocking=true (nightly job pre-filters).
 * Returns one CycleResult per detected cycle, with the edge IDs involved.
 */
export function detectCycles(edges: CrossProjectEdge[]): CycleResult[] {
	const adjList = new Map<string, Array<{ key: string; edgeId: bigint }>>();

	for (const e of edges) {
		const from = nodeKey(e.fromProjectId);
		const to = nodeKey(e.toProjectId);
		if (!adjList.has(from)) adjList.set(from, []);
		const neighbors = adjList.get(from);
		if (neighbors) {
			neighbors.push({ key: to, edgeId: e.edgeId });
		}
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
			const item = queue.shift();
			if (!item) continue;
			const { node, pathSet, edgeIds } = item;

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
