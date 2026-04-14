/**
 * AgentHive — State Machine Bootstrap
 *
 * Dispatches agents to key pipeline positions by:
 *   1. Queuing REVIEW/new proposals into transition_queue for gate review (D2)
 *   2. Queuing DRAFT/new proposals into transition_queue for architecture gate (D1)
 *   3. Sending A2A messages to worktree agents to pick up DEVELOP proposals
 *   4. Printing a summary of pipeline health
 *
 * Usage:
 *   node --import jiti/register scripts/bootstrap-state-machine.ts [--dry-run] [--stage REVIEW|DRAFT|DEVELOP|all]
 */

import { query } from "../src/infra/postgres/pool.ts";

const DRY_RUN = process.argv.includes("--dry-run");
const STAGE_ARG = (() => {
	const idx = process.argv.indexOf("--stage");
	return idx !== -1 ? process.argv[idx + 1]?.toUpperCase() : "all";
})() ?? "all";

const log = (...args: unknown[]) => console.log("[Bootstrap]", new Date().toISOString(), ...args);
const warn = (...args: unknown[]) => console.warn("[Bootstrap]", new Date().toISOString(), ...args);

// ─── Pipeline summary ─────────────────────────────────────────────────────────

async function printPipelineSummary() {
	const { rows: stateRows } = await query<{ status: string; maturity: string; count: string }>(
		`SELECT status, maturity, COUNT(*)::text AS count
		 FROM roadmap_proposal.proposal
		 GROUP BY status, maturity
		 ORDER BY status, maturity`,
		[],
	);

	const { rows: queueRows } = await query<{ status: string; count: string }>(
		`SELECT status, COUNT(*)::text AS count
		 FROM roadmap.transition_queue
		 GROUP BY status
		 ORDER BY status`,
		[],
	);

	console.log("\n═══════════════════════════════════════════════════════════");
	console.log("  AgentHive Pipeline Status");
	console.log("═══════════════════════════════════════════════════════════");
	console.log("\n  Proposals by state/maturity:");
	for (const r of stateRows) {
		console.log(`    ${r.status.padEnd(12)} / ${r.maturity.padEnd(10)} → ${r.count}`);
	}
	console.log("\n  Transition queue:");
	for (const r of queueRows) {
		console.log(`    ${r.status.padEnd(12)} → ${r.count}`);
	}
	console.log("═══════════════════════════════════════════════════════════\n");
}

// ─── Queue proposals into transition_queue ────────────────────────────────────

interface ProposalRow {
	id: number;
	display_id: string;
	title: string;
	status: string;
	maturity: string;
}

async function enqueueForGate(
	proposal: ProposalRow,
	gate: string,
	toStage: string,
	agent: string,
): Promise<boolean> {
	// Get the gate task prompt
	const gateNum = parseInt(gate.replace("D", ""), 10);
	const { rows: tmpl } = await query<{ task_prompt: string }>(
		`SELECT task_prompt FROM roadmap.gate_task_templates WHERE gate_number = $1 AND is_active = true LIMIT 1`,
		[gateNum],
	);

	const taskPrompt = tmpl[0]?.task_prompt ??
		`Process gate ${gate} for proposal ${proposal.display_id}: "${proposal.title}"`;

	if (DRY_RUN) {
		log(`[DRY-RUN] Would enqueue P${proposal.id} (${proposal.display_id}) gate=${gate} → ${toStage} agent=${agent}`);
		return true;
	}

	try {
		await query(
			`INSERT INTO roadmap.transition_queue (
				proposal_id, from_stage, to_stage, triggered_by,
				gate, status, metadata
			) VALUES ($1, $2, $3, 'bootstrap', $4::text, 'pending',
				jsonb_build_object(
					'task', $5::text,
					'gate', $4::text,
					'agent', $6::text,
					'proposal_display_id', $7::text,
					'spawn', jsonb_build_object('worktree', $6::text, 'timeoutMs', 600000)
				)
			)
			ON CONFLICT (proposal_id, gate)
			WHERE gate IS NOT NULL AND status IN ('pending', 'processing')
			DO NOTHING`,
			[proposal.id, proposal.status, toStage, gate, taskPrompt, agent, proposal.display_id],
		);
		log(`Enqueued P${proposal.id} (${proposal.display_id}) gate=${gate} → ${toStage} agent=${agent}`);
		return true;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		warn(`Failed to enqueue P${proposal.id}: ${msg}`);
		return false;
	}
}

// ─── Send A2A message ─────────────────────────────────────────────────────────

