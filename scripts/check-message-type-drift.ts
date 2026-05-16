/**
 * P1017 AC-24: Detect drift between the DB CHECK constraint on
 * message_ledger.message_type and the TypeScript MessageType enum.
 *
 * Exits 0 when in sync, 1 with a diff when out of sync.
 * Run in CI after any migration that touches message_type.
 */

import { query } from "../src/infra/postgres/pool.ts";
import { MESSAGE_TYPES } from "../src/infra/messaging/types.ts";

async function main(): Promise<void> {
	// Extract values from pg_constraint consrc for message_ledger_type_check.
	// The consrc looks like: ((message_type = ANY (ARRAY['text','task',...]))
	const result = await query<{ consrc: string }>(`
    SELECT pg_get_constraintdef(oid) AS consrc
    FROM pg_constraint
    WHERE conrelid = 'roadmap.message_ledger'::regclass
      AND conname = 'message_ledger_type_check'
  `);

	if (result.rows.length === 0) {
		console.error(
			"ERROR: constraint message_ledger_type_check not found on roadmap.message_ledger",
		);
		process.exit(1);
	}

	const consrc = result.rows[0].consrc;
	// Extract quoted strings from ARRAY['a','b',...] pattern.
	const dbValues = Array.from(consrc.matchAll(/'([^']+)'/g), (m) => m[1]).sort();

	const tsValues = [...MESSAGE_TYPES].sort();

	const onlyInDb = dbValues.filter((v) => !tsValues.includes(v as never));
	const onlyInTs = tsValues.filter((v) => !dbValues.includes(v));

	if (onlyInDb.length === 0 && onlyInTs.length === 0) {
		console.log(
			`OK: message_type enum in sync (${dbValues.length} values): ${dbValues.join(", ")}`,
		);
		process.exit(0);
	}

	console.error("DRIFT DETECTED between DB constraint and TypeScript MessageType:");
	if (onlyInDb.length > 0)
		console.error(`  In DB only:  ${onlyInDb.join(", ")}`);
	if (onlyInTs.length > 0)
		console.error(`  In TS only:  ${onlyInTs.join(", ")}`);
	console.error(
		"\nFix: update src/infra/messaging/types.ts MESSAGE_TYPES to match the DB constraint.",
	);
	process.exit(1);
}

main().catch((err) => {
	console.error("check-message-type-drift: unexpected error:", err);
	process.exit(1);
});
