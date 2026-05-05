/**
 * Cross-project dependency nightly consistency job (P602)
 *
 * Runs every 86_400_000 ms (24 h). Builds adjacency list from the live DB,
 * runs BFS cycle detection (cycle_check=true kinds only), and emits
 * proposal_event rows for any cycles or unresolvable project references.
 *
 * Orphan policy: if roadmap.project has no active row for a project_id
 * referenced by an edge, emit cross_dep_orphan_detected with check_skipped=true.
 * This prevents false-positive alerts during partial DB outage (P474 deferred).
 */

import type { Pool } from "pg";
import {
	detectCycles,
	type CrossProjectEdge,
} from "./cross-project-dependency-checker.ts";

async function resolveProjectSlug(
	pool: Pool,
	projectId: bigint,
): Promise<string | null> {
	const { rows } = await pool.query<{ slug: string }>(
		"SELECT slug FROM roadmap.project WHERE project_id = $1 AND status = 'active'",
		[projectId],
	);
	return rows[0]?.slug ?? null;
}

async function emitProposalEvent(
	pool: Pool,
	proposalId: bigint,
	eventType: string,
	payload: Record<string, unknown>,
): Promise<void> {
	await pool.query(
		`INSERT INTO roadmap_proposal.proposal_event (proposal_id, event_type, payload)
		 VALUES ($1, $2, $3::jsonb)`,
		[proposalId, eventType, JSON.stringify(payload)],
	);
}

export async function runCrossDepConsistencyCheck(pool: Pool): Promise<void> {
	// Step 1: Load unresolved edges with cycle_check=true kinds
	const { rows: cycleRows } = await pool.query<{
		edge_id: string;
		from_project_id: string;
		from_proposal_id: string;
		to_project_id: string;
		to_proposal_id: string;
		kind: string;
	}>(
		`SELECT e.edge_id, e.from_project_id, e.from_proposal_id,
		        e.to_project_id, e.to_proposal_id, e.kind
		 FROM dependency.cross_project_dependency e
		 JOIN dependency.dependency_kind_catalog k USING (kind)
		 WHERE e.resolved_at IS NULL AND k.cycle_check = true`,
	);

	const cycleEdges: CrossProjectEdge[] = cycleRows.map((r) => ({
		edgeId: BigInt(r.edge_id),
		fromProjectId: BigInt(r.from_project_id),
		fromProposalId: BigInt(r.from_proposal_id),
		toProjectId: BigInt(r.to_project_id),
		toProposalId: BigInt(r.to_proposal_id),
		kind: r.kind,
	}));

	// Step 2: BFS cycle detection — emit cycle events (cycles are NOT auto-broken)
	const cycles = detectCycles(cycleEdges);
	for (const cycle of cycles) {
		const anchorEdgeId = cycle.cycleEdgeIds[0];
		const anchor = cycleEdges.find((e) => e.edgeId === anchorEdgeId);
		if (!anchor) continue;
		await emitProposalEvent(
			pool,
			anchor.fromProposalId,
			"cross_dep_cycle_detected",
			{ edge_ids: cycle.cycleEdgeIds.map(String) },
		);
	}

	// Step 3: Orphan detection — all unresolved edges (not just cycle_check kinds)
	const { rows: allRows } = await pool.query<{
		edge_id: string;
		from_project_id: string;
		from_proposal_id: string;
		to_project_id: string;
	}>(
		`SELECT edge_id, from_project_id, from_proposal_id, to_project_id
		 FROM dependency.cross_project_dependency
		 WHERE resolved_at IS NULL`,
	);

	// Collect distinct project IDs and resolve them once
	const projectIds = new Set<bigint>();
	for (const r of allRows) {
		projectIds.add(BigInt(r.from_project_id));
		projectIds.add(BigInt(r.to_project_id));
	}

	const unresolvable = new Set<bigint>();
	for (const pid of projectIds) {
		const slug = await resolveProjectSlug(pool, pid);
		if (slug === null) unresolvable.add(pid);
	}

	// Emit orphan event for each edge touching an unresolvable project
	for (const r of allRows) {
		const fromPid = BigInt(r.from_project_id);
		const toPid = BigInt(r.to_project_id);
		if (unresolvable.has(fromPid) || unresolvable.has(toPid)) {
			await emitProposalEvent(
				pool,
				BigInt(r.from_proposal_id),
				"cross_dep_orphan_detected",
				{ edge_id: r.edge_id, check_skipped: true },
			);
		}
	}
}

let jobHandle: ReturnType<typeof setInterval> | null = null;

export function startNightlyConsistencyJob(pool: Pool): void {
	if (jobHandle !== null) return;
	jobHandle = setInterval(() => {
		runCrossDepConsistencyCheck(pool).catch((err) => {
			console.error("[cross-dep-consistency-job] error:", err);
		});
	}, 86_400_000);
}

export function stopNightlyConsistencyJob(): void {
	if (jobHandle !== null) {
		clearInterval(jobHandle);
		jobHandle = null;
	}
}
