/**
 * P677 — pre-merge SQL column audit (v1, regex-based).
 *
 * Walks src/ and scripts/ for TypeScript/JS files, extracts string-literal SQL,
 * pulls (schema.table, column) candidates with regex, and validates each
 * against `information_schema.columns` of the configured DB.
 *
 * Limitations of v1:
 *   - Regex-only; doesn't understand CTEs, aliases, or subqueries.
 *   - Can't tell which table an unqualified column belongs to — if a column
 *     name exists on ANY visible table, it's accepted (lenient).
 *   - Identifies columns mostly inside SELECT and after WHERE/AND/OR/SET.
 *   - String-concatenated SQL ("SELECT " + cols + " FROM ...") is not parsed
 *     beyond what each fragment exposes.
 *
 * False-positive policy: when a candidate column is flagged "unknown" but
 * appears in scripts/ci/sql-audit-allowlist.txt, it's downgraded to a notice.
 *
 * Usage:
 *   DATABASE_URL=... node --import jiti/register scripts/ci/audit-sql-columns.ts
 *   DATABASE_URL=... node --import jiti/register scripts/ci/audit-sql-columns.ts --paths src/core
 *
 * Exit codes:
 *   0 — no violations
 *   1 — at least one unknown column reference
 *   2 — DB connection or audit infrastructure failure
 */

import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

const DEFAULT_PATHS = ["src", "scripts"];
const FILE_EXTS = /\.(ts|tsx|js|cjs|mjs)$/;
const SKIP_DIRS = new Set([
	"node_modules",
	"dist",
	".git",
	"src/web",       // bundled output
	"docs",
]);
const SKIP_FILES = new Set([
	"scripts/cli.cjs.js",       // bundled CLI artifact (re-checked at source)
	"scripts/cli.cjs.js.map",
]);

const ALLOWLIST_FILE = path.join(ROOT, "scripts", "ci", "sql-audit-allowlist.txt");

interface Violation {
	file: string;
	line: number;
	column: string;
	context: string;
}

// P677 AC-19: unparseable/unanalyzable SQL fragments are reported as warn
// lines in the JSON output but never affect the exit code — only schema
// mismatches (Violation) cause exit 1.
interface AuditWarning {
	level: "warn";
	file: string;
	line: number;
	reason: string;
	context: string;
}

function parseArgs(argv: string[]): { paths: string[]; verbose: boolean } {
	const paths: string[] = [];
	let verbose = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--paths") {
			while (++i < argv.length && !argv[i].startsWith("--")) {
				paths.push(argv[i]);
			}
			i--;
		} else if (a === "--verbose" || a === "-v") {
			verbose = true;
		}
	}
	return {
		paths: paths.length ? paths : DEFAULT_PATHS,
		verbose,
	};
}

function* walkFiles(start: string): Generator<string> {
	// A --paths argument may be a single file, not a directory (AC-19 fixture
	// runs use this); readdirSync on a file throws and used to silently skip it.
	try {
		if (fs.statSync(start).isFile()) {
			if (FILE_EXTS.test(path.basename(start))) yield start;
			return;
		}
	} catch {
		return;
	}
	const stack = [start];
	while (stack.length) {
		const dir = stack.pop()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const ent of entries) {
			const full = path.join(dir, ent.name);
			const rel = path.relative(ROOT, full);
			if (ent.isDirectory()) {
				if (SKIP_DIRS.has(ent.name) || SKIP_DIRS.has(rel)) continue;
				stack.push(full);
			} else if (ent.isFile() && FILE_EXTS.test(ent.name)) {
				if (SKIP_FILES.has(rel)) continue;
				yield full;
			}
		}
	}
}

const SQL_KEYWORD_RE = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE)\b/i;
// Match ` ... ` template-literal or ' ... ' / " ... " single-line string literals
// across multiple lines for backticks.
const TEMPLATE_RE = /`([\s\S]*?)`/g;
const SINGLE_RE = /'((?:[^'\\]|\\.){40,})'/g;
const DOUBLE_RE = /"((?:[^"\\]|\\.){40,})"/g;

interface SqlBlock {
	file: string;
	startLine: number;
	body: string;
}

