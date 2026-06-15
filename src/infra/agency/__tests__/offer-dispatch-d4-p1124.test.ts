/**
 * P1124 AC-6..9: D4 validator dispatch integration regression tests.
 *
 * Exercises the REAL handleOfferDispatch() with injected spawn/exec deps and
 * REAL proposals in the live DB (validateProposal reads through the pg pool,
 * which is not injectable — by design, the validator is a library).
 *
 * Env-gated: AGENTHIVE_LIVE_DB_TESTS=1 AGENTHIVE_ALLOW_LIVE_DB=1.
 * All created rows are torn down (proposal delete cascades AC + D4 log rows).
 *
 * Asserted properties:
 * - AC-6: validator runs ONLY for role=gate-reviewer AND proposal.status=MERGE
 * - AC-7: advance → spawn skipped (zero-token), offer completed 'delivered'
 * - AC-8: hold → spawn skipped, offer completed 'failed', D4 hold row written
 * - AC-9: inconclusive → falls through to the normal spawn path, no D4 row
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { query } from "../../postgres/pool.ts";
import { handleOfferDispatch } from "../offer-dispatch-handler.ts";
import type { SpawnResult } from "../../../core/orchestration/agent-spawner.ts";

const skipIfNoLiveDb = process.env.AGENTHIVE_LIVE_DB_TESTS ? test : test.skip;

const TEST_AGENCY = "test-d4-agency";

interface RecordedCall {
	sql: string;
	params: unknown[];
}

/**
 * exec fake: lease/offer functions are intercepted and recorded; plain
 * SELECTs delegate to the real pool (the pre-spawn gates read real tables and
 * get empty rows / defaults for the fake agency); any other write is
 * swallowed so test runs never mutate live workforce tables.
 */
function makeFakeExec(calls: RecordedCall[]) {
	return async (sql: string, params: unknown[] = []) => {
		calls.push({ sql, params });
		if (/fn_complete_work_offer|fn_return_work_offer|fn_renew_lease/.test(sql)) {
			return { rows: [{}] };
		}
		if (/^\s*select/i.test(sql)) {
			return query(sql, params);
		}
		return { rows: [] };
	};
}

function makeSpawnSpy(spawnCalls: unknown[]) {
	return async (req: unknown): Promise<SpawnResult> => {
		spawnCalls.push(req);
		return {
			agentRunId: "test-run-p1124",
			worktree: "/tmp",
			exitCode: 0,
			stdout: "spawned: did the gate review",
			stderr: "",
			durationMs: 5,
		};
	};
}

