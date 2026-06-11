/**
 * P188: Directive conflict detection.
 * Scans active proposals for semantic overlap with a newly filed directive
 * using keyword-based cosine similarity. Conflicts with similarity > 0.6
 * are flagged for skeptic D2 review.
 */

import { query } from "../../postgres/pool.ts";
import { RfcStates } from "../workflow/state-names.ts";

const STOP_WORDS = new Set([
	"the", "and", "for", "with", "this", "that", "from", "into", "have",
	"been", "will", "would", "should", "could", "also", "some", "more",
	"when", "then", "than", "they", "their", "there", "where", "here",
	"what", "which", "each", "both", "such", "like", "about", "over",
	"after", "before", "under", "between", "during", "through",
]);

export interface ConflictEntry {
	proposal_id: string;
	display_id: string | null;
	title: string;
	similarity_score: number;
	requires_review: boolean;
}

export interface ConflictReport {
	directive_id: string;
	conflicts: ConflictEntry[];
	timestamp: string;
	keyword_count: number;
}

function extractKeywords(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 3 && !STOP_WORDS.has(w));
}

function computeCosineSimilarity(a: string[], b: string[]): number {
	if (a.length === 0 || b.length === 0) return 0;
	const setA = new Set(a);
	const setB = new Set(b);
	let intersection = 0;
	for (const w of setA) {
		if (setB.has(w)) intersection++;
	}
	return intersection / Math.sqrt(setA.size * setB.size);
}

const CONFLICT_THRESHOLD = 0.6;

/**
 * Detect semantically similar proposals that may conflict with a directive.
 * Only considers active (non-terminal) proposals.
 */
export async function detectConflicts(
	directiveId: string,
	directiveTitle: string,
	directiveSummary: string | null,
	queryFn: typeof query = query,
): Promise<ConflictReport> {
	const inputText = `${directiveTitle} ${directiveSummary ?? ""}`;
	const inputKeywords = extractKeywords(inputText);

	// Terminal/closed states come from the canonical state-names registry
	// (P306 uppercased all stored statuses, so the comparison is exact).
	const inactiveStates = [RfcStates.COMPLETE, RfcStates.REJECTED, RfcStates.DISCARDED];
	const { rows } = await queryFn<{
		id: string;
		display_id: string | null;
		title: string;
		summary: string | null;
	}>(
		`SELECT id::text, display_id, title, summary
		   FROM roadmap_proposal.proposal
		  WHERE type != 'directive'
		    AND id::text != $1
		    AND upper(status) <> ALL($2::text[])`,
		[directiveId, inactiveStates],
	);

	const conflicts: ConflictEntry[] = [];
	for (const row of rows) {
		const candidateText = `${row.title} ${row.summary ?? ""}`;
		const candidateKeywords = extractKeywords(candidateText);
		const score = computeCosineSimilarity(inputKeywords, candidateKeywords);
		if (score > CONFLICT_THRESHOLD) {
			conflicts.push({
				proposal_id: row.id,
				display_id: row.display_id,
				title: row.title,
				similarity_score: Math.round(score * 1000) / 1000,
				requires_review: true,
			});
		}
	}

	// Sort by similarity descending for readability
	conflicts.sort((a, b) => b.similarity_score - a.similarity_score);

	return {
		directive_id: directiveId,
		conflicts,
		timestamp: new Date().toISOString(),
		keyword_count: inputKeywords.length,
	};
}
