#!/usr/bin/env node
/**
 * P4626 Gate 4 — Semantic-writer / multi-CREATE-OR-REPLACE detection.
 *
 * The duplicate-numeric-prefix gate (P4664, scripts/migrate.ts --check) catches
 * two FILES that share a numeric prefix. It does NOT catch the more dangerous
 * class of drift: many *distinct* migrations that each `CREATE OR REPLACE` the
 * SAME database object (function / procedure / trigger / view). Postgres applies
 * these last-writer-wins, so an earlier migration's governance logic can be
 * silently dropped by a later rewrite that forgot to carry it forward.
 *
 * The canonical real-world example is `roadmap_proposal.fn_guard_gate_advance`,
 * the gate-advance authorization guard, which was rewritten across migrations
 * 040 / 174 / 189 / 270 / 289 / 291 / 299. Each rewrite risked dropping a prior
 * invariant (and historically did — see the P906 bypass regression).
 *
 * This script scans scripts/migrations/*.sql (applicable files only — rollback
 * and .SUPERSEDED.sql are excluded, matching scripts/migrate.ts semantics) and
 * reports every object defined by MORE THAN ONE migration.
 *
 * Rollout (AC-12): known pre-existing offenders are allowlisted in
 * scripts/migration-semantic-writers-allowlist.json. Allowlisted objects are
 * reported as WARN (and the gate still passes) so the repo is not red on day
 * one; any object NOT on the allowlist with >1 definer FAILS the gate (exit 1).
 * This is the warn→block path: as offenders are consolidated, remove them from
 * the allowlist; new multi-writers block immediately.
 *
 * Usage:
 *   node --import jiti/register scripts/detect-semantic-writers.ts
 *   node --import jiti/register scripts/detect-semantic-writers.ts --json
 *   node --import jiti/register scripts/detect-semantic-writers.ts --strict   # ignore allowlist (everything blocks)
 *
 * Needs NO database — pure static analysis of the migration files.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATIONS_DIR = join(__dirname, "migrations");
const ALLOWLIST_PATH = join(
	__dirname,
	"migration-semantic-writers-allowlist.json",
);

/** A migration file that may define one or more objects. */
interface MigrationFile {
	filename: string;
	content: string;
}

/** A definer occurrence: object `name` of `kind` defined in `filename`. */
interface Definer {
	name: string;
	kind: string;
	filename: string;
}

interface AllowlistEntry {
	/** Fully-qualified object key, e.g. "function:roadmap_proposal.fn_guard_gate_advance" */
	object: string;
	/** Free-text justification — why this grandfathered offender is tolerated. */
	reason: string;
}

interface Allowlist {
	objects: AllowlistEntry[];
}

/**
 * Forward migration = .sql, not a rollback, not a .SUPERSEDED.sql artifact.
 *
 * This mirrors the INTENT of scripts/migrate.ts isApplicableMigration (which
 * exempts `.rollback.` and `.SUPERSEDED.`), but additionally excludes the legacy
 * hyphen form `NNN-...-rollback.sql` that a handful of older files still use
 * (e.g. 070-p741-rollback.sql). A rollback script is the INVERSE of a forward
 * migration; counting a forward `CREATE OR REPLACE` together with its rollback's
 * re-create would be a false positive for the last-writer-wins hazard this gate
 * exists to catch. Rollbacks are never forward-applied in a clean deploy.
 */
function isForwardMigration(filename: string): boolean {
	if (!filename.endsWith(".sql")) return false;
	if (filename.includes(".rollback.")) return false;
	if (/-rollback\.sql$/i.test(filename)) return false;
	if (filename.includes(".SUPERSEDED.")) return false;
	return true;
}

/**
 * Strip SQL line (`--`) and block (`/* *​/`) comments so that commented-out or
 * documentation references to a function are not counted as definers.
 */
