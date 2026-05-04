/**
 * Cross-project dependency service (P602)
 *
 * Sole write path for dependency.cross_project_dependency.
 * Invoked by the MCP tool handler for `add_cross_project_dep`.
 * v1: accepts cycle-creating inserts; post-hoc detection via nightly job.
 */

import type { Pool } from "pg";

export type EdgeInput = {
	fromProjectId: bigint;
	fromProposalId: bigint;
	toProjectId: bigint;
	toProposalId: bigint;
	kind: string;
};

export type AddEdgeResult =
	| { ok: true; edgeId: bigint }
	| { ok: false; error: string };

/**
 * Inserts a cross-project dependency edge.
 *
 * Validates kind against dependency_kind_catalog before insert.
 * Returns a typed error (not a throw) for constraint violations.
 */
export async function addCrossProjectDependency(
	pool: Pool,
	edge: EdgeInput,
): Promise<AddEdgeResult> {
	const kindCheck = await pool.query<{ kind: string }>(
		"SELECT kind FROM dependency.dependency_kind_catalog WHERE kind = $1",
		[edge.kind],
	);
	if ((kindCheck.rowCount ?? 0) === 0) {
		return { ok: false, error: `Unknown dependency kind: ${edge.kind}` };
	}

	try {
		const result = await pool.query<{ edge_id: string }>(
			`INSERT INTO dependency.cross_project_dependency
			   (from_project_id, from_proposal_id, to_project_id, to_proposal_id, kind)
			 VALUES ($1, $2, $3, $4, $5)
			 RETURNING edge_id`,
			[
				edge.fromProjectId,
				edge.fromProposalId,
				edge.toProjectId,
				edge.toProposalId,
				edge.kind,
			],
		);
		return { ok: true, edgeId: BigInt(result.rows[0].edge_id) };
	} catch (err: unknown) {
		const error = err as Record<string, unknown>;
		if (error?.constraint === "cross_project_dep_unique") {
			return {
				ok: false,
				error: "Duplicate edge: this dependency already exists",
			};
		}
		if (error?.constraint === "cross_project_no_self_loop") {
			return {
				ok: false,
				error: "Self-loop: from_project_id must differ from to_project_id",
			};
		}
		throw err;
	}
}
