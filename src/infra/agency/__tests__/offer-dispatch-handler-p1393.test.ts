/**
 * P1393 AC-3: offer-dispatch-handler stamps squad_dispatch.metadata.failure_reason='rate_limited'
 * before fn_complete_work_offer when the dispatch failed. The actual filter on
 * (agent_runs.status='rate_limited') is enforced in the UPDATE's EXISTS subquery,
 * so for unit purposes we verify the SQL is issued with the correct shape and
 * placement (before fn_complete_work_offer, in failed branch only).
 *
 * Pure-mocked: no DB, no real spawn. Sibling to offer-dispatch-handler.test.ts
 * which has pre-existing breakage unrelated to P1393.
 */

import { describe, expect, it } from "vitest";
import {
	handleOfferDispatch,
	type SqlExec,
} from "../offer-dispatch-handler.ts";
import type { LiaisonMessage } from "../liaison-message-types.ts";
import type { SpawnResult } from "../../../core/orchestration/agent-spawner.ts";

function makeMessage(payload: Record<string, unknown>): LiaisonMessage {
	return {
		message_id: "00000000-0000-0000-0000-000000001393",
		agency_id: "claude/agency-bot",
		sequence: 1n,
		direction: "orchestrator->liaison",
		kind: "offer_dispatch",
		correlation_id: "00000000-0000-0000-0000-aaaaaaaa1393",
		payload,
		signed_at: new Date().toISOString(),
		signature: "test-sig",
	};
}

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

const allowCapacity = (async () => ({
	allowed: true,
	in_flight: 0,
	max_in_flight: 8,
	refuse_reason: null,
	throttle_until: null,
})) as never;

function recordingExec(): {
	calls: Array<{ sql: string; params: unknown[] }>;
	exec: SqlExec;
} {
	const calls: Array<{ sql: string; params: unknown[] }> = [];
	const exec: SqlExec = async (sql, params) => {
		calls.push({ sql, params: params ?? [] });
		return { rows: [] };
	};
	return { calls, exec };
}

describe("P1393 AC-3: rate_limited marker stamp before fn_complete_work_offer", () => {
	it("failed spawn → stamp SQL is issued BEFORE fn_complete_work_offer with (dispatchId, agencyId)", async () => {
		const { calls, exec } = recordingExec();

		const fakeSpawn = async (): Promise<SpawnResult> => {
			throw new Error("rate limit hit");
		};

		const msg = makeMessage({
			offer_id: "00000000-0000-0000-0000-000000000042",
			role: "skeptic-beta",
			required_capabilities: ["review"],
			route_hint: "claude-code",
			dispatch_id: 54968,
			proposal_id: 1135,
			claim_token: "tok-1393",
			lease_ttl_seconds: 60,
		});

		await handleOfferDispatch("claude/agency-bot", msg, {
			spawn: fakeSpawn as never,
			exec,
			logger: silentLogger,
			resolveWorktree: () => "test-worktree",
			renewalIntervalMs: 1_000_000,
			checkCapacity: allowCapacity,
		});

		// Wait for fire-and-forget runSpawn to flush. recordUsage hits the
		// real DB so a small setTimeout is more reliable than setImmediate loops.
		await new Promise((r) => setTimeout(r, 500));

		const stampIdx = calls.findIndex((c) =>
			c.sql.includes("squad_dispatch") &&
			c.sql.includes("failure_reason") &&
			c.sql.includes("rate_limited"),
		);
		const completeIdx = calls.findIndex((c) =>
			c.sql.includes("fn_complete_work_offer"),
		);

		expect(stampIdx).toBeGreaterThanOrEqual(0);
		expect(completeIdx).toBeGreaterThanOrEqual(0);
		expect(stampIdx).toBeLessThan(completeIdx);

		expect(calls[stampIdx].params).toEqual([54968, "claude/agency-bot"]);

		// EXISTS subquery on agent_runs.status='rate_limited' must be present
		// — without it, the marker would stamp on EVERY failure, breaking the
		// loop counter's ability to distinguish real failures.
		expect(calls[stampIdx].sql).toContain("agent_runs");
		expect(calls[stampIdx].sql).toContain("status = 'rate_limited'");
	});

	it("successful spawn → no stamp SQL is issued (marker only applies on failures)", async () => {
		const { calls, exec } = recordingExec();

		const fakeSpawn = async (req: Record<string, unknown>): Promise<SpawnResult> => ({
			agentRunId: "run-ok",
			worktree: req.worktree as string,
			exitCode: 0,
			stdout: "ok",
			stderr: "",
			durationMs: 5,
		});

		const msg = makeMessage({
			offer_id: "00000000-0000-0000-0000-000000000099",
			role: "drafter",
			required_capabilities: ["develop"],
			route_hint: "claude-code",
			dispatch_id: 99,
			proposal_id: 1136,
			claim_token: "tok-1393-ok",
			lease_ttl_seconds: 60,
		});

		await handleOfferDispatch("claude/agency-bot", msg, {
			spawn: fakeSpawn as never,
			exec,
			logger: silentLogger,
			resolveWorktree: () => "test-worktree",
			renewalIntervalMs: 1_000_000,
			checkCapacity: allowCapacity,
		});

		await new Promise((r) => setTimeout(r, 500));

		const stampCalls = calls.filter((c) =>
			c.sql.includes("squad_dispatch") &&
			c.sql.includes("failure_reason"),
		);
		expect(stampCalls.length).toBe(0);
	});

	it("stamp SQL failure does not block fn_complete_work_offer (best-effort)", async () => {
		const calls: Array<{ sql: string; params: unknown[] }> = [];
		const exec: SqlExec = async (sql, params) => {
			calls.push({ sql, params: params ?? [] });
			if (sql.includes("failure_reason") && sql.includes("squad_dispatch")) {
				throw new Error("simulated PG lock timeout on marker stamp");
			}
			return { rows: [] };
		};

		const fakeSpawn = async (): Promise<SpawnResult> => {
			throw new Error("spawn failed");
		};

		const msg = makeMessage({
			offer_id: "00000000-0000-0000-0000-000000001500",
			role: "skeptic-beta",
			required_capabilities: ["review"],
			route_hint: "claude-code",
			dispatch_id: 1500,
			proposal_id: 1135,
			claim_token: "tok-1393-err",
			lease_ttl_seconds: 60,
		});

		await handleOfferDispatch("claude/agency-bot", msg, {
			spawn: fakeSpawn as never,
			exec,
			logger: silentLogger,
			resolveWorktree: () => "test-worktree",
			renewalIntervalMs: 1_000_000,
			checkCapacity: allowCapacity,
		});

		await new Promise((r) => setTimeout(r, 500));

		const completeCalls = calls.filter((c) =>
			c.sql.includes("fn_complete_work_offer"),
		);
		expect(completeCalls.length).toBe(1);
		expect(completeCalls[0].params).toEqual([1500, "claude/agency-bot", "tok-1393-err", "failed"]);
	});
});
