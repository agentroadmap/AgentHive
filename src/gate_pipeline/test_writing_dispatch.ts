/**
 * Test Writing Dispatch — P227 AC#2 and AC#5
 *
 * Spawns a test-writing agent to produce acceptance-criteria test files for a
 * proposal. On completion, transitions the proposal to TEST_EXECUTION.
 */

import { query } from "../infra/postgres/pool.ts";
import { spawnAgent } from "../core/orchestration/agent-spawner.ts";
import { assertStageSequence } from "./stage_enforcer.ts";

export interface TestWritingContext {
	proposalId: number;
	templateId: number;
	worktree: string;
	acceptanceCriteria: Array<{
		itemNumber: number;
		criterionText: string;
		testRef?: string | null;
	}>;
}

export interface TestWritingResult {
	success: boolean;
	agentRunId: string;
	testsWritten: number;
	nextStage: "TEST_EXECUTION" | "DEVELOP";
}

/**
 * Dispatches a test-writing task and routes outcome to TEST_EXECUTION (on
 * success) or back to DEVELOP (on failure/timeout).
 */
export async function dispatchTestWriting(
	ctx: TestWritingContext,
): Promise<TestWritingResult> {
	const untested = ctx.acceptanceCriteria.filter((ac) => !ac.testRef);

	const acText = ctx.acceptanceCriteria
		.map(
			(ac) =>
				`  AC#${ac.itemNumber}: ${ac.criterionText}${ac.testRef ? ` [has test: ${ac.testRef}]` : " [NO TEST]"}`,
		)
		.join("\n");

	const task = `You are writing acceptance-criteria tests for proposal #${ctx.proposalId}.

Working directory: worktree "${ctx.worktree}"

Acceptance Criteria:
${acText}

For each AC item marked [NO TEST], create a Node.js test file under:
  tests/workflow/p${ctx.proposalId}-ac<N>.test.ts

Each test file must:
1. Import test utilities from node:test
2. Have at least one test case that verifies the AC criterion
3. Use describe/it blocks or assert.* directly

After writing tests, output a summary:
  TESTS_WRITTEN: <count>
  FILES: <comma-separated list of test file paths>

If you cannot write tests for a criterion, output:
  BLOCKED: AC#<N> <reason>`;

	const spawnResult = await spawnAgent({
		worktree: ctx.worktree,
		task,
		proposalId: ctx.proposalId,
		stage: "TEST_WRITING",
		agentLabel: `test-writer p${ctx.proposalId}`,
		activity: "writing tests",
	});

	const output = spawnResult.stdout + spawnResult.stderr;
	const success = spawnResult.exitCode === 0;

	const writtenMatch = output.match(/TESTS_WRITTEN:\s*(\d+)/i);
	const testsWritten = writtenMatch ? parseInt(writtenMatch[1], 10) : 0;

	const nextStage: "TEST_EXECUTION" | "DEVELOP" = success ? "TEST_EXECUTION" : "DEVELOP";

	await assertStageSequence({
		proposalId: ctx.proposalId,
		templateId: ctx.templateId,
		fromStage: "TEST_WRITING",
		toStage: nextStage,
	});

	const label = success ? "tests_written" : "tests_fail";

	await query(
		`INSERT INTO roadmap.transition_queue
		    (proposal_id, from_stage, to_stage, triggered_by, metadata, created_at)
		  VALUES ($1, 'TEST_WRITING', $2, 'tool/test-writing-dispatch', $3::jsonb, now())`,
		[
			ctx.proposalId,
			nextStage,
			JSON.stringify({
				label,
				agentRunId: spawnResult.agentRunId,
				testsWritten,
				untestedCount: untested.length,
				summary: output.slice(0, 500),
			}),
		],
	);

	return {
		success,
		agentRunId: spawnResult.agentRunId,
		testsWritten,
		nextStage,
	};
}
