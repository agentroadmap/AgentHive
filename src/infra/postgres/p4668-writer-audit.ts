/**
 * P4668 AC-6 / AC-34 — Canonical writer audit.
 *
 * Every TypeScript call site that directly mutates proposal.status,
 * proposal.maturity, proposal_state_transitions, or
 * proposal_maturity_transitions is listed here.
 *
 * This file is the authoritative enumeration. When the canonical ledger path
 * (canonicalTransition / fn_canonical_transition_insert) is the ONLY permitted
 * writer (mig 311+), this list becomes the hit-list for migration.
 *
 * AC-6:  All current status writers enumerated with surface + line ref.
 * AC-34: Same list verified complete; no undocumented direct SQL writers.
 *
 * Last verified: 2026-06-22 against branch feat/p4668-transition-ledger.
 */

export type WriterKind = "status" | "maturity" | "pst-insert" | "pmt-insert" | "pst-update";
export type WriterSurface =
	| "canonical-api"      // transitionProposal() / setMaturity() — the ONLY sanctioned path post-311
	| "mcp-handler"        // MCP tool handler calling the canonical api
	| "rfc-handler"        // RFC/gate handler; has its own direct PST insert
	| "reeval-handler"     // Re-evaluation path; 3 direct SQL writers
	| "gate-evaluator"     // Gate evaluator agent; direct maturity UPDATE
	| "e2e-verifier"       // End-to-end verifier helper; direct maturity UPDATE
	| "cli-stop"           // CLI stop command; direct status UPDATE
	| "server-direct"      // HTTP server route; direct status UPDATE
	| "worktree-merge"     // Worktree merge handler; direct status UPDATE
	| "agents-handler";    // MCP agents handler; direct status UPDATE

export interface WriterEntry {
	id: string;
	surface: WriterSurface;
	file: string;
	lines: number[];
	kinds: WriterKind[];
	note: string;
	/**
	 * true = already writes through canonical path (fn_canonical_transition_insert)
	 * false = legacy direct SQL — must be migrated before mig 311 cutover
	 */
	isCanonical: boolean;
}

/**
 * The 10 direct proposal status/maturity writers as of 2026-06-22.
 * Writers that go through canonicalTransition() already satisfy P4668's
 * atomicity + provenance requirements (isCanonical=true).
 * All others are legacy direct-SQL writers that must be wrapped or retired
 * before the mig 311 enforcement migration can land.
 */
