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
	toProjectId: bigint;
	kindId: bigint;
	referenceId: string;
	referenceType: string;
	notes?: string;
};

export type AddEdgeResult =
	| { ok: true; edgeId: bigint }
	| { ok: false; error: string };

/**
 * Inserts a cross-project dependency edge.
 *
 * Validates kindId against dependency_kind_catalog.id before insert.
 * Returns a typed error (not a throw) for constraint violations.
 */
export async function addCrossProjectDependency(
	pool: Pool,
	edge: EdgeInput,
): Promise<AddEdgeResult> {
	const kindCheck = await pool.query<{ id: string }>(
		"SELECT id FROM dependency.dependency_kind_catalog WHERE id = $1 AND lifecycle_status = 'active'",
		[edge.kindId],
	);
	if ((kindCheck.rowCount ?? 0) === 0) {
		return {
			ok: false,
			error: `Unknown or inactive dependency kind: ${edge.kindId}`,
		};
	}

	try {
		const result = await pool.query<{ id: string }>(
			`INSERT INTO dependency.cross_project_dependency
			   (from_project_id, to_project_id, kind_id, reference_id, reference_type, notes)
			 VALUES ($1, $2, $3, $4, $5, $6)
			 RETURNING id`,
			[
				edge.fromProjectId,
				edge.toProjectId,
				edge.kindId,
				edge.referenceId,
				edge.referenceType,
				edge.notes ?? null,
			],
		);
		return { ok: true, edgeId: BigInt(result.rows[0].id) };
	} catch (err: unknown) {
		const error = err as Record<string, unknown>;
		if (error?.constraint === "cross_project_dependency_unique") {
			return {
				ok: false,
				error: "Duplicate edge: this dependency already exists",
			};
		}
		throw err;
	}
}