async function sendA2AMessage(
	fromAgent: string,
	toAgent: string,
	content: string,
	proposalId?: number,
): Promise<void> {
	if (DRY_RUN) {
		log(`[DRY-RUN] Would send A2A: ${fromAgent} → ${toAgent}: ${content.slice(0, 80)}...`);
		return;
	}

	await query(
		`INSERT INTO roadmap.message_ledger (from_agent, to_agent, message_content, message_type, proposal_id)
		 VALUES ($1, $2, $3, 'task', $4)`,
		[fromAgent, toAgent, content, proposalId ?? null],
	);
	log(`Sent A2A ${fromAgent} → ${toAgent} (proposal_id=${proposalId ?? "none"})`);
}

// ─── Bootstrap stages ─────────────────────────────────────────────────────────

/** Queue REVIEW/new proposals for gate D2 (feasibility gate). */
async function bootstrapReviewStage() {
	const { rows } = await query<ProposalRow>(
		`SELECT p.id, p.display_id, p.title, p.status, p.maturity
		 FROM roadmap_proposal.proposal p
		 WHERE LOWER(p.status) = 'review' AND p.maturity IN ('new', 'active')
		   AND NOT EXISTS (
		     SELECT 1 FROM roadmap.transition_queue tq
		     WHERE tq.proposal_id = p.id
		       AND tq.gate = 'D2'
		       AND tq.status IN ('pending', 'processing')
		   )
		 ORDER BY p.id`,
		[],
	);

	if (rows.length === 0) {
		log("REVIEW stage: no proposals pending gate D2.");
		return;
	}

	log(`REVIEW stage: ${rows.length} proposals to queue for D2 gate...`);
	let count = 0;
	for (const p of rows) {
		const ok = await enqueueForGate(p, "D2", "Develop", "claude-one");
		if (ok) count++;
	}
	log(`REVIEW stage: queued ${count}/${rows.length} proposals.`);
}

/** Queue DRAFT/new proposals for gate D1 (architecture gate). */
async function bootstrapDraftStage() {
	const { rows } = await query<ProposalRow>(
		`SELECT p.id, p.display_id, p.title, p.status, p.maturity
		 FROM roadmap_proposal.proposal p
		 WHERE LOWER(p.status) = 'draft' AND p.maturity IN ('new', 'active')
		   AND NOT EXISTS (
		     SELECT 1 FROM roadmap.transition_queue tq
		     WHERE tq.proposal_id = p.id
		       AND tq.gate = 'D1'
		       AND tq.status IN ('pending', 'processing')
		   )
		 ORDER BY p.id
		 LIMIT 10`,
		[],
	);

	if (rows.length === 0) {
		log("DRAFT stage: no proposals pending gate D1.");
		return;
	}

	log(`DRAFT stage: ${rows.length} proposals to queue for D1 gate (capped at 10)...`);
	let count = 0;
	for (const p of rows) {
		const ok = await enqueueForGate(p, "D1", "Review", "claude-one");
		if (ok) count++;
	}
	log(`DRAFT stage: queued ${count}/${rows.length} proposals.`);
}

/** Send A2A dispatch messages to worktree agents for DEVELOP proposals. */
async function bootstrapDevelopStage() {
	const { rows } = await query<ProposalRow>(
		`SELECT id, display_id, title, status, maturity
		 FROM roadmap_proposal.proposal
		 WHERE LOWER(status) = 'develop' AND maturity IN ('new', 'active')
		 ORDER BY id`,
		[],
	);

	if (rows.length === 0) {
		log("DEVELOP stage: no proposals in new/active state.");
		return;
	}

	log(`DEVELOP stage: ${rows.length} proposals to dispatch to developer agents...`);

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

// ─── Notify gate pipeline ─────────────────────────────────────────────────────

async function notifyGatePipeline() {
	if (DRY_RUN) {
		log("[DRY-RUN] Would notify transition_queued channel.");
		return;
	}
	await query(
		`SELECT pg_notify('transition_queued', '{"source":"bootstrap","ts":"' || to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '"}')`,
		[],
	);
	log("Notified transition_queued channel — gate pipeline will wake up.");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	log(`Starting state machine bootstrap (stage=${STAGE_ARG}, dry-run=${DRY_RUN})`);

	await printPipelineSummary();

	const runAll = STAGE_ARG === "ALL";

	if (runAll || STAGE_ARG === "REVIEW") {
		await bootstrapReviewStage();
	}
	if (runAll || STAGE_ARG === "DRAFT") {
		await bootstrapDraftStage();
	}
	if (runAll || STAGE_ARG === "DEVELOP") {
		await bootstrapDevelopStage();
	}

	if (!DRY_RUN) {
		await notifyGatePipeline();
	}

	log("Bootstrap complete.");
	await printPipelineSummary();
	process.exit(0);
}

main().catch((err) => {
	console.error("[Bootstrap] Fatal:", err);
	process.exit(1);
});
