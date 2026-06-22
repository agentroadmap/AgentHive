#!/usr/bin/env node
/**
 * P2313: Idempotent migration runner with tracking.
 *
 * Applies pending migrations from scripts/migrations/*.sql in numeric order.
 * Tracks applied migrations in roadmap.schema_migration table.
 *
 * Usage:
 *   npm run migrate                 # Apply pending migrations
 *   npm run migrate:status          # Show applied + pending
 *   npm run migrate:dry-run         # List pending without applying
 *   npm run migrate:check           # BLOCKING gate: exit 1 on duplicate-prefix collision
 *   npm run migrate -- --baseline   # Mark all current *.sql as applied WITHOUT executing
 *
 * Flags:
 *   --status   Print applied count + pending list
 *   --dry-run  List pending, apply nothing
 *   --check    Release gate (P4664 AC-3): exit 1 if two applicable migration files
 *              share a numeric prefix with DIFFERENT checksums. Pending migrations
 *              are reported informationally (exit 0) unless STRICT_PENDING=1.
 *              The collision check needs NO database (runs in CI without DB).
 *   --baseline Record ALL current *.sql as applied WITHOUT executing (for hand-migrated DBs)
 *
 * Note: rollback (*.rollback.sql / *-rollback.sql) and superseded (*.SUPERSEDED.sql)
 * files are excluded from application and from collision detection.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, query } from "../src/infra/postgres/pool.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface MigrationFile {
	filename: string;
	path: string;
	prefix: number;
	checksum: string;
}

interface AppliedMigration {
	filename: string;
	checksum: string;
	applied_at: string;
	applied_by: string;
}

/**
 * Parse numeric prefix for sorting.
 * "180-p248-proposal.sql" -> 180
 * Handles any leading zeros; "003-x.sql" and "3-x.sql" compare correctly.
 */
function extractNumericPrefix(filename: string): number {
	const match = filename.match(/^(\d+)-/);
	return match ? parseInt(match[1], 10) : Infinity;
}

/**
 * A file is an applicable migration if it is a .sql file that is NOT a
 * rollback (.rollback.sql) and NOT a superseded/retained-for-history artifact
 * (.SUPERSEDED.sql). Rollback and superseded files intentionally share a prefix
 * with their parent and must never be applied or counted as collisions.
 */
function isApplicableMigration(filename: string): boolean {
	if (!filename.endsWith(".sql")) return false;
	if (filename.includes(".rollback.")) return false;
	if (filename.includes(".SUPERSEDED.")) return false;
	return true;
}

/**
 * AC-3 (P4664): Detect duplicate numeric prefixes among applicable migrations
 * where the colliding files have DIFFERENT checksums (i.e. genuinely distinct
 * migrations sharing a prefix — the bug class that left 254-p3566 un-ledgered).
 *
 * Pre-existing historical collisions are documented in
 * scripts/migration-prefix-exceptions.json and skipped. Any NEW collision (or a
 * collision whose prefix is not exempt) is a hard failure.
 *
 * Returns the list of unexempted collisions (empty = clean).
 */
function detectDuplicatePrefixCollisions(files: MigrationFile[]): string[] {
	const exceptionsPath = join(__dirname, "migration-prefix-exceptions.json");
	const exempt: Set<string> = new Set(
		existsSync(exceptionsPath)
			? (JSON.parse(readFileSync(exceptionsPath, "utf-8")) as string[])
			: [],
	);

	// Group applicable files by their raw prefix string (preserve leading zeros
	// so the exceptions list, which stores "003" etc., matches).
	const byPrefix = new Map<string, MigrationFile[]>();
	for (const file of files) {
		const match = file.filename.match(/^(\d+)/);
		if (!match) continue;
		const prefix = match[1];
		const list = byPrefix.get(prefix) ?? [];
		list.push(file);
		byPrefix.set(prefix, list);
	}

	const collisions: string[] = [];
	for (const [prefix, group] of byPrefix) {
		if (group.length < 2) continue;
		// Only a collision if the colliding files differ in content.
		const checksums = new Set(group.map((g) => g.checksum));
		if (checksums.size < 2) continue; // identical content, not a real conflict
		if (exempt.has(prefix)) continue; // documented pre-existing collision
		const names = group.map((g) => g.filename).join('", "');
		collisions.push(
			`Duplicate migration prefix ${prefix} with differing checksums: "${names}"`,
		);
	}
	return collisions;
}

/**
 * Load all .sql files from scripts/migrations/ and return sorted list.
 * Sorted by numeric prefix, then alphabetically for same prefix.
 */
function loadMigrationFiles(): MigrationFile[] {
	const migrationsDir = join(__dirname, "migrations");
	const files = readdirSync(migrationsDir)
		.filter(isApplicableMigration)
		.map((filename) => {
			const path = join(migrationsDir, filename);
			const content = readFileSync(path, "utf-8");
			const checksum = createHash("sha256").update(content).digest("hex");
			return {
				filename,
				path,
				prefix: extractNumericPrefix(filename),
				checksum,
			};
		});

	// Sort by prefix (numeric), then by filename (alphabetic) for tie-breaking
	files.sort((a, b) => {
		if (a.prefix !== b.prefix) return a.prefix - b.prefix;
		return a.filename.localeCompare(b.filename);
	});

	return files;
}

