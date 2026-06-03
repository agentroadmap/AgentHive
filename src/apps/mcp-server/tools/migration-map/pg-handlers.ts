/**
 * P997: MCP handlers for proposal_migration_map
 *
 * Provides map_upsert / map_get / map_query / map_summary over
 * roadmap_proposal.proposal_migration_map.
 */

import { query } from "../../../../postgres/pool.ts";
import type { CallToolResult } from "../../types.ts";

function textResult(text: string): CallToolResult {
	return { content: [{ type: "text", text }] };
}

function errorResult(label: string, err: unknown): CallToolResult {
	return textResult(`⚠️ ${label}: ${err instanceof Error ? err.message : String(err)}`);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MigrationMapRow {
	id: number;
	legacy_proposal_id: string;
	legacy_proposal_row_id: number | null;
	canonical_proposal_id: string | null;
	canonical_proposal_row_id: number | null;
	classification: string;
	rationale: string;
	evidence_refs: unknown[];
	superseded_by_proposal_id: string | null;
	superseded_by_row_id: number | null;
	reviewed_by: string | null;
	reviewed_at: string | null;
	created_by: string;
	notes: string | null;
	created_at: string;
	updated_at: string;
}

export interface MapUpsertArgs {
	legacy_proposal_id: string;
	classification: string;
	rationale: string;
	evidence_refs?: unknown[];
	canonical_proposal_id?: string;
	superseded_by_proposal_id?: string;
	reviewed_by?: string;
	reviewed_at?: string;
	created_by?: string;
	notes?: string;
}

export interface MapGetArgs {
	legacy_proposal_id: string;
}

export interface MapQueryArgs {
	classification?: string;
	reviewed?: boolean;
	needs_review?: boolean;
	limit?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveProposalRowId(proposalId: string): Promise<number | null> {
	if (!proposalId) return null;
	const num = parseInt(proposalId, 10);
	if (Number.isNaN(num)) return null;
	const { rows } = await query<{ id: number }>(
		`SELECT id FROM roadmap_proposal.proposal WHERE id = $1 LIMIT 1`,
		[num],
	);
	return rows.length > 0 ? rows[0].id : null;
}

// ---------------------------------------------------------------------------
// map_upsert
// ---------------------------------------------------------------------------

export async function mapUpsert(args: MapUpsertArgs): Promise<CallToolResult> {
	try {
		const legacyId = String(args.legacy_proposal_id ?? "");
		if (!legacyId) return textResult("⚠️ map_upsert: legacy_proposal_id is required");

		const classification = args.classification;
		const rationale = args.rationale;
		const evidenceRefs = JSON.stringify(args.evidence_refs ?? []);
		const canonicalId = args.canonical_proposal_id ?? null;
		const supersededById = args.superseded_by_proposal_id ?? null;
		const reviewedBy = args.reviewed_by ?? null;
		const reviewedAt = args.reviewed_at ?? (reviewedBy ? new Date().toISOString() : null);
		const createdBy = args.created_by ?? "agent";
		const notes = args.notes ?? null;

		// Resolve FK row IDs where possible
		const [legacyRowId, canonicalRowId, supersededByRowId] = await Promise.all([
			resolveProposalRowId(legacyId),
			canonicalId ? resolveProposalRowId(canonicalId) : Promise.resolve(null),
			supersededById ? resolveProposalRowId(supersededById) : Promise.resolve(null),
		]);

		const { rows } = await query<MigrationMapRow>(
			`INSERT INTO roadmap_proposal.proposal_migration_map
				(legacy_proposal_id, legacy_proposal_row_id,
				 canonical_proposal_id, canonical_proposal_row_id,
				 classification, rationale, evidence_refs,
				 superseded_by_proposal_id, superseded_by_row_id,
				 reviewed_by, reviewed_at, created_by, notes)
			 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13)
			 ON CONFLICT (legacy_proposal_id) DO UPDATE SET
				legacy_proposal_row_id    = EXCLUDED.legacy_proposal_row_id,
				canonical_proposal_id     = EXCLUDED.canonical_proposal_id,
				canonical_proposal_row_id = EXCLUDED.canonical_proposal_row_id,
				classification            = EXCLUDED.classification,
				rationale                 = EXCLUDED.rationale,
				evidence_refs             = EXCLUDED.evidence_refs,
				superseded_by_proposal_id = EXCLUDED.superseded_by_proposal_id,
				superseded_by_row_id      = EXCLUDED.superseded_by_row_id,
				reviewed_by               = EXCLUDED.reviewed_by,
				reviewed_at               = EXCLUDED.reviewed_at,
				notes                     = EXCLUDED.notes,
				updated_at                = now()
			 RETURNING *`,
			[
				legacyId, legacyRowId,
				canonicalId, canonicalRowId,
				classification, rationale, evidenceRefs,
				supersededById, supersededByRowId,
				reviewedBy, reviewedAt, createdBy, notes,
			],
		);

		const row = rows[0];
		return textResult(
			`✅ map_upsert: ${row.id === undefined ? "upserted" : `row id=${row.id}`}\n` +
			`legacy_proposal_id=${row.legacy_proposal_id} classification=${row.classification}\n` +
			`canonical_proposal_id=${row.canonical_proposal_id ?? "(none)"} reviewed_by=${row.reviewed_by ?? "(none)"}`,
		);
	} catch (err) {
		return errorResult("map_upsert", err);
	}
}

// ---------------------------------------------------------------------------
// map_get
// ---------------------------------------------------------------------------

export async function mapGet(args: MapGetArgs): Promise<CallToolResult> {
	try {
		const legacyId = String(args.legacy_proposal_id ?? "");
		if (!legacyId) return textResult("⚠️ map_get: legacy_proposal_id is required");

		const { rows } = await query<MigrationMapRow>(
			`SELECT * FROM roadmap_proposal.proposal_migration_map
			 WHERE legacy_proposal_id = $1`,
			[legacyId],
		);

		if (rows.length === 0) {
			return textResult(`map_get: no mapping found for legacy_proposal_id=${legacyId}`);
		}

		return textResult(JSON.stringify(rows[0], null, 2));
	} catch (err) {
		return errorResult("map_get", err);
	}
}

// ---------------------------------------------------------------------------
// map_query
// ---------------------------------------------------------------------------

export async function mapQuery(args: MapQueryArgs): Promise<CallToolResult> {
	try {
		const filters: string[] = [];
		const params: unknown[] = [];
		let n = 1;

		if (args.classification) {
			filters.push(`classification = $${n++}`);
			params.push(args.classification);
		}

		if (args.reviewed === true) {
			filters.push(`reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL`);
		} else if (args.reviewed === false) {
			filters.push(`(reviewed_by IS NULL OR reviewed_at IS NULL)`);
		}

		if (args.needs_review === true) {
			filters.push(
				`(reviewed_by IS NULL OR reviewed_at IS NULL
				  OR (classification NOT IN ('obsolete') AND canonical_proposal_id IS NULL)
				  OR (classification IN ('duplicate','superseded') AND superseded_by_proposal_id IS NULL))`,
			);
		}

		const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
		const limitVal = Math.min(args.limit ?? 100, 500);
		params.push(limitVal);

		const { rows } = await query<MigrationMapRow>(
			`SELECT * FROM roadmap_proposal.proposal_migration_map
			 ${where}
			 ORDER BY legacy_proposal_id
			 LIMIT $${n}`,
			params,
		);

		return textResult(JSON.stringify({ count: rows.length, rows }, null, 2));
	} catch (err) {
		return errorResult("map_query", err);
	}
}

// ---------------------------------------------------------------------------
// map_summary
// ---------------------------------------------------------------------------

interface SummaryRow {
	classification: string;
	total: number;
	reviewed: number;
	unreviewed: number;
	with_evidence: number;
	without_evidence: number;
}

export async function mapSummary(): Promise<CallToolResult> {
	try {
		const { rows } = await query<SummaryRow>(
			`SELECT * FROM roadmap_proposal.v_migration_classification_summary`,
		);

		const totalAll = rows.reduce((s, r) => s + Number(r.total), 0);
		const reviewedAll = rows.reduce((s, r) => s + Number(r.reviewed), 0);

		return textResult(
			JSON.stringify(
				{
					total: totalAll,
					reviewed: reviewedAll,
					unreviewed: totalAll - reviewedAll,
					by_classification: rows,
				},
				null,
				2,
			),
		);
	} catch (err) {
		return errorResult("map_summary", err);
	}
}
