/**
 * P599 — Tool catalog grant resolution and op-matching.
 *
 * opsMatch():            checks a requested op against granted ops (single-level wildcards).
 * resolveToolEnvelope(): queries roadmap.tool_grant for a (project, agency) pair,
 *                        respects principal_identity revocation, and returns a JSON
 *                        envelope suitable for serialization to AGENT_TOOL_ENVELOPE.
 *
 * Wildcard grammar (single-level only):
 *   namespace:verb   — exact match
 *   namespace:*      — any verb within the namespace
 *   *:anything       — INVALID (rejected by chk_agency_principal_prefix in DB)
 *   namespace:*:*    — INVALID (too many levels)
 */

import { query } from "../postgres/pool.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Map of tool_name → permitted_ops[], returned by resolveToolEnvelope(). */
export type ToolEnvelope = Record<string, string[]>;

/** Thrown by resolveToolEnvelope() when the DB is unreachable or times out. */
export class ToolGrantResolutionError extends Error {
	constructor(
		readonly projectId: number | null,
		readonly agencyPrincipalId: string | null,
		cause: unknown,
	) {
		super(
			`[P599] Tool grant resolution failed for project=${projectId} agency=${agencyPrincipalId}: ${String(cause)}`,
		);
		this.name = "ToolGrantResolutionError";
		if (cause instanceof Error) this.cause = cause;
	}
}

// ── opsMatch ──────────────────────────────────────────────────────────────────

/**
 * Returns true if `requested` is covered by any string in `granted`.
 *
 * Exact match:   granted includes "proposal:read"  and requested = "proposal:read" → true
 * Wildcard:      granted includes "proposal:*"     and requested = "proposal:read" → true
 * Cross-ns fail: granted includes "proposal:*"     and requested = "agent:read"    → false
 * No wildcards in the requested op are honoured — only in granted.
 */
export function opsMatch(granted: string[], requested: string): boolean {
	for (const g of granted) {
		if (g === requested) return true;
		// namespace:* matches any namespace:verb where namespace is the same prefix
		if (g.endsWith(":*") && requested.startsWith(g.slice(0, -1))) return true;
	}
	return false;
}

// ── resolveToolEnvelope ───────────────────────────────────────────────────────

/** Injectable query function type — matches the signature of the pool's `query`. */
export type QueryFn = (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;

/**
 * Fetch the effective tool grant envelope for a (project, agency) pair.
 *
 * Resolution rules (mirrors §C SQL):
 *   - Rows with project_id IS NULL match any project.
 *   - Rows with agency_principal_id IS NULL match any agency.
 *   - A revoked agency principal (principal_identity.revoked_at IS NOT NULL)
 *     receives an empty envelope — no manual tool_grant cleanup required.
 *   - Expired grants (expires_at < now()) are excluded.
 *   - Permissions from multiple matching rows are unioned per tool.
 *
 * Throws ToolGrantResolutionError (never returns a partial result) so the
 * spawner can abort the spawn without ever falling back to full-grant.
 *
 * The optional `queryFn` parameter is injected in tests to avoid real DB access.
 * Production callers omit it (defaults to the pool's `query`).
 */
export async function resolveToolEnvelope(
	projectId: number | null,
	agencyPrincipalId: string | null,
	queryFn: QueryFn = query as unknown as QueryFn,
): Promise<ToolEnvelope> {
	type Row = { tool_name: string; permitted_ops: string[] };

	let rows: Row[];
	try {
		const result = await queryFn(
			`SELECT t.tool_name,
			        array_agg(DISTINCT op ORDER BY op) AS permitted_ops
			 FROM   roadmap.tool_grant tg
			 JOIN   roadmap.tool t ON t.tool_id = tg.tool_id,
			        LATERAL unnest(tg.permitted_ops) AS op
			 WHERE  t.is_enabled
			   AND  (tg.project_id IS NULL OR tg.project_id = $1)
			   AND  (tg.agency_principal_id IS NULL OR tg.agency_principal_id = $2)
			   AND  (tg.expires_at IS NULL OR tg.expires_at > now())
			   AND  (tg.agency_principal_id IS NULL
			         OR NOT EXISTS (
			           SELECT 1
			           FROM   roadmap.principal_identity pi
			           WHERE  pi.principal_id = tg.agency_principal_id
			             AND  pi.revoked_at IS NOT NULL
			         ))
			 GROUP  BY t.tool_name`,
			[projectId, agencyPrincipalId],
		);
		rows = result.rows as Row[];
	} catch (err) {
		throw new ToolGrantResolutionError(projectId, agencyPrincipalId, err);
	}

	const envelope: ToolEnvelope = {};
	for (const row of rows) {
		envelope[row.tool_name] = row.permitted_ops;
	}
	return envelope;
}

// ── Envelope serialization helpers ────────────────────────────────────────────

/** Serialize a ToolEnvelope to the string stored in AGENT_TOOL_ENVELOPE. */
export function serializeEnvelope(envelope: ToolEnvelope): string {
	return JSON.stringify(envelope);
}

/**
 * Parse AGENT_TOOL_ENVELOPE from the process environment.
 * Returns null if the env var is absent or empty (= unrestricted, shared-server path).
 */
export function parseEnvelopeFromEnv(): ToolEnvelope | null {
	const raw = process.env.AGENT_TOOL_ENVELOPE;
	if (!raw) return null;
	try {
		return JSON.parse(raw) as ToolEnvelope;
	} catch {
		return null;
	}
}
