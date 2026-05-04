/**
 * Cross-project dependency nightly consistency job (P602)
 *
 * Runs every 86_400_000 ms (24 h). Builds adjacency list from the live DB,
 * runs BFS cycle detection (is_blocking=true kinds only), and emits
 * proposal_event rows for any cycles or unresolvable project references.
 *
 * Orphan policy (AC-6): for each project_id referenced by an unresolved edge,
 * resolve its slug from roadmap.project, then call getProjectDb(slug) to verify
 * tenant DB reachability. If getProjectDb throws (ProjectNotRegistered or
 * TenantDbUnreachable), the project is unresolvable and orphan events are emitted.
 */

import type { Pool } from "pg";
import { getProjectDb } from "../../postgres/pool-registry.ts";
import type { CrossProjectEdge } from "./cross-project-dependency-checker.ts";
import { detectCycles } from "./cross-project-dependency-checker.ts";

async function getSlugForProjectId(
	pool: Pool,
	projectId: bigint,
): Promise<string | null> {
	const { rows } = await pool.query<{ slug: string }>(
		"SELECT slug FROM roadmap.project WHERE project_id = $1",
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
	// Step 1: Load unresolved edges with is_blocking=true kinds
	const { rows: cycleRows } = await pool.query<{
		edge_id: string;
		from_project_id: string;
		to_project_id: string;
		kind_id: string;
		is_blocking: boolean;
		reference_id: string;
		reference_type: string;
	}>(
		`SELECT e.id AS edge_id, e.from_project_id, e.to_project_id,
		        e.kind_id, k.is_blocking, e.reference_id, e.reference_type
		 FROM dependency.cross_project_dependency e
		 JOIN dependency.dependency_kind_catalog k ON k.id = e.kind_id
		 WHERE e.resolved_at IS NULL AND k.is_blocking = true`,
	);

	const cycleEdges: CrossProjectEdge[] = cycleRows.map((r) => ({
		edgeId: BigInt(r.edge_id),
		fromProjectId: BigInt(r.from_project_id),
		toProjectId: BigInt(r.to_project_id),
		kindId: BigInt(r.kind_id),
		referenceId: r.reference_id,
		referenceType: r.reference_type,
		isBlocking: r.is_blocking,
	}));

	// Step 2: BFS cycle detection — emit cycle events (cycles are NOT auto-broken)
	const cycles = detectCycles(cycleEdges);
	for (const cycle of cycles) {
		const anchorEdgeId = cycle.cycleEdgeIds[0];
		const anchor = cycleEdges.find((e) => e.edgeId === anchorEdgeId);
		if (!anchor) continue;
		// Only emit proposal event when the reference is a proposal
		if (anchor.referenceType === "proposal") {
			await emitProposalEvent(
				pool,
				BigInt(anchor.referenceId),
				"cross_dep_cycle_detected",
				{ edge_ids: cycle.cycleEdgeIds.map(String) },
			);
		}
	}

	// Step 3: Orphan detection (AC-6) — all unresolved edges
	const { rows: allRows } = await pool.query<{
		edge_id: string;
		from_project_id: string;
		to_project_id: string;
		reference_id: string;
		reference_type: string;
	}>(
		`SELECT id AS edge_id, from_project_id, to_project_id, reference_id, reference_type
		 FROM dependency.cross_project_dependency
		 WHERE resolved_at IS NULL`,
	);

	// Collect distinct project IDs and verify reachability via getProjectDb (AC-6)
	const projectIds = new Set<bigint>();
	for (const r of allRows) {
		projectIds.add(BigInt(r.from_project_id));
		projectIds.add(BigInt(r.to_project_id));
	}

	const unresolvable = new Set<bigint>();
	for (const pid of projectIds) {
		const slug = await getSlugForProjectId(pool, pid);
		if (slug === null) {
			unresolvable.add(pid);
			continue;
		}
		try {
			await getProjectDb(slug);
		} catch {
			unresolvable.add(pid);
		}
	}

	// Emit orphan event for each edge touching an unresolvable project
	for (const r of allRows) {
		const fromPid = BigInt(r.from_project_id);
		const toPid = BigInt(r.to_project_id);
		if (unresolvable.has(fromPid) || unresolvable.has(toPid)) {
			// Emit proposal event when reference is a proposal; log otherwise
			if (r.reference_type === "proposal") {
				await emitProposalEvent(
					pool,
					BigInt(r.reference_id),
					"cross_dep_orphan_detected",
					{ edge_id: r.edge_id, check_skipped: true },
				);
			}
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