function extractSqlBlocks(file: string, source: string): SqlBlock[] {
	const blocks: SqlBlock[] = [];
	const lineStarts: number[] = [0];
	for (let i = 0; i < source.length; i++) {
		if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
	}
	function lineOf(off: number): number {
		let lo = 0;
		let hi = lineStarts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (lineStarts[mid] <= off) lo = mid;
			else hi = mid - 1;
		}
		return lo + 1;
	}
	const SQL_LEADING = /^\s*(?:\/\*[^]*?\*\/\s*|--[^\n]*\n\s*)*(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|WITH|CREATE\s+TABLE|ALTER\s+TABLE)\b/i;
	for (const re of [TEMPLATE_RE, SINGLE_RE, DOUBLE_RE]) {
		re.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(source)) !== null) {
			const body = m[1];
			if (body.length < 40) continue;
			// Strict check: literal must START with a SQL keyword (after optional
			// leading whitespace + comments). This eliminates false positives
			// where an unrelated JS template literal happens to contain "SELECT"
			// or "FROM" inside a comment or interpolation.
			if (!SQL_LEADING.test(body)) continue;
			blocks.push({ file, startLine: lineOf(m.index), body });
		}
	}
	return blocks;
}

// Pull (table?, column) candidates from a SQL fragment.
// Strategy: find FROM/JOIN/UPDATE/INTO clauses → collect table names.
// Then find column references in SELECT lists, WHERE/AND/OR conditions,
// SET clauses, ORDER BY, GROUP BY, INSERT column lists.
const TABLE_RE = /\b(?:FROM|JOIN|UPDATE|INTO)\s+([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)/gi;
// Qualified column: alias.column or schema.table.column
const QUALIFIED_COL_RE = /\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]+)\b/gi;
// Column-like identifiers in select lists / WHERE — snake_case 4+ chars to
// keep noise low. Filter out PG keywords + common patterns later.
const COLUMN_RE = /\b([a-z][a-z0-9_]{3,})\b/gi;

const SQL_KEYWORDS = new Set([
	"select","from","where","and","or","not","null","is","as","on","in","into",
	"insert","update","delete","values","set","order","by","group","having",
	"limit","offset","join","left","right","inner","outer","full","cross",
	"with","recursive","union","all","case","when","then","else","end",
	"distinct","asc","desc","true","false","like","ilike","between",
	"exists","any","some","cast","coalesce","nullif","greatest","least",
	"now","interval","date","timestamp","timestamptz","text","integer",
	"bigint","boolean","jsonb","json","numeric","decimal","array","table",
	"create","alter","drop","add","constraint","primary","key","foreign",
	"references","cascade","restrict","check","unique","index","using",
	"returning","conflict","do","nothing","fetch","for","update","share",
	"if","exists","schema","column","rename","to","default","collate",
	"begin","commit","rollback","savepoint","release","start","transaction",
	"declare","cursor","fetch","close","explain","analyze","verbose",
	"vacuum","reindex","cluster","copy","grant","revoke","privileges",
	"row","rows","only","ties","percent","first","last","nulls",
	// pg builtin funcs we don't audit
	"now","current_timestamp","current_date","current_user","session_user",
	"length","char_length","upper","lower","substring","trim","position",
	"to_jsonb","jsonb_build_object","jsonb_set","jsonb_array_elements",
	"to_char","to_timestamp","extract","date_trunc","age",
	"count","sum","avg","min","max","array_agg","string_agg","jsonb_agg",
	"row_number","rank","dense_rank","lag","lead","over","partition",
	"nextval","currval","setval","gen_random_uuid",
	"pg_notify","pg_sleep","pg_advisory_lock","pg_try_advisory_lock",
	"pg_advisory_unlock",
]);