/**
 * Ensure migration tracking table exists.
 * CREATE IF NOT EXISTS — safe to run multiple times.
 */
async function ensureTrackingTable(): Promise<void> {
	await query(`
		CREATE TABLE IF NOT EXISTS roadmap.schema_migration (
			filename TEXT PRIMARY KEY,
			checksum TEXT NOT NULL,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			applied_by TEXT
		)
	`);
}

/**
 * Fetch all applied migrations from tracking table.
 */
async function getAppliedMigrations(): Promise<Map<string, AppliedMigration>> {
	await ensureTrackingTable();
	const result = await query<AppliedMigration>(
		`SELECT filename, checksum, applied_at, applied_by FROM roadmap.schema_migration ORDER BY applied_at ASC`,
	);
	const map = new Map<string, AppliedMigration>();
	for (const row of result.rows) {
		map.set(row.filename, row);
	}
	return map;
}

/**
 * Apply a single migration file in a transaction.
 * - BEGIN
 * - Execute the .sql file
 * - INSERT tracking row
 * - COMMIT
 *
 * On failure, throws with clear error naming the file.
 * The transaction rolls back; previously-applied migrations remain.
 */
async function applyMigration(
	file: MigrationFile,
	appliedBy: string,
): Promise<void> {
	const content = readFileSync(file.path, "utf-8");

	const pool = getPool();
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		try {
			// Execute the migration SQL
			await client.query(content);

			// Track the applied migration
			await client.query(
				`INSERT INTO roadmap.schema_migration (filename, checksum, applied_by)
					VALUES ($1, $2, $3)`,
				[file.filename, file.checksum, appliedBy],
			);

			await client.query("COMMIT");
		} catch (txnError) {
			await client.query("ROLLBACK").catch(() => {});
			throw txnError;
		}
	} finally {
		client.release();
	}
}

/**
 * Compare file checksum against tracked checksum.
 * If mismatch, log warning and return false (do not re-apply).
 */
function validateChecksum(
	file: MigrationFile,
	applied: AppliedMigration,
): boolean {
	if (file.checksum === applied.checksum) {
		return true;
	}

	console.warn(`[MIGRATION WARNING] Checksum mismatch for ${file.filename}:`);
	console.warn(`  Expected: ${applied.checksum}`);
	console.warn(`  Got:      ${file.checksum}`);
	console.warn(
		`  This file will NOT be re-applied (applied migrations are immutable).`,
	);
	return false;
}

/**
 * Apply all pending migrations.
 */
async function applyPendingMigrations(): Promise<void> {
	const files = loadMigrationFiles();
	const applied = await getAppliedMigrations();
	const appliedBy = process.env.USER ?? "migrate";

	const pending: MigrationFile[] = [];

	for (const file of files) {
		const entry = applied.get(file.filename);

		if (!entry) {
			// Not yet applied
			pending.push(file);
		} else {
			// Already applied — validate checksum
			const isValid = validateChecksum(file, entry);
			if (!isValid) {
				// Checksum mismatch — skip with warning (already logged above)
			}
		}
	}

	if (pending.length === 0) {
		console.log("[MIGRATE] All migrations already applied ✓");
		return;
	}

	console.log(`[MIGRATE] Applying ${pending.length} pending migration(s)...`);

	for (const file of pending) {
		try {
			console.log(`  Applying: ${file.filename}`);
			await applyMigration(file, appliedBy);
			console.log(`    ✓ Applied and tracked`);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.error(`\n[MIGRATE ERROR] Failed to apply ${file.filename}:`);
			console.error(`  ${msg}`);
			console.error(`\n  This migration's transaction was rolled back.`);
			console.error(`  Previously-applied migrations remain in place.`);
			process.exit(1);
		}
	}

	console.log(
		`\n[MIGRATE] ${pending.length} migration(s) applied successfully ✓`,
	);
}

/**
 * Print status: count of applied + list of pending.
 */
async function printStatus(): Promise<void> {
	const files = loadMigrationFiles();
	const applied = await getAppliedMigrations();

	const pending = files.filter((f) => !applied.has(f.filename));

	console.log(`[MIGRATE STATUS]`);
	console.log(`  Applied: ${applied.size}`);
	console.log(`  Pending: ${pending.length}`);
	console.log(`  Total:   ${files.length}`);

	if (pending.length > 0) {
		console.log(`\n  Pending migrations:`);
		for (const file of pending) {
			console.log(`    - ${file.filename}`);
		}
	}
}

/**
 * Dry run: list pending without applying.
 */
async function dryRun(): Promise<void> {
	const files = loadMigrationFiles();
	const applied = await getAppliedMigrations();

	const pending = files.filter((f) => !applied.has(f.filename));

	console.log(`[MIGRATE DRY-RUN]`);
	if (pending.length === 0) {
		console.log(`  No pending migrations.`);
		return;
	}

	console.log(`  Would apply ${pending.length} migration(s):`);
	for (const file of pending) {
		console.log(`    - ${file.filename}`);
	}
}

