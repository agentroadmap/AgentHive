/**
 * AgentHive — State Machine Bootstrap
 *
 * Canonical startup helper for the proposal machines.
 *
 * It does not replace the gate worker or orchestrator. It verifies the live
 * proposal lanes and sends A2A nudges so operators can see what each workflow
 * machine is about to do:
 *   - New/active proposals are enhancement lanes
 *   - Mature proposals are gate lanes
 *   - Complete proposals are terminal and excluded
 *
 * Usage:
 *   node --import jiti/register scripts/bootstrap-state-machine.ts [--dry-run] [--stage DEVELOP|all]
 */

import { query } from "../src/infra/postgres/pool.ts";

const DRY_RUN = process.argv.includes("--dry-run");
const STAGE_ARG =
	(() => {
		const idx = process.argv.indexOf("--stage");
		return idx !== -1 ? process.argv[idx + 1]?.toUpperCase() : "all";
	})() ?? "all";

const log = (...args: unknown[]) =>
	console.log("[Bootstrap]", new Date().toISOString(), ...args);

// ─── Pipeline summary ─────────────────────────────────────────────────────────

async function printPipelineSummary() {
	const { rows: stateRows } = await query<{
		status: string;
		maturity: string;
		count: string;
	}>(
		`SELECT status, maturity, COUNT(*)::text AS count
		 FROM roadmap_proposal.proposal
		 GROUP BY status, maturity
		 ORDER BY status, maturity`,
		[],
	);

	const { rows: gateRows } = await query<{ status: string; count: string }>(
		`SELECT status, COUNT(*)::text AS count
		 FROM roadmap_proposal.proposal
		 WHERE maturity = 'mature'
		   AND status IN ('DRAFT', 'REVIEW', 'DEVELOP', 'MERGE')
		 GROUP BY status
		 ORDER BY status`,
		[],
	);

	console.log("\n═══════════════════════════════════════════════════════════");
	console.log("  AgentHive Pipeline Status");
	console.log("═══════════════════════════════════════════════════════════");
	console.log("  Live lanes:");
	console.log("    New / Active   → enhancement and development");
	console.log("    Mature         → gating and review");
	console.log("    Complete       → terminal");
	console.log("\n  Proposals by state/maturity:");
	for (const r of stateRows) {
		console.log(
			`    ${r.status.padEnd(12)} / ${r.maturity.padEnd(10)} → ${r.count}`,
		);
	}
	console.log("\n  Gate-ready proposals (mature, non-terminal):");
	for (const r of gateRows) {
		console.log(`    ${r.status.padEnd(12)} → ${r.count}`);
	}
	console.log("═══════════════════════════════════════════════════════════\n");
}

// ─── Send A2A message ─────────────────────────────────────────────────────────

async function sendA2AMessage(
	fromAgent: string,
	toAgent: string,
	content: string,
	proposalId?: number,
): Promise<void> {
	if (DRY_RUN) {
		log(
			`[DRY-RUN] Would send A2A: ${fromAgent} → ${toAgent}: ${content.slice(0, 80)}...`,
		);
		return;
	}

	await query(
		`INSERT INTO roadmap.message_ledger (from_agent, to_agent, message_content, message_type, proposal_id)
		 VALUES ($1, $2, $3, 'task', $4)`,
		[fromAgent, toAgent, content, proposalId ?? null],
	);
	log(
		`Sent A2A ${fromAgent} → ${toAgent} (proposal_id=${proposalId ?? "none"})`,
	);
}

/** Send A2A dispatch messages to worktree agents for DEVELOP proposals. */
async function bootstrapDevelopStage() {
	type ProposalRow = {
		id: number;
		display_id: string;
		title: string;
		status: string;
		maturity: string;
	};

	const { rows } = await query<ProposalRow>(
		`SELECT id, display_id, title, status, maturity
		 FROM roadmap_proposal.proposal
	 WHERE status = 'DEVELOP' AND maturity IN ('new', 'active')
		 ORDER BY id`,
		[],
	);

	if (rows.length === 0) {
		log("DEVELOP stage: no proposals in new/active state.");
		return;
	}

	log(
		`DEVELOP stage: ${rows.length} proposals to dispatch to developer agents...`,
	);

	for (const p of rows) {
		// Large pillar proposals → claude-one (orchestrator)
		// Specific fix proposals → appropriate specialist
		const isLargePillar = p.id <= 68;
		const agent = isLargePillar ? "claude/one" : "claude/andy";

		await sendA2AMessage(
			"system",
			agent,
			`DEVELOP assignment: Please claim and work on proposal ${p.display_id}: "${p.title}" (status=DEVELOP, maturity=${p.maturity}). ` +
				`Read the proposal via MCP (prop_get id=${p.id}), claim a lease, implement the required work, ` +
				`and mark as mature when done. The gate pipeline will then automatically handle promotion.`,
			p.id,
		);
	}
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	log(
		`Starting state machine bootstrap (stage=${STAGE_ARG}, dry-run=${DRY_RUN})`,
	);
	log("This helper only reports and nudges. The workflow workers and orchestrator must already be running.");

	await printPipelineSummary();

	const runAll = STAGE_ARG === "ALL";
	if (runAll || STAGE_ARG === "DEVELOP") {
		await bootstrapDevelopStage();
	}

	if (STAGE_ARG === "DRAFT" || STAGE_ARG === "REVIEW") {
		log(
			"Implicit gating is mature-driven; no transition_queue rows are created by bootstrap.",
		);
	}

	log("Bootstrap complete.");
	await printPipelineSummary();
	process.exit(0);
}

main().catch((err) => {
	console.error("[Bootstrap] Fatal:", err);
	process.exit(1);
});
