/**
 * P675 — schema-drift monitor entrypoint.
 *
 * Invoked by `agenthive-schema-drift-monitor.timer` every 15 minutes.
 * Single-shot: scrape, dedupe, file/escalate, exit. Idempotent — safe to
 * re-run on overlapping windows because schema_drift_seen.fingerprint is
 * the dedupe boundary.
 */

import { createProposal } from "../src/infra/postgres/proposal-storage-v2.ts";
import { closePool, getPool } from "../src/infra/postgres/pool.ts";
import { runMonitorCycle } from "../src/core/schema-drift/monitor.ts";

const REPO_ROOT = process.env.PROJECT_ROOT ?? "/data/code/AgentHive";

async function main(): Promise<void> {
	const pool = getPool();
	await pool.query("SELECT 1");
	console.log("[schema-drift] db ok");

	const result = await runMonitorCycle({
		pool,
		repoRoot: REPO_ROOT,
		createHotfixProposal: async (args) => {
			const title = `Schema-drift hotfix: ${args.missingName} referenced after drop${args.originDisplayId ? ` in ${args.originDisplayId}` : ""}`;
			const summary = [
				`Auto-filed by P675 schema-drift monitor.`,
				`Missing identifier: \`${args.missingName}\` (sqlstate ${args.errorCode}).`,
				args.queryExcerpt ? `Failing query (normalized): \`${args.queryExcerpt}\`` : null,
				args.originDisplayId
					? `Origin traced to ${args.originDisplayId}${args.originCommitSha ? ` (commit ${args.originCommitSha.slice(0, 12)})` : ""}.`
					: "Origin could not be traced from git history or migration filenames.",
			]
				.filter(Boolean)
				.join("\n\n");

			const motivation = `A live service is hitting \`${args.missingName} does not exist\` repeatedly. Until the code is brought back in sync with the schema, the affected query will keep firing and burning connections / time. Operator surfaced this class of bug on 2026-04-28 (P675).`;

			const design = [
				"## What likely needs to happen",
				"",
				`1. Run \`grep -rn '${args.missingName}' src/ scripts/\` to enumerate every reference.`,
				"2. For each match, replace with the new column/relation name (or compute via SQL — for renamed cost_per_million_* columns, divide by 1000 to keep callers' arithmetic).",
				"3. If references span MCP / pg-handlers paths, rebuild `scripts/cli.cjs.js` so production services pick up the change.",
				"4. Restart any service that polls the broken endpoint.",
				"",
				"## Acceptance criteria",
				"",
				`1. \`grep -rn '${args.missingName}' src/ scripts/\` returns zero matches in production-loaded code (legacy migrations are exempt).`,
				`2. The journalctl scrape window for the next monitor cycle does not contain \`column "${args.missingName}" does not exist\`.`,
				"3. P675 monitor marks `schema_drift_seen.resolved_at` for this fingerprint within 30 minutes of the fix landing.",
				"",
				"## Reproducer",
				"",
				"```",
				args.rawLine.slice(0, 800),
				"```",
			].join("\n");

			try {
				const created = await createProposal(
					{
						title,
						type: "issue",
						parent_id: args.originDisplayId
							? await resolveParentId(pool, args.originDisplayId)
							: null,
						summary,
						motivation,
						design,
						drawbacks: "Auto-filed proposals can be wrong about origin tracing or include false positives. Operator should sanity-check the origin link before assuming the listed parent's authors must own the fix.",
						alternatives: "Manual triage via journalctl + grep (status quo before P675).",
						dependency_note: args.originDisplayId
							? `Re-opens incomplete change from ${args.originDisplayId}`
							: null,
						priority: "high",
						tags: {
							schema_drift: true,
							missing_name: args.missingName,
							error_code: args.errorCode,
							fingerprint: args.fingerprint,
							origin_unknown: args.originDisplayId === null,
							origin_commit: args.originCommitSha,
						},
					},
					"schema-drift-monitor",
				);
				return {
					id: Number(created.id),
					displayId: created.display_id ?? `#${created.id}`,
				};
			} catch (err) {
				console.error("[schema-drift] failed to create hotfix proposal:", err);
				return null;
			}
		},
	});

	console.log(
		`[schema-drift] cycle done: scanned=${result.scanned} unique=${result.uniqueFingerprints} new_hotfixes=${result.newHotfixes} repeats=${result.repeats} escalations=${result.escalations} errors=${result.errors.length}`,
	);
	if (result.errors.length > 0) {
		for (const e of result.errors) {
			console.warn(`[schema-drift] err: ${e}`);
		}
	}

	await closePool();
}

async function resolveParentId(
	pool: ReturnType<typeof getPool>,
	displayId: string,
): Promise<number | null> {
	try {
		const { rows } = await pool.query<{ id: string }>(
			`SELECT id FROM roadmap_proposal.proposal WHERE display_id = $1`,
			[displayId],
		);
		return rows[0] ? Number(rows[0].id) : null;
	} catch {
		return null;
	}
}

main().catch(async (err) => {
	console.error("[schema-drift] fatal:", err);
	try {
		await closePool();
	} catch {}
	process.exit(1);
});
