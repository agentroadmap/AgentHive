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
 *   npm run migrate:check           # Exit 1 if pending, 0 if all applied
 *   npm run migrate -- --baseline   # Mark all current *.sql as applied WITHOUT executing
 *
 * Flags:
 *   --status   Print applied count + pending list
 *   --dry-run  List pending, apply nothing
 *   --check    Exit 1 if any pending, else 0
 *   --baseline Record ALL current *.sql as applied WITHOUT executing (for hand-migrated DBs)
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { query, getPool } from "../src/infra/postgres/pool.ts";

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
 * Load all .sql files from scripts/migrations/ and return sorted list.
 * Sorted by numeric prefix, then alphabetically for same prefix.
 */
function loadMigrationFiles(): MigrationFile[] {
	const migrationsDir = join(__dirname, "migrations");
	const files = readdirSync(migrationsDir)
		.filter((f) => f.endsWith(".sql"))
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
async function applyMigration(file: MigrationFile, appliedBy: string): Promise<void> {
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

	console.warn(
		`[MIGRATION WARNING] Checksum mismatch for ${file.filename}:`,
	);
	console.warn(`  Expected: ${applied.checksum}`);
	console.warn(`  Got:      ${file.checksum}`);
	console.warn(`  This file will NOT be re-applied (applied migrations are immutable).`);
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

	console.log(`\n[MIGRATE] ${pending.length} migration(s) applied successfully ✓`);
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
 * Check mode: exit 1 if any pending, 0 if all applied.
 */
async function checkPending(): Promise<void> {
	const files = loadMigrationFiles();
	const applied = await getAppliedMigrations();

	const pending = files.filter((f) => !applied.has(f.filename));

	if (pending.length > 0) {
		console.log(`[MIGRATE CHECK] ${pending.length} pending migration(s)`);
		process.exit(1);
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