function extractCandidates(
	body: string,
	idx: ColumnIndex,
): Map<string, { col: string; tables: Set<string> }> {
	// Collect tables explicitly named in the FROM/JOIN/UPDATE/INTO clauses;
	// these are the legal tables an unresolved alias could refer to.
	const tablesInQuery = new Set<string>();
	let m: RegExpExecArray | null;
	TABLE_RE.lastIndex = 0;
	while ((m = TABLE_RE.exec(body)) !== null) {
		tablesInQuery.add(m[1].toLowerCase());
	}

	const candidates = new Map<string, { col: string; tables: Set<string> }>();

	QUALIFIED_COL_RE.lastIndex = 0;
	while ((m = QUALIFIED_COL_RE.exec(body)) !== null) {
		const qualifier = m[1].toLowerCase();
		const col = m[2].toLowerCase();
		if (SQL_KEYWORDS.has(qualifier) || SQL_KEYWORDS.has(col)) continue;
		// Skip schema.table patterns: qualifier is a known schema AND col is a
		// known table name → this isn't a column reference at all.
		if (idx.schemas.has(qualifier) && idx.tables.has(col)) continue;
		// Skip schema.function calls (immediately followed by '(' or known func).
		const after = body.slice(m.index + m[0].length, m.index + m[0].length + 2);
		if (after.startsWith("(")) continue;
		if (idx.schemas.has(qualifier) && idx.functions.has(col)) continue;

		// Conservative v1: only audit qualifiers we're confident about.
		//   Case A — qualifier is a known schema: column must exist in some
		//             table within that schema.
		//   Case B — qualifier is a known table name AND that table is
		//             named in this query's FROM/JOIN clause: column must
		//             exist in that table. The from-clause check defends
		//             against alias collisions: e.g.
		//             `UPDATE agent_registry agency` — `agency` is also a
		//             real table elsewhere in the schema, but it's an alias
		//             here.
		//   Case C — qualifier is unknown: SKIP (alias resolution requires
		//             a real parser; defer to v2).
		const targetTables = new Set<string>();
		if (idx.schemas.has(qualifier)) {
			targetTables.add(qualifier);
		} else if (idx.tables.has(qualifier)) {
			// Verify the table is actually used in this query (not just an
			// alias that shadows a real table name).
			let confirmed = false;
			for (const t of tablesInQuery) {
				const bare = t.includes(".") ? t.split(".").pop()! : t;
				if (bare === qualifier) {
					confirmed = true;
					break;
				}
			}
			if (!confirmed) continue;
			targetTables.add(qualifier);
		} else {
			continue;
		}
		const key = `${qualifier}.${col}@${m.index}`;
		candidates.set(key, { col, tables: targetTables });
	}

	return candidates;
}

interface ColumnIndex {
	// schema.table → set of columns
	bySchemaTable: Map<string, Set<string>>;
	// table → set of columns (unqualified lookup; collapses across schemas)
	byTable: Map<string, Set<string>>;
	// All schema names visible in information_schema.
	schemas: Set<string>;
	// All table names (unqualified) — used to skip schema.table patterns when
	// extracting (alias.column).
	tables: Set<string>;
	// Function names per schema — used to skip function-call qualifiers.
	functions: Set<string>;
}

async function buildColumnIndex(client: Client): Promise<ColumnIndex> {
	const { rows } = await client.query<{
		table_schema: string;
		table_name: string;
		column_name: string;
	}>(
		`SELECT table_schema, table_name, column_name
		   FROM information_schema.columns
		  WHERE table_schema NOT IN ('pg_catalog','information_schema','pg_toast')`,
	);
	const bySchemaTable = new Map<string, Set<string>>();
	const byTable = new Map<string, Set<string>>();
	const schemas = new Set<string>();
	const tables = new Set<string>();
	for (const row of rows) {
		const st = `${row.table_schema}.${row.table_name}`.toLowerCase();
		if (!bySchemaTable.has(st)) bySchemaTable.set(st, new Set());
		bySchemaTable.get(st)!.add(row.column_name.toLowerCase());
		const t = row.table_name.toLowerCase();
		if (!byTable.has(t)) byTable.set(t, new Set());
		byTable.get(t)!.add(row.column_name.toLowerCase());
		schemas.add(row.table_schema.toLowerCase());
		tables.add(t);
	}
	const { rows: funcRows } = await client.query<{ proname: string }>(
		`SELECT DISTINCT p.proname
		   FROM pg_proc p
		   JOIN pg_namespace n ON n.oid = p.pronamespace
		  WHERE n.nspname NOT IN ('pg_catalog','information_schema')`,
	);
	const functions = new Set<string>();
	for (const r of funcRows) functions.add(r.proname.toLowerCase());
	return { bySchemaTable, byTable, schemas, tables, functions };
}

function loadAllowlist(): { byFile: Map<string, Set<string>>; global: Set<string> } {
	const byFile = new Map<string, Set<string>>();
	const global = new Set<string>();
	if (!fs.existsSync(ALLOWLIST_FILE)) return { byFile, global };
	const text = fs.readFileSync(ALLOWLIST_FILE, "utf8");
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const idx = line.indexOf(":");
		if (idx === -1) {
			global.add(line);
		} else {
			const file = line.slice(0, idx);
			const col = line.slice(idx + 1);
			if (!byFile.has(file)) byFile.set(file, new Set());
			byFile.get(file)!.add(col);
		}
	}
	return { byFile, global };
}

