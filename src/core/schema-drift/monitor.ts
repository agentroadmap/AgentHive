/**
 * P675 — monitor cycle.
 *
 * One pass: scrape journalctl, extract drift hits, dedupe, upsert into
 * roadmap.schema_drift_seen, file hotfix proposals on first occurrence,
 * escalate via notification_queue (P674) on repeat.
 */

import { execFileSync } from "node:child_process";

import {
	dedupeHits,
	extractDriftHits,
	fingerprintHit,
	type DriftHit,
} from "./parse.ts";
import { traceOrigin } from "./origin.ts";
import type { Pool } from "pg";

const ESCALATE_AFTER_OCCURRENCES = 4;
const ESCALATE_AFTER_HOURS_UNRESOLVED = 2;
const ESCALATION_COOLDOWN_HOURS = 1;

export interface MonitorDeps {
	pool: Pool;
	repoRoot: string;
	scrapeWindowMinutes?: number;
	createHotfixProposal: (args: HotfixProposalArgs) => Promise<{ id: number; displayId: string } | null>;
	now?: () => Date;
	scrape?: (windowMinutes: number) => string;
	exec?: (cmd: string, args: string[], cwd: string) => string;
	log?: (m: string) => void;
	warn?: (m: string) => void;
}

export interface HotfixProposalArgs {
	missingName: string;
	errorCode: string;
	queryExcerpt: string | null;
	rawLine: string;
	originDisplayId: string | null;
	originCommitSha: string | null;
	fingerprint: string;
}

export interface MonitorResult {
	scanned: number;
	uniqueFingerprints: number;
	newHotfixes: number;
	repeats: number;
	escalations: number;
	errors: string[];
}

export async function runMonitorCycle(deps: MonitorDeps): Promise<MonitorResult> {
	const log = deps.log ?? ((m) => console.log(m));
	const warn = deps.warn ?? ((m) => console.warn(m));
	const now = deps.now ?? (() => new Date());
	const window = deps.scrapeWindowMinutes ?? 16;

	const result: MonitorResult = {
		scanned: 0,
		uniqueFingerprints: 0,
		newHotfixes: 0,
		repeats: 0,
		escalations: 0,
		errors: [],
	};

	let raw: string;
	try {
		raw = (deps.scrape ?? defaultScrape)(window);
	} catch (err) {
		const msg = (err as Error)?.message ?? String(err);
		result.errors.push(`scrape failed: ${msg}`);
		warn(`[schema-drift] scrape failed: ${msg}`);
		return result;
	}

	const allHits = extractDriftHits(raw);
	result.scanned = allHits.length;
	const hits = dedupeHits(allHits);
	result.uniqueFingerprints = hits.length;

	if (hits.length === 0) return result;

	for (const hit of hits) {
		try {
			await handleHit(hit, deps, result, now, log);
		} catch (err) {
			const msg = (err as Error)?.message ?? String(err);
			result.errors.push(`hit ${fingerprintHit(hit)}: ${msg}`);
			warn(`[schema-drift] handler error for ${hit.missingName}: ${msg}`);
		}
	}

	return result;
}