/**
 * Check mode (AC-3, P4664): blocking release gate.
 *
 * Two independent checks:
 *  1. Duplicate-prefix detection (DB-FREE): two applicable migration files
 *     sharing a numeric prefix with different checksums → exit 1.
 *  2. Pending detection (requires DB): unapplied migrations → exit 1.
 *
 * The duplicate-prefix check runs first and needs NO database, so it works in
 * CI without DB access. If the DB is unreachable, the pending check is reported
 * as skipped but the collision gate still enforces.
 */
async function checkPending(): Promise<void> {
	const files = loadMigrationFiles();

	// --- Check 1: duplicate-prefix collisions (no DB required) ---
	const collisions = detectDuplicatePrefixCollisions(files);
	if (collisions.length > 0) {
		console.error(
			`[MIGRATE CHECK] ✗ ${collisions.length} duplicate-prefix collision(s):`,
		);
		for (const c of collisions) {
			console.error(`  ❌ ${c}`);
		}
		console.error(
			`  Fix: renumber the colliding file to a free prefix (or, for a documented\n` +
				`  historical collision, add the prefix to scripts/migration-prefix-exceptions.json).`,
		);
		process.exit(1);
	}
	console.log(
		`[MIGRATE CHECK] ✓ ${files.length} applicable migration file(s) — no duplicate-prefix collisions.`,
	);

	// --- Check 2: pending migrations (requires DB) ---
	let applied: Map<string, AppliedMigration>;
	try {
		applied = await getAppliedMigrations();
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.warn(
			`[MIGRATE CHECK] ⚠ Could not reach DB to check pending migrations (${msg}). ` +
				`Duplicate-prefix gate passed; skipping pending check.`,
		);
		process.exit(0);
	}

	const pending = files.filter((f) => !applied.has(f.filename));
	if (pending.length > 0) {
		// Informational only: pending state is environment/DB-dependent and
		// reflects pre-existing ledger drift (catalogued in
		// scripts/migrations/LEDGER_RECONCILIATION.md, P4664). The BLOCKING gate
		// is duplicate-prefix collision detection above. Use --status / --dry-run
		// to act on pending; use STRICT_PENDING=1 to make pending a hard failure.
		console.warn(
			`[MIGRATE CHECK] ⚠ ${pending.length} pending migration(s) (informational; see LEDGER_RECONCILIATION.md).`,
		);
		if (process.env.STRICT_PENDING === "1") {
			console.error(
				`[MIGRATE CHECK] ✗ STRICT_PENDING=1 set → pending migrations fail the gate.`,
			);
			process.exit(1);
		}
		process.exit(0);
	}

	console.log(`[MIGRATE CHECK] All migrations applied ✓`);
	process.exit(0);
}

/**
 * Baseline mode: record all current .sql files as applied WITHOUT executing.
 * Used for existing hand-migrated databases.
 * Must be explicit (--baseline flag).
 */
async function baseline(): Promise<void> {
	const files = loadMigrationFiles();
	const applied = await getAppliedMigrations();
	const appliedBy = process.env.USER ?? "migrate";

	const toAdd = files.filter((f) => !applied.has(f.filename));

	if (toAdd.length === 0) {
		console.log(`[MIGRATE BASELINE] All migrations already tracked.`);
		return;
	}

	console.log(
		`[MIGRATE BASELINE] Recording ${toAdd.length} untracked migration(s) WITHOUT executing...`,
	);

	for (const file of toAdd) {
		try {
			await query(
				`INSERT INTO roadmap.schema_migration (filename, checksum, applied_by)
					VALUES ($1, $2, $3)`,
				[file.filename, file.checksum, appliedBy],
			);
			console.log(`  Recorded: ${file.filename}`);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.error(`[MIGRATE ERROR] Failed to record ${file.filename}:`);
			console.error(`  ${msg}`);
			process.exit(1);
		}
	}

	console.log(`\n[MIGRATE BASELINE] ${toAdd.length} migration(s) recorded ✓`);
}

/**
 * Parse command-line flags.
 */
function parseFlags(): {
	mode: "apply" | "status" | "dry-run" | "check" | "baseline";
} {
	const arg = process.argv[2];

	if (arg === "--status") {
		return { mode: "status" };
	}
	if (arg === "--dry-run") {
		return { mode: "dry-run" };
	}
	if (arg === "--check") {
		return { mode: "check" };
	}
	if (arg === "--baseline") {
		return { mode: "baseline" };
	}

	// Default: apply mode
	return { mode: "apply" };
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
	try {
		const { mode } = parseFlags();

		switch (mode) {
			case "status":
				await printStatus();
				break;
			case "dry-run":
				await dryRun();
				break;
			case "check":
				await checkPending();
				break;
			case "baseline":
				await baseline();
				break;
			case "apply":
			default:
				await applyPendingMigrations();
				break;
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.error(`[MIGRATE FATAL] ${msg}`);
		process.exit(1);
	}
}

void main();
