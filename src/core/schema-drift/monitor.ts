/**
 * P675 — monitor cycle.
 *
 * One pass: scrape journalctl, extract drift hits, dedupe, upsert into
 * roadmap.schema_drift_seen, file hotfix proposals on first occurrence,
 * escalate via notification_queue (P674) on repeat.
 *
 * AC-21: Scrape is behind an injectable interface. SCHEMA_DRIFT_LOG_INPUT env
 * overrides journalctl with synthetic logs from a file for testing.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

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

	try {
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

		// AC-11: Self-heal detection — check for resolved errors with no re-occurrence in 30 min
		try {
			await detectSelfHeals(deps, now, log);
		} catch (err) {
			const msg = (err as Error)?.message ?? String(err);
			result.errors.push(`self-heal scan failed: ${msg}`);
			warn(`[schema-drift] self-heal scan error: ${msg}`);
		}

		return result;
	} catch (err) {
		// AC-13: Unhandled exceptions write schema_drift_monitor_failed to notification_queue
		const msg = (err as Error)?.message ?? String(err);
		const stack = (err as Error)?.stack ?? "";
		try {
			await deps.pool.query(
				`INSERT INTO roadmap.notification_queue
				   (severity, kind, title, body, metadata)
				 VALUES ('CRITICAL', 'schema_drift_monitor_failed', $1, $2, $3::jsonb)`,
				[
					`Schema-drift monitor failed`,
					`${msg}\n\n${stack}`,
					JSON.stringify({
						error_message: msg,
						error_type: (err as Error)?.name ?? "unknown",
					}),
				],
			);
		} catch (notifyErr) {
			warn(`[schema-drift] failed to notify of monitor crash: ${notifyErr}`);
		}
		result.errors.push(`monitor cycle crashed: ${msg}`);
		warn(`[schema-drift] CRASH: ${msg}`);
		return result;
	}
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

		// AC-14: Idempotent insert via ON CONFLICT DO UPDATE
		await deps.pool.query(
			`INSERT INTO roadmap.schema_drift_seen
			   (fingerprint, error_code, missing_name, query_excerpt,
			    hotfix_proposal_id, origin_proposal_id, origin_commit_sha)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)
			 ON CONFLICT (fingerprint) DO UPDATE SET
			   occurrence_count = occurrence_count + 1,
			   last_seen = now()`,
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

	// AC-15: Retry hotfix creation if hotfix_proposal_id is NULL (previous cycle failed).
	if (row.hotfix_proposal_id === null) {
		const origin = traceOrigin(hit.missingName, {
			repoRoot: deps.repoRoot,
			exec: deps.exec,
		});

		const proposal = await deps.createHotfixProposal({
			missingName: hit.missingName,
			errorCode: hit.errorCode,
			queryExcerpt: hit.queryExcerpt,
			rawLine: hit.rawLine,
			originDisplayId: origin.proposalDisplayId,
			originCommitSha: origin.commitSha,
			fingerprint,
		});

		if (proposal) {
			await deps.pool.query(
				`UPDATE roadmap.schema_drift_seen
				    SET hotfix_proposal_id = $1
				  WHERE fingerprint = $2`,
				[proposal.id, fingerprint],
			);
			result.newHotfixes++;
			log(`[schema-drift] filed hotfix on retry ${proposal.displayId} (parent=${origin.proposalDisplayId ?? "none"})`);
		} else {
			log(`[schema-drift] hotfix retry failed for ${fingerprint}`);
		}
	}

	// AC-12: Regression detection — if error re-appears after resolved_at was set,
	// clear resolved_at and escalate immediately.
	let isRegression = false;
	if (row.resolved_at !== null) {
		isRegression = true;
		log(`[schema-drift] REGRESSION: ${hit.missingName} re-appeared after resolution`);
		await deps.pool.query(
			`UPDATE roadmap.schema_drift_seen
			    SET resolved_at = NULL
			  WHERE fingerprint = $1`,
			[fingerprint],
		);
	}

	await deps.pool.query(
		`UPDATE roadmap.schema_drift_seen
		    SET occurrence_count = occurrence_count + 1,
		        last_seen = now()
		  WHERE fingerprint = $1`,
		[fingerprint],
	);

	const newCount = row.occurrence_count + 1;
	const ageHours = (now().getTime() - row.first_seen.getTime()) / (1000 * 60 * 60);
	const stillUnresolved = row.resolved_at === null || isRegression; // Regression makes it unresolved again
	const cooldownExpired =
		row.last_escalated_at === null ||
		(now().getTime() - row.last_escalated_at.getTime()) / (1000 * 60 * 60) >=
			ESCALATION_COOLDOWN_HOURS;

	// AC-12: Regressions escalate immediately (bypass cooldown).
	// AC-10: Normal repeat escalation after count >= 4 or age >= 2h with cooldown.
	const shouldEscalate =
		(isRegression || (stillUnresolved && cooldownExpired)) &&
		(isRegression || newCount >= ESCALATE_AFTER_OCCURRENCES || ageHours >= ESCALATE_AFTER_HOURS_UNRESOLVED);

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

async function detectSelfHeals(
	deps: MonitorDeps,
	now: () => Date,
	log: (m: string) => void,
): Promise<void> {
	// AC-11: Find resolved errors that haven't re-occurred in 30 minutes.
	// These are confirmed self-heals (hotfix proposal landed and fixed the problem).
	const thirtyMinutesAgo = new Date(now().getTime() - 30 * 60 * 1000);

	const result = await deps.pool.query<{
		fingerprint: string;
		missing_name: string;
		hotfix_proposal_id: string | null;
	}>(
		`SELECT fingerprint, missing_name, hotfix_proposal_id
		   FROM roadmap.schema_drift_seen
		  WHERE resolved_at IS NOT NULL
		    AND last_seen < $1`,
		[thirtyMinutesAgo],
	);

	for (const row of result.rows) {
		log(
			`[schema-drift] self-heal confirmed: ${row.missing_name} (30+ min quiet, hotfix=${row.hotfix_proposal_id ?? "none"})`,
		);
		// Optional: could insert a success record or notification; for now just log.
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

	const metadata = {
		fingerprint,
		missing_name: hit.missingName,
		error_code: hit.errorCode,
		occurrences,
		age_hours: Number(ageHours.toFixed(2)),
		hotfix_proposal_id: hotfixProposalId,
	};

	// AC-16: P674 notification routing — escalate via kind='schema_drift_repeated'
	// This routes to discord_webhook transport per migration 062 (P674 seed routes).
	// The P674 router handles the actual dispatch and retries.
	await deps.pool.query(
		`INSERT INTO roadmap.notification_queue
		   (proposal_id, severity, kind, title, body, metadata)
		 VALUES ($1, 'CRITICAL', 'schema_drift_repeated', $2, $3, $4::jsonb)`,
		[hotfixProposalId, title, body, JSON.stringify(metadata)],
	);
}

function defaultScrape(windowMinutes: number): string {
	// AC-21: Allow injection of synthetic logs via SCHEMA_DRIFT_LOG_INPUT env for testing.
	const logInputPath = process.env.SCHEMA_DRIFT_LOG_INPUT;
	if (logInputPath) {
		return readFileSync(logInputPath, "utf8");
	}

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