async function handleHit(
	hit: DriftHit,
	deps: MonitorDeps,
	result: MonitorResult,
	now: () => Date,
	log: (m: string) => void,
): Promise<void> {
	const fingerprint = fingerprintHit(hit);

	const existing = await deps.pool.query<{
		fingerprint: string;
		occurrence_count: number;
		first_seen: Date;
		hotfix_proposal_id: string | null;
		resolved_at: Date | null;
		last_escalated_at: Date | null;
	}>(
		`SELECT fingerprint, occurrence_count, first_seen, hotfix_proposal_id, resolved_at, last_escalated_at
		   FROM roadmap.schema_drift_seen
		  WHERE fingerprint = $1`,
		[fingerprint],
	);

	if (existing.rows.length === 0) {
		// First occurrence — trace origin, file hotfix, insert seen-row.
		const origin = traceOrigin(hit.missingName, {
			repoRoot: deps.repoRoot,
			exec: deps.exec,
		});

		log(
			`[schema-drift] new fingerprint ${fingerprint}; origin=${origin.proposalDisplayId ?? "(unknown)"} (${origin.source})`,
		);

		const proposal = await deps.createHotfixProposal({
			missingName: hit.missingName,
			errorCode: hit.errorCode,
			queryExcerpt: hit.queryExcerpt,
			rawLine: hit.rawLine,
			originDisplayId: origin.proposalDisplayId,
			originCommitSha: origin.commitSha,
			fingerprint,
		});

		await deps.pool.query(
			`INSERT INTO roadmap.schema_drift_seen
			   (fingerprint, error_code, missing_name, query_excerpt,
			    hotfix_proposal_id, origin_proposal_id, origin_commit_sha)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			[
				fingerprint,
				hit.errorCode,
				hit.missingName,
				hit.queryExcerpt,
				proposal?.id ?? null,
				origin.proposalNumericId ?? null,
				origin.commitSha,
			],
		);

		if (proposal) {
			result.newHotfixes++;
			log(`[schema-drift] filed hotfix ${proposal.displayId} (parent=${origin.proposalDisplayId ?? "none"})`);
		} else {
			result.errors.push(`failed to create hotfix proposal for ${fingerprint}`);
		}
		return;
	}

	// Repeat occurrence — bump counters, decide on escalation.
	const row = existing.rows[0];
	result.repeats++;

	await deps.pool.query(
		`UPDATE roadmap.schema_drift_seen
		    SET occurrence_count = occurrence_count + 1,
		        last_seen = now()
		  WHERE fingerprint = $1`,
		[fingerprint],
	);

	const newCount = row.occurrence_count + 1;
	const ageHours = (now().getTime() - row.first_seen.getTime()) / (1000 * 60 * 60);
	const stillUnresolved = row.resolved_at === null;
	const cooldownExpired =
		row.last_escalated_at === null ||
		(now().getTime() - row.last_escalated_at.getTime()) / (1000 * 60 * 60) >=
			ESCALATION_COOLDOWN_HOURS;

	const shouldEscalate =
		stillUnresolved &&
		cooldownExpired &&
		(newCount >= ESCALATE_AFTER_OCCURRENCES ||
			ageHours >= ESCALATE_AFTER_HOURS_UNRESOLVED);

	if (shouldEscalate) {
		await escalate(deps, hit, fingerprint, row.hotfix_proposal_id, newCount, ageHours);
		await deps.pool.query(
			`UPDATE roadmap.schema_drift_seen
			    SET last_escalated_at = now()
			  WHERE fingerprint = $1`,
			[fingerprint],
		);
		result.escalations++;
	}
}

async function escalate(
	deps: MonitorDeps,
	hit: DriftHit,
	fingerprint: string,
	hotfixProposalId: string | null,
	occurrences: number,
	ageHours: number,
): Promise<void> {
	const title = `Schema drift unresolved: ${hit.missingName} (${occurrences}× over ${ageHours.toFixed(1)}h)`;
	const body = [
		`Fingerprint: ${fingerprint}`,
		`Missing: ${hit.missingName} (sqlstate ${hit.errorCode})`,
		hit.queryExcerpt ? `Query: ${hit.queryExcerpt}` : null,
		hotfixProposalId
			? `Hotfix proposal id: ${hotfixProposalId} (still open)`
			: "No hotfix proposal yet (origin tracing failed?)",
		"",
		"Repeat-detection: hotfix is not landing fast enough; needs operator attention.",
	]
		.filter(Boolean)
		.join("\n");

	await deps.pool.query(
		`INSERT INTO roadmap.notification_queue
		   (proposal_id, severity, kind, title, body, metadata)
		 VALUES ($1, 'CRITICAL', 'schema_drift_repeated', $2, $3, $4::jsonb)`,
		[
			hotfixProposalId,
			title,
			body,
			JSON.stringify({
				fingerprint,
				missing_name: hit.missingName,
				error_code: hit.errorCode,
				occurrences,
				age_hours: Number(ageHours.toFixed(2)),
				hotfix_proposal_id: hotfixProposalId,
			}),
		],
	);
}

function defaultScrape(windowMinutes: number): string {
	return execFileSync(
		"journalctl",
		[
			"-u",
			"agenthive-*",
			"--since",
			`${windowMinutes} minutes ago`,
			"--output",
			"cat",
			"--no-pager",
		],
		{
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
}