async function until(cond: () => boolean, label: string, ms = 8_000) {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > ms) throw new Error(`timeout waiting for: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

let nextDispatchId = 990_001;

async function createProposal(
	suffix: string,
	status: string,
	criteria: string[],
): Promise<number> {
	const created = await query(
		`INSERT INTO roadmap_proposal.proposal
		 (display_id, type, status, title, project_id, audit)
		 VALUES ($1, 'feature', $2, 'p1124 dispatch test', 1, '{}'::jsonb)
		 RETURNING id`,
		[`test-p1124-dispatch-${suffix}-${process.pid}`, status],
	);
	const id = created.rows[0].id;
	for (let i = 0; i < criteria.length; i++) {
		await query(
			`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
			 (proposal_id, item_number, criterion_text, status, project_id)
			 VALUES ($1, $2, $3, 'pending', 1)`,
			[id, i + 1, criteria[i]],
		);
	}
	return id;
}

function makePayload(proposalId: number, role: string) {
	return {
		payload: {
			offer_id: `test-offer-${proposalId}`,
			role,
			required_capabilities: [],
			route_hint: "claude",
			dispatch_id: nextDispatchId++,
			claim_token: "00000000-0000-4000-8000-00000000d4d4",
			proposal_id: Number(proposalId),
			lease_ttl_seconds: 60,
			worktree_hint: "/tmp",
		},
	} as any;
}

async function d4Rows(proposalId: number) {
	const rows = await query(
		`SELECT decision FROM roadmap_proposal.gate_decision_log
		 WHERE proposal_id = $1 AND gate = 'D4' AND decided_by = 'system/d4-validator'`,
		[proposalId],
	);
	return rows.rows;
}

function completionStatus(calls: RecordedCall[]): string | undefined {
	const call = calls.find((c) => c.sql.includes("fn_complete_work_offer"));
	return call ? (call.params[3] as string) : undefined;
}

describe("P1124 D4 dispatch integration (live-DB)", () => {
	skipIfNoLiveDb(
		"AC-6+7: gate-reviewer + MERGE + all-pass → no spawn, delivered, D4 advance row",
		async () => {
			const proposalId = await createProposal("advance", "MERGE", [
				"Check. Verification: psql SELECT 1",
			]);
			const calls: RecordedCall[] = [];
			const spawnCalls: unknown[] = [];
			try {
				await handleOfferDispatch(TEST_AGENCY, makePayload(proposalId, "gate-reviewer"), {
					exec: makeFakeExec(calls),
					spawn: makeSpawnSpy(spawnCalls) as any,
					resolveWorktree: () => "/tmp",
					sendUplink: (async () => {}) as any,
					logger: { log() {}, warn() {}, error() {} },
				});
				await until(
					() => completionStatus(calls) !== undefined,
					"offer completion",
				);
				assert.equal(spawnCalls.length, 0, "spawn must be skipped on advance");
				assert.equal(completionStatus(calls), "delivered");
				const logs = await d4Rows(proposalId);
				assert.equal(logs.length, 1);
				assert.equal(logs[0].decision, "advance");
			} finally {
				await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [proposalId]);
			}
		},
	);

	skipIfNoLiveDb(
		"AC-8: gate-reviewer + MERGE + failing AC → no spawn, failed, D4 hold row",
		async () => {
			const proposalId = await createProposal("hold", "MERGE", [
				"Check. Verification: psql SELECT * FROM nonexistent_table_p1124_dispatch",
			]);
			const calls: RecordedCall[] = [];
			const spawnCalls: unknown[] = [];
			try {
				await handleOfferDispatch(TEST_AGENCY, makePayload(proposalId, "gate-reviewer"), {
					exec: makeFakeExec(calls),
					spawn: makeSpawnSpy(spawnCalls) as any,
					resolveWorktree: () => "/tmp",
					sendUplink: (async () => {}) as any,
					logger: { log() {}, warn() {}, error() {} },
				});
				await until(() => completionStatus(calls) !== undefined, "offer completion");
				assert.equal(spawnCalls.length, 0, "spawn must be skipped on hold");
				assert.equal(completionStatus(calls), "failed");
				const logs = await d4Rows(proposalId);
				assert.equal(logs.length, 1);
				assert.equal(logs[0].decision, "hold");
			} finally {
				await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [proposalId]);
			}
		},
	);

	skipIfNoLiveDb(
		"AC-9: gate-reviewer + MERGE + unverifiable AC → falls through to spawn, no D4 row",
		async () => {
			const proposalId = await createProposal("inconclusive", "MERGE", [
				"Prose criterion with no verification line at all",
			]);
			const calls: RecordedCall[] = [];
			const spawnCalls: unknown[] = [];
			try {
				await handleOfferDispatch(TEST_AGENCY, makePayload(proposalId, "gate-reviewer"), {
					exec: makeFakeExec(calls),
					spawn: makeSpawnSpy(spawnCalls) as any,
					resolveWorktree: () => "/tmp",
					sendUplink: (async () => {}) as any,
					logger: { log() {}, warn() {}, error() {} },
				});
				await until(() => spawnCalls.length > 0, "fall-through spawn");
				assert.equal(spawnCalls.length, 1, "spawn must run on inconclusive");
				const logs = await d4Rows(proposalId);
				assert.equal(logs.length, 0, "inconclusive must not write a D4 decision");
			} finally {
				await until(() => completionStatus(calls) !== undefined, "offer completion");
				await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [proposalId]);
			}
		},
	);

	skipIfNoLiveDb(
		"AC-6 negative: developer role → validator skipped, spawn runs, no D4 row",
		async () => {
			// ACs would all PASS if the validator ran — proving it didn't.
			const proposalId = await createProposal("devrole", "MERGE", [
				"Check. Verification: psql SELECT 1",
			]);
			const calls: RecordedCall[] = [];
			const spawnCalls: unknown[] = [];
			try {
				await handleOfferDispatch(TEST_AGENCY, makePayload(proposalId, "developer"), {
					exec: makeFakeExec(calls),
					spawn: makeSpawnSpy(spawnCalls) as any,
					resolveWorktree: () => "/tmp",
					sendUplink: (async () => {}) as any,
					logger: { log() {}, warn() {}, error() {} },
				});
				await until(() => spawnCalls.length > 0, "developer spawn");
				assert.equal(spawnCalls.length, 1, "developer offers must spawn normally");
				const logs = await d4Rows(proposalId);
				assert.equal(logs.length, 0, "validator must not run for non-gate roles");
			} finally {
				await until(() => completionStatus(calls) !== undefined, "offer completion");
				await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [proposalId]);
			}
		},
	);

	skipIfNoLiveDb(
		"AC-6 negative: gate-reviewer on DEVELOP proposal → validator skipped",
		async () => {
			const proposalId = await createProposal("devstage", "DEVELOP", [
				"Check. Verification: psql SELECT 1",
			]);
			const calls: RecordedCall[] = [];
			const spawnCalls: unknown[] = [];
			try {
				await handleOfferDispatch(TEST_AGENCY, makePayload(proposalId, "gate-reviewer"), {
					exec: makeFakeExec(calls),
					spawn: makeSpawnSpy(spawnCalls) as any,
					resolveWorktree: () => "/tmp",
					sendUplink: (async () => {}) as any,
					logger: { log() {}, warn() {}, error() {} },
				});
				await until(() => spawnCalls.length > 0, "non-MERGE spawn");
				assert.equal(spawnCalls.length, 1, "non-MERGE offers must spawn normally");
				const logs = await d4Rows(proposalId);
				assert.equal(logs.length, 0, "validator must not run outside MERGE");
			} finally {
				await until(() => completionStatus(calls) !== undefined, "offer completion");
				await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [proposalId]);
			}
		},
	);
});
