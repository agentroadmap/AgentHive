#!/usr/bin/env node
/**
 * P4626 Gates 1+2 — Migration CONTINUITY + CHECKSUM verification against the
 * CANONICAL ledger.
 *
 * Canonical ledger = `roadmap.schema_migration` (P4664, CONVENTIONS.md §6.0).
 * `roadmap.migration_history` is RETIRED (locked read-only, migration 317) and
 * MUST NOT be consulted — this script was rewritten under P4626 to read the
 * canonical ledger instead of the retired one.
 *
 * Two checks, both BLOCKING when a DB is reachable:
 *   Gate 1 (continuity): every forward migration file on disk is recorded in
 *     roadmap.schema_migration. A file with no ledger row is a continuity gap.
 *   Gate 2 (checksum): the on-disk SHA-256 of each ledgered file matches the
 *     checksum stored at apply time. A mismatch means an applied migration was
 *     edited after the fact (immutability violation).
 *
 * Pre-existing ledger drift is catalogued in
 * scripts/migrations/LEDGER_RECONCILIATION.md (P4664) and grandfathered via
 * scripts/migration-continuity-baseline.json so this gate blocks NEW drift
 * without red-failing the historical backlog (warn→block, same pattern as the
 * semantic-writer gate).
 *
 * DB reachability: in CI without a DB the continuity/checksum checks cannot run.
 * They are reported as SKIPPED (exit 0) — the DB-free gates (duplicate-prefix in
 * scripts/migrate.ts --check, and the semantic-writer detector) still block.
 * Set STRICT_CONTINUITY=1 to fail when the DB is unreachable.
 *
 * Connection: uses PGHOST/PGPORT/PGUSER/PGDATABASE (defaults to the local
 * docker postgres-db: 127.0.0.1 / admin / agenthive). READ-ONLY — never mutates.
 *
 * Usage:
 *   node --import jiti/register scripts/verify-migration-continuity.ts
 */

import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface MigrationFile {
	name: string;
	path: string;
	checksum: string;
}

const PG = {
	host: process.env.PGHOST ?? "127.0.0.1",
	port: process.env.PGPORT ?? "5432",
	user: process.env.PGUSER ?? "admin",
	db: process.env.PGDATABASE ?? "agenthive",
};

/** Forward migration: .sql, not a rollback (.rollback. or -rollback.sql), not .SUPERSEDED. */
function isForwardMigration(filename: string): boolean {
	if (!filename.endsWith(".sql")) return false;
	if (filename.includes(".rollback.")) return false;
	if (/-rollback\.sql$/i.test(filename)) return false;
	if (filename.includes(".SUPERSEDED.")) return false;
	return true;
}

function projectRoot(): string {
	return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
}

function loadBaseline(root: string): Set<string> {
	const p = join(root, "scripts", "migration-continuity-baseline.json");
	if (!existsSync(p)) return new Set();
	const parsed = JSON.parse(readFileSync(p, "utf-8")) as {
		grandfathered?: string[];
	};
	return new Set(parsed.grandfathered ?? []);
}

function collectFiles(root: string): MigrationFile[] {
	// Canonical dir only. database/migrations/ is LEGACY (never applied) and is
	// intentionally NOT checked for ledger continuity (CONVENTIONS.md §6.0).
	const dir = join(root, "scripts", "migrations");
	if (!existsSync(dir)) return [];
	const out: MigrationFile[] = [];
	for (const file of readdirSync(dir)) {
		if (!isForwardMigration(file)) continue;
		if (!/^\d+-/.test(file)) continue;
		const full = join(dir, file);
		const content = readFileSync(full, "utf8");
		out.push({
			name: file,
			path: full,
			checksum: createHash("sha256").update(content).digest("hex"),
		});
	}
	out.sort((a, b) => Number.parseInt(a.name) - Number.parseInt(b.name));
	return out;
}

interface LedgerRow {
	filename: string;
	checksum: string;
}

/** Query the canonical ledger. Returns null if the DB is unreachable. */
function queryCanonicalLedger(): LedgerRow[] | null {
	try {
		const out = execFileSync(
			"psql",
			[
				"-h",
				PG.host,
				"-p",
				PG.port,
				"-U",
				PG.user,
				"-d",
				PG.db,
				"-t",
				"-A",
				"-F",
				"\t",
				"-c",
				"SELECT filename, checksum FROM roadmap.schema_migration ORDER BY applied_at;",
			],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
		return out
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
			.map((l) => {
				const [filename, checksum] = l.split("\t");
				return { filename, checksum };
			});
	} catch {
		return null;
	}
}

function main(): void {
	const root = projectRoot();
	const files = collectFiles(root);
	const baseline = loadBaseline(root);

	console.log(
		"=== Migration Continuity Report (canonical: roadmap.schema_migration) ===\n",
	);

	const ledger = queryCanonicalLedger();
	if (ledger === null) {
		const msg =
			"[CONTINUITY] ⚠ Could not reach DB (roadmap.schema_migration). " +
			"Continuity + checksum checks SKIPPED. DB-free gates (prefix, semantic-writer) still enforce.";
		if (process.env.STRICT_CONTINUITY === "1") {
			console.error(msg.replace("SKIPPED", "REQUIRED — STRICT_CONTINUITY=1"));
			process.exit(1);
		}
		console.warn(msg);
		process.exit(0);
	}

	const ledgerMap = new Map(ledger.map((r) => [r.filename, r.checksum]));

	const missing: string[] = [];
	const mismatched: string[] = [];

	for (const f of files) {
		const recorded = ledgerMap.get(f.name);
		if (recorded === undefined) {
			if (baseline.has(f.name)) {
				console.log(`⚠ WARN (grandfathered) missing from ledger: ${f.name}`);
			} else {
				missing.push(f.name);
			}
			continue;
		}
		if (recorded && recorded !== f.checksum) {
			if (baseline.has(f.name)) {
				console.log(`⚠ WARN (grandfathered) checksum drift: ${f.name}`);
			} else {
				mismatched.push(f.name);
			}
		}
	}

	for (const m of missing) {
		console.log(`MISSING (continuity gap): ${m}`);
		console.log(`  On disk but not in roadmap.schema_migration.`);
	}
	for (const m of mismatched) {
		console.log(`MISMATCH (checksum): ${m}`);
		console.log(`  On-disk SHA-256 differs from the ledgered checksum.`);
	}

	const issues = missing.length + mismatched.length;
	console.log(
		`\nFiles: ${files.length} | ledger rows: ${ledger.length} | ` +
			`grandfathered: ${baseline.size} | NEW issues: ${issues}`,
	);

	if (issues === 0) {
		console.log(
			"✓ No NEW continuity/checksum issues against the canonical ledger.",
		);
		process.exit(0);
	}
	console.error(
		`✗ ${issues} NEW continuity/checksum issue(s). ` +
			`Apply via scripts/migrate.ts, or (for documented historical drift) add to ` +
			`scripts/migration-continuity-baseline.json.`,
	);
	process.exit(1);
}

main();