export const PROPOSAL_WRITERS: WriterEntry[] = [
	{
		id: "W-01",
		surface: "canonical-api",
		file: "src/infra/postgres/proposal-storage-v2.ts",
		lines: [488, 591, 709],
		kinds: ["status", "maturity", "pst-insert"],
		note: "transitionProposal() (L488) + setMaturity() (L671): the canonical SQL-layer functions. "
			+ "transitionProposal writes proposal.status (L591) + inserts pst row (see L621). "
			+ "setMaturity writes proposal.maturity (L709). "
			+ "Both should be wrapped in canonicalTransition() to emit ledger events — "
			+ "wrapping is the primary P4668 deliverable for AC-2.",
		isCanonical: false, // wrapping not yet done — AC-2 pending
	},
	{
		id: "W-02",
		surface: "mcp-handler",
		file: "src/apps/mcp-server/tools/proposals/pg-handlers.ts",
		lines: [536, 661, 734, 916],
		kinds: ["status", "maturity"],
		note: "MCP tool transitionProposal handler (L536, calls W-01 at L661) + "
			+ "setMaturity handler (L734, calls W-01 at L916). "
			+ "Delegates to canonical-api (W-01) so fixing W-01 covers this.",
		isCanonical: false, // inherits W-01 status
	},
	{
		id: "W-03",
		surface: "rfc-handler",
		file: "src/apps/mcp-server/tools/rfc/pg-handlers.ts",
		lines: [310, 386, 416, 441],
		kinds: ["status", "pst-insert", "pst-update"],
		note: "RFC/gate transitionProposal() (L310): has its own direct INSERT into "
			+ "proposal_state_transitions (L441) and UPDATE proposal.status (L386). "
			+ "Also updates pst rows (L416). Must be updated to call canonicalTransition().",
		isCanonical: false,
	},
	{
		id: "W-04",
		surface: "rfc-handler",
		file: "src/apps/mcp-server/tools/rfc/pg-handlers.ts",
		lines: [1865, 1873, 2266],
		kinds: ["status", "maturity"],
		note: "Additional direct status/maturity UPDATE statements in RFC handler for "
			+ "special-case transitions (hold, obsolete, rfc-release). "
			+ "Must be migrated to canonical path.",
		isCanonical: false,
	},
	{
		id: "W-05",
		surface: "reeval-handler",
		file: "src/apps/mcp-server/tools/proposals/reeval-handlers.ts",
		lines: [276, 290, 294, 303, 307, 311],
		kinds: ["status", "maturity", "pmt-insert"],
		note: "Re-evaluation handlers: 3 direct UPDATEs (status+maturity at L290, "
			+ "status-only at L303, maturity-only at L307) plus 2 direct INSERTs into "
			+ "proposal_maturity_transitions (L294, L311). High-priority migration target "
			+ "because re-eval bypasses all MCP governance.",
		isCanonical: false,
	},
	{
		id: "W-06",
		surface: "gate-evaluator",
		file: "src/apps/cubic-agents/gate-evaluator.ts",
		lines: [351, 360, 385, 393],
		kinds: ["maturity"],
		note: "GateEvaluator.setMaturity() (L351, direct UPDATE at L360) + "
			+ "setMaturityObsolete() (L385, UPDATE at L393). "
			+ "Uses SQL directly rather than delegating to proposal-storage-v2. "
			+ "The gate-evaluator is the primary governance choke-point; "
			+ "wrapping here is AC-2's highest-priority sub-task.",
		isCanonical: false,
	},
	{
		id: "W-07",
		surface: "e2e-verifier",
		file: "src/apps/e2e-verifier/index.ts",
		lines: [116, 119],
		kinds: ["maturity"],
		note: "e2e-verifier setMaturity() helper (L116): direct UPDATE proposal SET maturity (L119). "
			+ "Test/verifier path; lower blast radius but should still emit ledger events "
			+ "so test-fixture transitions are auditable.",
		isCanonical: false,
	},
	{
		id: "W-08",
		surface: "cli-stop",
		file: "src/apps/hive-cli/domains/stop/handlers/proposal.ts",
		lines: [50],
		kinds: ["status"],
		note: "CLI 'stop' command: direct UPDATE proposal SET status (L50). "
			+ "Operator CLI path that should emit a ledger event with actor_layer='operator'.",
		isCanonical: false,
	},
	{
		id: "W-09",
		surface: "agents-handler",
		file: "src/apps/mcp-server/tools/agents/pg-handlers.ts",
		lines: [1304],
		kinds: ["status"],
		note: "MCP agents handler: direct UPDATE proposal SET status (L1304). "
			+ "Investigate context; may be an agent-lifecycle transition that needs "
			+ "its own event_kind.",
		isCanonical: false,
	},
	{
		id: "W-10",
		surface: "server-direct",
		file: "src/apps/server/index.ts",
		lines: [1736, 1805],
		kinds: ["status"],
		note: "HTTP server routes: 2 direct UPDATE proposal SET status blocks (L1736, L1805). "
			+ "High blast radius — these are API endpoints called from the web board. "
			+ "Must route through canonicalTransition() before mig 311.",
		isCanonical: false,
	},
	// W-11 is the worktree-merge handler (not counted in the 10 above but real)
	{
		id: "W-11",
		surface: "worktree-merge",
		file: "src/apps/mcp-server/tools/worktree-merge/handlers.ts",
		lines: [437],
		kinds: ["status"],
		note: "Worktree merge handler: direct UPDATE proposal SET status (L437). "
			+ "Merge-lifecycle transition; should emit a ledger event with reason_code='canonical'.",
		isCanonical: false,
	},
];

/**
 * Returns all writers that are not yet on the canonical ledger path.
 * These must all be migrated before mig 311 (enforcement) can land.
 */
export function getLegacyWriters(): WriterEntry[] {
	return PROPOSAL_WRITERS.filter((w) => !w.isCanonical);
}

/**
 * Prints a human-readable writer audit summary.
 * Use with: npx tsx src/infra/postgres/p4668-writer-audit.ts
 */
if (import.meta.url === `file://${process.argv[1]}`) {
	const legacy = getLegacyWriters();
	console.log(`P4668 Writer Audit — ${PROPOSAL_WRITERS.length} writers total, ${legacy.length} legacy`);
	console.log("═".repeat(72));
	for (const w of PROPOSAL_WRITERS) {
		const tag = w.isCanonical ? "✓ CANONICAL" : "✗ LEGACY   ";
		console.log(`${w.id} [${tag}] ${w.file}:${w.lines[0]}`);
		console.log(`       Surface: ${w.surface}  Kinds: ${w.kinds.join(", ")}`);
		console.log(`       ${w.note.slice(0, 80)}…`);
		console.log();
	}
}