function isAllowed(
	allow: { byFile: Map<string, Set<string>>; global: Set<string> },
	relFile: string,
	col: string,
): boolean {
	if (allow.global.has(col)) return true;
	const fileSet = allow.byFile.get(relFile);
	if (fileSet && fileSet.has(col)) return true;
	return false;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const dbUrl = process.env.DATABASE_URL;
	if (!dbUrl) {
		console.error("audit-sql-columns: DATABASE_URL env var required");
		process.exit(2);
	}

	const client = new Client({ connectionString: dbUrl });
	try {
		await client.connect();
	} catch (err) {
		console.error("audit-sql-columns: DB connect failed —", (err as Error).message);
		process.exit(2);
	}
	let index: ColumnIndex;
	try {
		index = await buildColumnIndex(client);
	} finally {
		await client.end();
	}
	const allow = loadAllowlist();

	const violations: Violation[] = [];
	const warnings: AuditWarning[] = [];
	let scannedFiles = 0;
	let scannedBlocks = 0;
	let scannedColumns = 0;

	for (const startPath of args.paths) {
		const abs = path.isAbsolute(startPath) ? startPath : path.join(ROOT, startPath);
		if (!fs.existsSync(abs)) continue;
		for (const file of walkFiles(abs)) {
			scannedFiles++;
			const source = fs.readFileSync(file, "utf8");
			const blocks = extractSqlBlocks(file, source);
			for (const blk of blocks) {
				scannedBlocks++;
				// AC-19: a structurally truncated fragment (unbalanced parens —
				// typical of concatenated/interpolated SQL) cannot be analyzed
				// reliably; report it as a warn and skip, never fail on it.
				let depth = 0;
				for (const ch of blk.body) {
					if (ch === "(") depth++;
					else if (ch === ")") depth--;
				}
				if (depth !== 0) {
					warnings.push({
						level: "warn",
						file: path.relative(ROOT, blk.file),
						line: blk.startLine,
						reason: `unparseable SQL fragment: unbalanced parentheses (depth ${depth})`,
						context: blk.body.slice(0, 120).replace(/\s+/g, " "),
					});
					continue;
				}
				let candidates: ReturnType<typeof extractCandidates>;
				try {
					candidates = extractCandidates(blk.body, index);
				} catch (err) {
					// AC-19: a fragment the analyzer cannot parse is a warn,
					// never a failure (regex analyzer v1; WASM parser is v2).
					warnings.push({
						level: "warn",
						file: path.relative(ROOT, blk.file),
						line: blk.startLine,
						reason: `unparseable SQL fragment: ${(err as Error).message}`,
						context: blk.body.slice(0, 120).replace(/\s+/g, " "),
					});
					continue;
				}
				for (const [, c] of candidates) {
					scannedColumns++;
					// Try each candidate qualifier as table or schema.table.
					let known = false;
					for (const t of c.tables) {
						const dotted = t.includes(".") ? t : null;
						if (dotted && index.bySchemaTable.has(dotted)) {
							if (index.bySchemaTable.get(dotted)!.has(c.col)) {
								known = true;
								break;
							}
						}
						const bare = t.includes(".") ? t.split(".").pop()! : t;
						if (index.byTable.has(bare) && index.byTable.get(bare)!.has(c.col)) {
							known = true;
							break;
						}
					}
					if (known) continue;
					const relFile = path.relative(ROOT, blk.file);
					if (isAllowed(allow, relFile, c.col)) continue;
					violations.push({
						file: relFile,
						line: blk.startLine,
						column: c.col,
						context: blk.body.slice(0, 120).replace(/\s+/g, " "),
					});
				}
			}
		}
	}

	console.log(
		`audit-sql-columns: scanned ${scannedFiles} files, ${scannedBlocks} SQL blocks, ${scannedColumns} qualified column refs.`,
	);

	// AC-19: warn lines appear in the JSON report but never flip the exit code.
	if (warnings.length > 0) {
		console.log(`audit-sql-columns: ${warnings.length} warn(s) — unparseable fragments skipped:`);
		console.log(JSON.stringify(warnings, null, 2));
	}

	if (violations.length === 0) {
		console.log("audit-sql-columns: no unknown column references found.");
		process.exit(0);
	}

	console.log(`audit-sql-columns: ${violations.length} unknown column reference(s):`);
	const out = JSON.stringify(violations, null, 2);
	console.log(out);
	process.exit(1);
}

main().catch((err) => {
	console.error("audit-sql-columns: fatal", err);
	process.exit(2);
});
