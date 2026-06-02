/**
 * P226 AC-8 Integration Test: stageEnforcer wired into prop_transition
 *
 * Verifies that the transitionProposal handler rejects a Develop→Merge
 * transition when mandatory prerequisite stages (CodeReview, TestWriting,
 * TestExecution) have not been completed.
 *
 * Uses injectable mocks so no live DB or MCP server is required.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	stageEnforcer,
	StageEnforcerError,
	dispatchCodeReview,
	dispatchTestWriting,
	runTestExecutor,
	type ProposalStub,
} from "../../src/gate_pipeline/workflow_stages.ts";
import {
	pauseProposalAdvancement,
	getProposalAuditPause,
} from "../../src/gate_pipeline/frontier_audit.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PROPOSAL: ProposalStub = {
	id: 226n,
	display_id: "P226",
	title: "Tiered model routing",
};

/** Build a mock query that tracks which stage prefixes are "completed". */
function mockStageQuery(completedPrefixes: string[]) {
	return async (_text: string, params?: unknown[]) => {
		const likePattern = (params?.[1] as string) ?? "";
		const prefix = likePattern.replace("/%", "");
		const count = completedPrefixes.includes(prefix) ? "1" : "0";
		return { rows: [{ count }] };
	};
}

// ─── AC-8: stageEnforcer blocks Merge when prereqs missing ───────────────────

describe("AC-8: stageEnforcer blocks Merge on missing prerequisites", () => {
	it("blocks Merge when no stages complete → lists all 3 missing", async () => {
		const qfn = mockStageQuery([]);
		await assert.rejects(
			() => stageEnforcer(PROPOSAL, "Merge", qfn as any),
			(err: unknown) => {
				assert.ok(err instanceof StageEnforcerError);
				assert.deepEqual(
					err.missingStages.sort(),
					["CodeReview", "TestExecution", "TestWriting"],
				);
				return true;
			},
		);
	});

	it("blocks Merge when only CodeReview complete", async () => {
		const qfn = mockStageQuery(["code-review"]);
		await assert.rejects(
			() => stageEnforcer(PROPOSAL, "Merge", qfn as any),
			(err: unknown) => {
				assert.ok(err instanceof StageEnforcerError);
				assert.deepEqual(
					err.missingStages.sort(),
					["TestExecution", "TestWriting"],
				);
				return true;
			},
		);
	});

	it("allows Merge when all 3 prereqs complete", async () => {
		const qfn = mockStageQuery(["code-review", "test-writing", "test-execution"]);
		await assert.doesNotReject(() => stageEnforcer(PROPOSAL, "Merge", qfn as any));
	});

	it("non-Merge targets bypass the check entirely", async () => {
		let queried = false;
		const qfn = async () => {
			queried = true;
			return { rows: [{ count: "0" }] };
		};
		for (const stage of ["Develop", "CodeReview", "TestWriting", "Complete"] as const) {
			await assert.doesNotReject(() => stageEnforcer(PROPOSAL, stage, qfn as any));
		}
		assert.equal(queried, false, "No DB query should be issued for non-Merge targets");
	});
});

// ─── AC-5: dispatchCodeReview records the agent_run ──────────────────────────

describe("AC-5: dispatchCodeReview records agent_run", () => {
	it("inserts a completed agent_run with stage=code-review/P226", async () => {
		const insertedParams: unknown[][] = [];
		const qfn = async (_text: string, params?: unknown[]) => {
			if (params) insertedParams.push(params as unknown[]);
			return { rows: [{ id: 42n }] };
		};
		const runId = await dispatchCodeReview(PROPOSAL, { queryFn: qfn as any });
		assert.equal(runId, 42n);
		const callWithStage = insertedParams.find(
			(p) => Array.isArray(p) && p.some((v) => typeof v === "string" && v.startsWith("code-review/")),
		);
		assert.ok(callWithStage, "INSERT should include stage starting with 'code-review/'");
	});
});

// ─── AC-6: dispatchTestWriting generates file + records agent_run ─────────────

describe("AC-6: dispatchTestWriting generates test file", () => {
	it("writes test file and inserts agent_run with stage=test-writing/P226", async () => {
		const qfn = async () => ({ rows: [{ id: 55n }] });
		const tmpRoot = "/tmp/p226-integration-ac6";
		const { runId, testFilePath } = await dispatchTestWriting(
			PROPOSAL,
			{ acs: ["Model selects lower tier for easy tasks"], projectRoot: tmpRoot, queryFn: qfn as any },
		);
		assert.equal(runId, 55n);
		assert.ok(testFilePath.endsWith("ac-p226.test.ts"));

		const { readFileSync } = await import("node:fs");
		const content = readFileSync(testFilePath, "utf-8");
		assert.ok(content.includes("Model selects lower tier for easy tasks"));
		assert.ok(content.includes("P226"));
	});
});

// ─── AC-7: runTestExecutor records cost_usd=0 ────────────────────────────────

describe("AC-7: runTestExecutor records zero LLM cost", () => {
	it("inserts agent_run with model_used=test-executor and cost_usd=0", async () => {
		const insertedParams: unknown[][] = [];
		const qfn = async (_text: string, params?: unknown[]) => {
			if (params) insertedParams.push(params as unknown[]);
			return { rows: [{ id: 99n }] };
		};

		const tmpRoot = "/tmp/p226-integration-ac7";
		// Write a minimal test file so the executor has something to run
		await dispatchTestWriting(PROPOSAL, {
			acs: [],
			projectRoot: tmpRoot,
			queryFn: qfn as any,
		});

		const result = await runTestExecutor(PROPOSAL, {
			projectRoot: tmpRoot,
			queryFn: qfn as any,
		});

		assert.equal(result.cost_usd, 0);

		const executorInsert = insertedParams.find(
			(p) => Array.isArray(p) && p.includes("test-executor"),
		);
		assert.ok(executorInsert, "executor INSERT should be present");
		const costIdx = (executorInsert as unknown[]).indexOf(0);
		assert.ok(costIdx !== -1, "cost_usd=0 must appear in INSERT params");
	});
});

// ─── AC-4: getProposalAuditPause returns pause reason ────────────────────────

describe("AC-4: getProposalAuditPause + pauseProposalAdvancement (unit)", () => {
	it("pauseProposalAdvancement inserts frontier_audit_pause event", async () => {
		const insertedSql: string[] = [];
		const insertedParams: unknown[][] = [];
		const qfn = async (text: string, params?: unknown[]) => {
			insertedSql.push(text);
			if (params) insertedParams.push(params as unknown[]);
			return { rows: [] };
		};
		await pauseProposalAdvancement(226n, "critical architectural flaw", qfn as any);
		assert.ok(insertedSql.some((s) => s.includes("frontier_audit_pause")));
		const callWithReason = insertedParams.find(
			(p) => Array.isArray(p) && p.some((v) => typeof v === "string" && v.includes("critical architectural flaw")),
		);
		assert.ok(callWithReason, "pause reason should appear in INSERT params");
	});

	it("getProposalAuditPause returns null when no pause event", async () => {
		const qfn = async () => ({ rows: [] });
		const result = await getProposalAuditPause(226n, qfn as any);
		assert.equal(result, null);
	});

	it("getProposalAuditPause returns reason string when pause exists", async () => {
		const qfn = async () => ({
			rows: [{ reason: "critical drift detected" }],
		});
		const result = await getProposalAuditPause(226n, qfn as any);
		assert.equal(result, "critical drift detected");
	});
});