function stripSqlComments(sql: string): string {
	// Remove block comments (non-greedy, across newlines).
	let out = sql.replace(/\/\*[\s\S]*?\*\//g, " ");
	// Remove line comments.
	out = out.replace(/--[^\n]*/g, " ");
	return out;
}

/**
 * Object-defining statement patterns. We treat `CREATE OR REPLACE` and bare
 * `CREATE` (for objects that cannot be OR REPLACEd, like TRIGGER) as definers,
 * because re-creating a trigger across migrations is the same last-writer-wins
 * hazard. We deliberately do NOT count `CREATE TABLE` / `ALTER` — additive table
 * DDL is normal and handled by the prefix/continuity gates.
 */
const DEFINER_PATTERNS: { kind: string; re: RegExp }[] = [
	{
		kind: "function",
		re: /\bcreate\s+(?:or\s+replace\s+)?function\s+([a-z0-9_."]+)\s*\(/gi,
	},
	{
		kind: "procedure",
		re: /\bcreate\s+(?:or\s+replace\s+)?procedure\s+([a-z0-9_."]+)\s*\(/gi,
	},
	{
		kind: "view",
		re: /\bcreate\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+([a-z0-9_."]+)\b/gi,
	},
	{
		kind: "trigger",
		re: /\bcreate\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+([a-z0-9_."]+)\b/gi,
	},
];

function normalizeName(raw: string): string {
	// Drop surrounding quotes on identifiers, lowercase (Postgres folds unquoted).
	return raw.replace(/"/g, "").toLowerCase();
}

function loadMigrationFiles(): MigrationFile[] {
	return readdirSync(MIGRATIONS_DIR)
		.filter(isForwardMigration)
		.sort()
		.map((filename) => ({
			filename,
			content: readFileSync(join(MIGRATIONS_DIR, filename), "utf-8"),
		}));
}

/** Extract every object-defining occurrence from a migration's SQL. */
function extractDefiners(file: MigrationFile): Definer[] {
	const sql = stripSqlComments(file.content);
	const found: Definer[] = [];
	for (const { kind, re } of DEFINER_PATTERNS) {
		re.lastIndex = 0;
		let m: RegExpExecArray | null = re.exec(sql);
		while (m !== null) {
			found.push({
				name: normalizeName(m[1]),
				kind,
				filename: file.filename,
			});
			m = re.exec(sql);
		}
	}
	return found;
}

function loadAllowlist(): Set<string> {
	if (!existsSync(ALLOWLIST_PATH)) return new Set();
	const parsed = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf-8")) as Allowlist;
	return new Set((parsed.objects ?? []).map((e) => e.object));
}

interface MultiWriter {
	objectKey: string; // "function:roadmap_proposal.fn_guard_gate_advance"
	kind: string;
	name: string;
	files: string[]; // distinct migration files, sorted
}

/** Group definers by object key; return only those defined by >1 distinct file. */
function findMultiWriters(definers: Definer[]): MultiWriter[] {
	const byObject = new Map<string, Set<string>>();
	const meta = new Map<string, { kind: string; name: string }>();
	for (const d of definers) {
		const key = `${d.kind}:${d.name}`;
		const set = byObject.get(key) ?? new Set<string>();
		set.add(d.filename);
		byObject.set(key, set);
		meta.set(key, { kind: d.kind, name: d.name });
	}

	const result: MultiWriter[] = [];
	for (const [key, files] of byObject) {
		if (files.size < 2) continue;
		const m = meta.get(key)!;
		result.push({
			objectKey: key,
			kind: m.kind,
			name: m.name,
			files: [...files].sort(),
		});
	}
	// Stable, deterministic ordering: most definers first, then by name.
	result.sort(
		(a, b) => b.files.length - a.files.length || a.name.localeCompare(b.name),
	);
	return result;
}

function main(): void {
	const asJson = process.argv.includes("--json");
	const strict = process.argv.includes("--strict");

	const files = loadMigrationFiles();
	const definers = files.flatMap(extractDefiners);
	const multi = findMultiWriters(definers);
	const allowlist = strict ? new Set<string>() : loadAllowlist();

	const blocking = multi.filter((m) => !allowlist.has(m.objectKey));
	const grandfathered = multi.filter((m) => allowlist.has(m.objectKey));

	if (asJson) {
		console.log(
			JSON.stringify(
				{
					scanned: files.length,
					multiWriters: multi,
					blocking: blocking.map((m) => m.objectKey),
					grandfathered: grandfathered.map((m) => m.objectKey),
				},
				null,
				2,
			),
		);
		process.exit(blocking.length > 0 ? 1 : 0);
	}

	console.log(
		`[SEMANTIC-WRITERS] Scanned ${files.length} applicable migration file(s).`,
	);
	console.log(
		`[SEMANTIC-WRITERS] ${multi.length} object(s) defined by >1 migration ` +
			`(${grandfathered.length} grandfathered, ${blocking.length} blocking).\n`,
	);

	for (const m of multi) {
		const grand = allowlist.has(m.objectKey);
		const tag = grand ? "⚠ WARN (grandfathered)" : "❌ BLOCK";
		console.log(`${tag}  ${m.kind} ${m.name} — ${m.files.length} definers:`);
		for (const f of m.files) console.log(`     - ${f}`);
		console.log("");
	}

	if (blocking.length > 0) {
		console.error(
			`[SEMANTIC-WRITERS] ✗ ${blocking.length} NEW multi-writer object(s) not on the allowlist.`,
		);
		console.error(
			`  Fix: consolidate the duplicate definitions into a single migration, OR\n` +
				`  (for an intentional grandfathered rewrite chain) add the object to\n` +
				`  scripts/migration-semantic-writers-allowlist.json with a reason.`,
		);
		process.exit(1);
	}

	console.log(
		`[SEMANTIC-WRITERS] ✓ No NEW multi-writer objects. ` +
			`${grandfathered.length} pre-existing offender(s) warned (warn→block path).`,
	);
	process.exit(0);
}

main();
