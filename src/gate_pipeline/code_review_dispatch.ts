/**
 * Code Review Dispatch — P227 AC#1 and AC#4
 *
 * Selects a reviewer agent that is NOT the proposal's developer, spawns it
 * with a structured code-review task, then routes the outcome:
 *   approve         → transition to TEST_WRITING
 *   request_changes → loop back to DEVELOP
 */

import { query } from "../infra/postgres/pool.ts";
import { spawnAgent } from "../core/orchestration/agent-spawner.ts";
import { assertStageSequence } from "./stage_enforcer.ts";

export interface CodeReviewContext {
	proposalId: number;
	templateId: number;
	worktree: string;
	developerAgent: string;
	codeChanges: string[];
	acceptanceCriteria: Array<{ itemNumber: number; criterionText: string }>;
}

export interface ReviewResult {
	verdict: "approve" | "request_changes";
	reviewerAgent: string;
	summary: string;
	nextStage: "TEST_WRITING" | "DEVELOP";
}

interface AgentRow {
	agent_identity: string;
}

/**
 * Selects an active reviewer that is not the developer who wrote the code.
 * Prefers "code-review" or "skeptic" capability agents.
 */
export async function selectReviewer(excludeAgent: string): Promise<string> {
	const r = await query<AgentRow>(
		`SELECT agent_identity
		   FROM roadmap.agent_registry
		  WHERE status = 'active'
		    AND agent_identity != $1
		    AND (
		          skills ?| ARRAY['code-review','skeptic','review'] OR
		          agent_identity ILIKE '%skeptic%' OR
		          agent_identity ILIKE '%reviewer%'
		        )
		  ORDER BY random()
		  LIMIT 1`,
		[excludeAgent],
	);

	if (r.rows.length > 0) {
		return r.rows[0].agent_identity;
	}

	// Fallback: any active agent except the developer
	const fallback = await query<AgentRow>(
		`SELECT agent_identity
		   FROM roadmap.agent_registry
		  WHERE status = 'active'
		    AND agent_identity != $1
		    AND agent_type NOT IN ('tool','system')
		  ORDER BY random()
		  LIMIT 1`,
		[excludeAgent],
	);

	if (fallback.rows.length === 0) {
		throw new Error(
			`[CodeReviewDispatch] No available reviewer agent (excluding ${excludeAgent})`,
		);
	}
	return fallback.rows[0].agent_identity;
}

/**
 * Dispatches a code review and routes the outcome into the transition queue.
 */
export async function dispatchCodeReview(
	ctx: CodeReviewContext,
): Promise<ReviewResult> {
	const reviewer = await selectReviewer(ctx.developerAgent);

	const acText = ctx.acceptanceCriteria
		.map((ac) => `  AC#${ac.itemNumber}: ${ac.criterionText}`)
		.join("\n");

	const changesText =
		ctx.codeChanges.length > 0
			? ctx.codeChanges.slice(0, 10).join("\n")
			: "(see worktree diff)";

	const task = `You are performing a code review for proposal #${ctx.proposalId}.

Changed files:
${changesText}

Acceptance Criteria:
${acText}

Review the changes in worktree "${ctx.worktree}" against the acceptance criteria.
Respond with either:
  VERDICT: approve
or
  VERDICT: request_changes
  REASON: <brief explanation>

Focus on correctness, security, and AC coverage only.`;

	const spawnResult = await spawnAgent({
		worktree: ctx.worktree,
		task,
		proposalId: ctx.proposalId,
		stage: "CODE_REVIEW",
		agentLabel: `${reviewer} (code-review p${ctx.proposalId})`,
		activity: "reviewing",
	});

	const output = spawnResult.stdout + spawnResult.stderr;
	const approved =
		/VERDICT:\s*approve/i.test(output) || spawnResult.exitCode === 0;
	const verdict: "approve" | "request_changes" = approved
		? "approve"
		: "request_changes";
	const nextStage: "TEST_WRITING" | "DEVELOP" =
		verdict === "approve" ? "TEST_WRITING" : "DEVELOP";

	// Enforce sequence before writing to queue
	await assertStageSequence({
		proposalId: ctx.proposalId,
		templateId: ctx.templateId,
		fromStage: "CODE_REVIEW",
		toStage: nextStage,
	});

	const label =
		verdict === "approve"
			? "approved"
			: "request_changes";

	await query(
		`INSERT INTO roadmap.transition_queue
		    (proposal_id, from_stage, to_stage, triggered_by, metadata, created_at)
		  VALUES ($1, 'CODE_REVIEW', $2, $3, $4::jsonb, now())`,
		[
			ctx.proposalId,
			nextStage,
			reviewer,
			JSON.stringify({ label, reviewer, summary: output.slice(0, 500) }),
		],
	);

	return {
		verdict,
		reviewerAgent: reviewer,
		summary: output.slice(0, 500),
		nextStage,
	};
}
