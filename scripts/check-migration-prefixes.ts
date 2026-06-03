#!/usr/bin/env node
// Source of truth: scripts/migrations/ (canonical active migrations).
// database/migrations/ is legacy (pre-P753) — duplicate prefixes there are pre-existing.
import { readdirSync } from "fs";
import { join } from "path";

const migrationsDir = join(
	import.meta.dirname ?? process.cwd(),
	"../scripts/migrations",
);
const files = readdirSync(migrationsDir)
	.filter((f) => f.endsWith(".sql"))
	.sort();

const seen = new Map<string, string>();
let failed = false;

for (const file of files) {
	const match = file.match(/^(\d+)/);
	if (!match) continue;
	const prefix = match[1];
	if (seen.has(prefix)) {
		console.error(
			`❌ Duplicate migration prefix ${prefix}: "${seen.get(prefix)}" and "${file}"`,
		);
		failed = true;
	} else {
		seen.set(prefix, file);
	}
}

if (failed) {
	process.exit(1);
} else {
	console.log(
		`✅ ${files.length} migration files checked — no duplicate prefixes.`,
	);
}
