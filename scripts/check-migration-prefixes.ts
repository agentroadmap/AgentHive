#!/usr/bin/env node
// Source of truth: scripts/migrations/ (canonical active migrations).
// database/migrations/ is legacy (pre-P753) — duplicate prefixes there are pre-existing.
// Rollback files (.rollback.sql) are excluded — they share prefix with their parent by design.
// Pre-existing collisions from before this check existed are listed in migration-prefix-exceptions.json.
import { readdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";

const migrationsDir = join(import.meta.dirname ?? process.cwd(), "../scripts/migrations");
const exceptionsPath = join(import.meta.dirname ?? process.cwd(), "../scripts/migration-prefix-exceptions.json");

const files = readdirSync(migrationsDir)
	.filter((f) => f.endsWith(".sql") && !f.includes(".rollback."))
	.sort();

const exemptPrefixes: Set<string> = new Set(
	existsSync(exceptionsPath)
		? (JSON.parse(readFileSync(exceptionsPath, "utf-8")) as string[])
		: [],
);

const seen = new Map<string, string>();
let failed = false;

for (const file of files) {
	const match = file.match(/^(\d+)/);
	if (!match) continue;
	const prefix = match[1];
	if (seen.has(prefix)) {
		if (!exemptPrefixes.has(prefix)) {
			console.error(
				`❌ Duplicate migration prefix ${prefix}: "${seen.get(prefix)}" and "${file}"`,
			);
			failed = true;
		}
	} else {
		seen.set(prefix, file);
	}
}

if (failed) {
	process.exit(1);
} else {
	console.log(
		`✅ ${files.length} migration files checked — no unexempted duplicate prefixes.`,
	);
}
