/**
 * P188: Directive conflict detection
 * Scans open directive proposals for semantic keyword overlap with a new directive's title/summary.
 */

import { query as defaultQuery } from "../../../../postgres/pool.ts";

export interface ConflictResult {
	proposalId: string;
	displayId: string;
	title: string;
	reason: string;
}

type QueryFn = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, string>[] }>;

/**
 * Detect semantic conflicts against existing open directives.
 *
 * Strategy: tokenise title + summary into significant words (≥4 chars, alpha-only),
 * then find directives whose title contains at least one shared token.
 * Excludes terminal states (Complete, Deployed, Recycled).
 *
 * @param queryFn  Optional injectable query function (used in tests to avoid live DB).
 */
export async function detectConflicts(
	title: string,
	summary: string | null,
	queryFn: QueryFn = defaultQuery as unknown as QueryFn,
): Promise<ConflictResult[]> {
	const text = `${title} ${summary ?? ""}`;
	const tokens = text
		.toLowerCase()
		.split(/\W+/)
		.filter((t) => t.length >= 4 && /^[a-z]+$/.test(t));

	if (tokens.length === 0) return [];

	const uniqueTokens = [...new Set(tokens)];

	const likeClauses = uniqueTokens.map((_, i) => `LOWER(p.title) LIKE $${i + 1}`).join(" OR ");
	const params: string[] = uniqueTokens.map((t) => `%${t}%`);

	const sql = `
		SELECT p.id::text AS proposal_id,
		       COALESCE(p.display_id, p.id::text) AS display_id,
		       p.title
		FROM roadmap_proposal.proposal p
		WHERE p.type = 'directive'
		  AND p.status NOT IN ('Complete', 'Deployed', 'Recycled')
		  AND (${likeClauses})
		ORDER BY p.created_at DESC
		LIMIT 20
	`;

	const { rows } = await queryFn(sql, params);

	return rows.map((r) => ({
		proposalId: r.proposal_id,
		displayId: r.display_id,
		title: r.title,
		reason: `Keyword overlap detected between new directive "${title}" and existing directive "${r.title}"`,
	}));
}
