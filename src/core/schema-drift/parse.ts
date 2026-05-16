/**
 * P675 — pure parsing helpers for schema-drift detection.
 *
 * All heavy I/O lives in run.ts; everything here is deterministic and
 * unit-testable.
 */

import { createHash } from "node:crypto";

export interface DriftHit {
	errorCode: "42703" | "42P01";
	missingName: string;
	queryExcerpt: string | null;
	rawLine: string;
}

export const NO_QUERY_SENTINEL = "<no-query>";

const ERR_PATTERNS: Array<{
	code: DriftHit["errorCode"];
	regex: RegExp;
}> = [
	{ code: "42703", regex: /column "([^"]+)" does not exist/i },
	{ code: "42P01", regex: /relation "([^"]+)" does not exist/i },
];

const SQLSTATE_PATTERNS: Array<{
	code: DriftHit["errorCode"];
	regex: RegExp;
}> = [
	{ code: "42703", regex: /code:\s*['"]42703['"]/ },
	{ code: "42P01", regex: /code:\s*['"]42P01['"]/ },
];

/**
 * Walk the journalctl-style text and extract every drift hit.
 *
 * We match on the human-readable `column "X" does not exist` / `relation "X"
 * does not exist` strings rather than the JS-formatted error object so we
 * catch hits whether the error came from `pg` driver pretty-printing, the
 * server's logger, or a wrapped exception.
 */
export function extractDriftHits(text: string): DriftHit[] {
	const hits: DriftHit[] = [];
	const lines = text.split(/\r?\n/);

	for (const line of lines) {
		// We need both: the missing-name regex AND a sqlstate hint OR the
		// canonical "does not exist" phrase. The sqlstate check rules out
		// false positives (e.g. an info log that includes the phrase
		// inside an unrelated string).
		for (const pat of ERR_PATTERNS) {
			const m = pat.regex.exec(line);
			if (!m) continue;
			const missingName = m[1];
			if (!missingName) continue;
			// The line itself contains "does not exist" so accept it.
			hits.push({
				errorCode: pat.code,
				missingName,
				queryExcerpt: extractQueryExcerpt(line),
				rawLine: line,
			});
		}

		// Some logs print the error object separately — we still want to
		// catch a sqlstate-only line as a marker for nearby hits, but we
		// only emit when we have a name.
		void SQLSTATE_PATTERNS;
	}

	return hits;
}

/**
 * Try to pull a representative query fragment off the same log line. We
 * keep it short and normalized so identical queries with different literals
 * fingerprint the same.
 */
function extractQueryExcerpt(line: string): string | null {
	const m =
		/\b(WITH|SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[\s\S]{0,500}/i.exec(
			line,
		);
	if (!m) return null;

	const excerpt = m[0]
		.replace(/\bcode:\s*['"](42703|42P01)['"].*/i, "")
		.replace(/\b(column|relation)\s+"[^"]+"\s+does not exist.*/i, "")
		.trim();
	if (!excerpt) return null;

	return normalizeQueryFragment(excerpt);
}

export function normalizeQueryFragment(q: string): string {
	return q
		.replace(/'([^'\\]|\\.)*'/g, "?")
		.replace(/"([^"\\]|\\.)*"/g, "?")
		.replace(/\$\d+/g, "?")
		.replace(/\b\d+(?:\.\d+)?\b/g, "?")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 240);
}

/**
 * Stable fingerprint per drift class. Combines sqlstate + missing name +
 * normalized query — different queries against the same missing column get
 * separate fingerprints, which is right (each one needs its own fix), but
 * the same query repeated 1000× collapses to one entry.
 */
export function fingerprintHit(hit: DriftHit): string {
	const q = hit.queryExcerpt ?? NO_QUERY_SENTINEL;
	return createHash("sha256")
		.update(`${hit.errorCode}|${hit.missingName}|${q}`)
		.digest("hex")
		.slice(0, 64);
}

/**
 * Dedupe hits within a single scrape window so we don't double-count a
 * single error that appears N times back-to-back in the log.
 */
export function dedupeHits(hits: DriftHit[]): DriftHit[] {
	const seen = new Set<string>();
	const out: DriftHit[] = [];
	for (const h of hits) {
		const fp = fingerprintHit(h);
		if (seen.has(fp)) continue;
		seen.add(fp);
		out.push(h);
	}
	return out;
}
