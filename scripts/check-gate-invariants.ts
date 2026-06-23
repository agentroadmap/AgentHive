/**
 * P4663/AC-7: Gate invariant CI checker.
 *
 * Fetches pg_get_functiondef for fn_guard_gate_advance and verifies that every
 * constitutional marker (P_noBypass, P_govEdges, P_gov48h, P_govHuman,
 * P_termIndep, P_termAC, P_log) is present. Exits non-zero on any failure.
 *
 * Usage: node --import jiti/register scripts/check-gate-invariants.ts
 * Env:   DATABASE_URL (optional; defaults to postgresql://admin@127.0.0.1:5432/agenthive)
 */

import { Pool } from "pg";

const DB_URL =
	process.env.DATABASE_URL ?? "postgresql://admin@127.0.0.1:5432/agenthive";

interface Invariant {
	id: string;
	description: string;
	check: (def: string) => boolean;
}

const INVARIANTS: Invariant[] = [
	{
		id: "P_noBypass",
		description:
			"fn_guard_gate_advance must NOT have live code referencing app.gate_bypass",
		check: (def) => {
			// Strip single-line SQL comments before checking — comment mentions are docs, not code.
			const codeOnly = def.replace(/--[^\n]*/g, "");
			return !codeOnly.includes("gate_bypass");
		},
	},
	{
		id: "P_govEdges",
		description:
			"Gate key list must include DELIBERATION edges (DRAFT→DELIBERATION, DELIBERATION→REVIEW)",
		check: (def) => def.includes("DELIBERATION"),
	},
	{
		id: "P_gov48h",
		description: "48-hour deliberation interval check must be present",
		check: (def) => def.includes("48 hours") || def.includes("INTERVAL '48"),
	},
	{
		id: "P_govHuman",
		description:
			"Human-role decider check must reference agent_type and 'human'",
		check: (def) => def.includes("agent_type") && def.includes("human"),
	},
	{
		id: "P_termIndep",
		description:
			"Terminal independence check (decider != author) must be present",
		check: (def) =>
			def.includes("Terminal independence violation") ||
			(def.includes("v_author") && def.includes("v_decider")),
	},
	{
		id: "P_termAC",
		description:
			"Zero-AC guard and unwaived-AC check must be present for MERGE→COMPLETE",
		check: (def) =>
			(def.includes("v_ac_count") || def.includes("ac_count")) &&
			(def.includes("zero acceptance criteria") || def.includes("= 0")),
	},
	{
		id: "P_log",
		description: "gate_decision_log mandatory check must be present",
		check: (def) => def.includes("gate_decision_log"),
	},
	{
		id: "P_failClosed",
		description:
			"Fail-closed author resolution: RAISE when author cannot be resolved",
		check: (def) =>
			def.includes("cannot resolve proposal author") ||
			def.includes("fail-closed") ||
			def.includes("fail closed"),
	},
];

async function main(): Promise<void> {
	const pool = new Pool({ connectionString: DB_URL });

	try {
		const { rows } = await pool.query<{ def: string }>(
			`SELECT pg_get_functiondef('roadmap_proposal.fn_guard_gate_advance'::regproc) AS def`,
		);

		if (!rows[0]?.def) {
			console.error(
				"FAIL: fn_guard_gate_advance not found in roadmap_proposal schema",
			);
			process.exit(1);
		}

		const def = rows[0].def;
		let failures = 0;

		console.log("P4663 gate invariant check — fn_guard_gate_advance");
		console.log("=".repeat(60));

		for (const inv of INVARIANTS) {
			const pass = inv.check(def);
			const mark = pass ? "✓" : "✗";
			console.log(`${mark} ${inv.id}: ${inv.description}`);
			if (!pass) {
				failures++;
			}
		}

		console.log("=".repeat(60));
		if (failures > 0) {
			console.error(
				`\nFAIL: ${failures}/${INVARIANTS.length} invariants violated.`,
			);
			console.error("Migration 319-p4663 may not be applied or was reverted.");
			process.exit(1);
		} else {
			console.log(
				`\nPASS: ${INVARIANTS.length}/${INVARIANTS.length} invariants satisfied.`,
			);
		}
	} finally {
		await pool.end();
	}
}

main().catch((err) => {
	console.error("check-gate-invariants error:", err);
	process.exit(1);
});
