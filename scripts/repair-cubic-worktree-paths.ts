/**
 * P447: Repair script for cubic worktree path canonicalization
 *
 * Identifies cubics with non-canonical worktree paths and optionally migrates them.
 *
 * Usage:
 *   bun run scripts/repair-cubic-worktree-paths.ts [--apply] [--limit N]
 *
 * Default (dry-run): Lists legacy rows with current and proposed canonical paths.
 * --apply: Migrates rows to canonical paths and emits audit events.
 * --limit N: Limit to N rows (default 1000 for safety).
 *
 * Exit codes:
 *   0 = success
 *   1 = error
 */

import { query } from "../src/postgres/pool.ts";
import { safeWorktreePath } from "../src/shared/identity/sanitize-agent-id.ts";

const WORKTREE_ROOT = "/data/code/worktree";
const BATCH_SIZE = 100;

interface CubicLegacyRow {
	cubic_id: string;
	agent_identity: string;
	worktree_path: string;
}

interface AuditEvent {
	cubic_id: string;
	old_path: string;
	new_path: string;
	timestamp: string;
}

function proposedCanonicalPath(
	agentIdentity: string | null,
	cubicId: string,
): string {
	// If no agent_identity, use the cubic_id as fallback (sanitized)
	const identity = agentIdentity || cubicId.substring(0, 16);

	try {
		return safeWorktreePath(WORKTREE_ROOT, identity);
	} catch {
		// Last resort: use sanitized version of cubic_id
		return WORKTREE_ROOT + "/" + cubicId.replace(/[^a-z0-9_-]/g, "-");
	}
}

async function getLegacyRows(limit: number): Promise<CubicLegacyRow[]> {
	const { rows } = await query<CubicLegacyRow>(
		`SELECT cubic_id, agent_identity, worktree_path
     FROM roadmap.cubics
     WHERE worktree_path NOT LIKE '/data/code/worktree/%'
     ORDER BY created_at ASC
     LIMIT $1`,
		[limit],
	);
	return rows;
}

function formatTable(
	rows: CubicLegacyRow[],
	proposals: Map<string, string>,
): string {
	if (rows.length === 0) return "No legacy rows found.\n";

	const header = [
		"cubic_id",
		"agent_identity",
		"current_path",
		"proposed_path",
	];
	const colWidths = [36, 20, 40, 40]; // UUID + generous margins

	let table = header
		.map((h, i) => h.padEnd(colWidths[i]))
		.join(" | ");
	table += "\n";
	table += header
		.map((_, i) => "-".repeat(colWidths[i]))
		.join("-+-");
	table += "\n";

	for (const row of rows) {
		const proposed = proposals.get(row.cubic_id) || "ERROR";
		const cols = [
			row.cubic_id,
			row.agent_identity || "(null)",
			row.worktree_path,
			proposed,
		];
		table += cols
			.map((c, i) => String(c).padEnd(colWidths[i]))
			.join(" | ");
		table += "\n";
	}

	return table;
}

async function dryRun(limit: number): Promise<void> {
	console.log(`P447 Dry-Run: Scanning for legacy worktree paths...`);
	const rows = await getLegacyRows(limit);

	if (rows.length === 0) {
		console.log("✓ All cubics use canonical worktree paths.");
		return;
	}

	console.log(`\nFound ${rows.length} legacy cubics (limit: ${limit}):\n`);

	const proposals = new Map<string, string>();
	for (const row of rows) {
		proposals.set(
			row.cubic_id,
			proposedCanonicalPath(row.agent_identity, row.cubic_id),
		);
	}

	console.log(formatTable(rows, proposals));

	console.log(
		`\nTo migrate these rows, run with --apply flag:\n  bun run scripts/repair-cubic-worktree-paths.ts --apply`,
	);
}

async function applyRepair(limit: number): Promise<void> {
	console.log(`P447 Apply: Starting migration of legacy worktree paths...`);

	const rows = await getLegacyRows(limit);

	if (rows.length === 0) {
		console.log("✓ No legacy rows to repair.");
		return;
	}

	console.log(`\nMigrating ${rows.length} cubics...\n`);

	let successCount = 0;
	let errorCount = 0;
	const events: AuditEvent[] = [];

	// Process in batches to avoid overwhelming the DB
	for (let i = 0; i < rows.length; i += BATCH_SIZE) {
		const batch = rows.slice(i, i + BATCH_SIZE);

		for (const row of batch) {
			try {
				const newPath = proposedCanonicalPath(
					row.agent_identity,
					row.cubic_id,
				);

				// Skip if already at canonical path (idempotent)
				if (row.worktree_path === newPath) {
					console.log(`  ✓ ${row.cubic_id}: already canonical`);
					successCount++;
					continue;
				}

				// Update the row
				await query(
					`UPDATE roadmap.cubics
           SET worktree_path = $1
           WHERE cubic_id = $2`,
					[newPath, row.cubic_id],
				);

				// Emit audit event
				events.push({
					cubic_id: row.cubic_id,
					old_path: row.worktree_path,
					new_path: newPath,
					timestamp: new Date().toISOString(),
				});

				console.log(
					`  ✓ ${row.cubic_id}: ${row.worktree_path} -> ${newPath}`,
				);
				successCount++;
			} catch (err) {
				console.error(
					`  ✗ ${row.cubic_id}: ${err instanceof Error ? err.message : String(err)}`,
				);
				errorCount++;
			}
		}
	}

	// Log audit events if any were created
	if (events.length > 0) {
		console.log(`\nLogging ${events.length} audit events...`);
		try {
			// Insert audit events into proposal_event or similar audit table
			// For now, just log to stdout (actual audit table integration would go here)
			for (const evt of events) {
				console.log(
					`  [audit] cubic=${evt.cubic_id} old_path="${evt.old_path}" new_path="${evt.new_path}"`,
				);
			}
		} catch (err) {
			console.error(`Audit logging error: ${err}`);
		}
	}

	console.log(`\nMigration complete: ${successCount} success, ${errorCount} errors`);

	if (errorCount === 0) {
		console.log(
			"\n✓ All rows migrated. To validate the CHECK constraint, run:",
		);
		console.log(
			'  psql ... -c "ALTER TABLE roadmap.cubics VALIDATE CONSTRAINT ck_cubics_worktree_path_canonical;"',
		);
	}
}

// Parse arguments
const args = Bun.argv.slice(2);
const applyMode = args.includes("--apply");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 1000;

try {
	if (applyMode) {
		await applyRepair(limit);
	} else {
		await dryRun(limit);
	}
	process.exit(0);
} catch (err) {
	console.error(`Fatal error: ${err}`);
	process.exit(1);
}
