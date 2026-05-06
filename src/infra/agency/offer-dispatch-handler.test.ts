/**
 * P299-D: offer-dispatch-handler unit tests.
 *
 * Pure-mocked: no DB, no real spawn. Verifies the mechanical contract — the
 * handler invokes `spawnAgent` with the right shape (no agentLabel, with
 * capabilities), renews the lease while spawning, and on exit calls
 * `fn_complete_work_offer` directly. NO claim_status uplink is sent — the
 * orchestrator is mechanical and observes lifecycle via DB state alone.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { handleOfferDispatch, type SqlExec } from "./offer-dispatch-handler.ts";
import type { LiaisonMessage } from "./liaison-message-types.ts";
import type { SpawnResult } from "../../core/orchestration/agent-spawner.ts";

function makeMessage(payload: Record<string, unknown>): LiaisonMessage {
	return {
		message_id: "00000000-0000-0000-0000-000000000001",
		agency_id: "claude/agency-bot",
		sequence: 1n,
		direction: "orchestrator->liaison",
		kind: "offer_dispatch",
		correlation_id: "00000000-0000-0000-0000-aaaaaaaaaaaa",
		payload,
		signed_at: new Date().toISOString(),
		signature: "test-sig",
	};
}

function silentLogger(): Pick<Console, "log" | "warn" | "error"> {
	return { log: () => {}, warn: () => {}, error: () => {} };
}

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

test("handleOfferDispatch: spawns with capabilities and undefined agentLabel; calls fn_complete_work_offer on success", async () => {
	const spawnCalls: Array<Record<string, unknown>> = [];
	const { calls: execCalls, exec } = recordingExec();

	const fakeSpawn = async (req: Record<string, unknown>): Promise<SpawnResult> => {
		spawnCalls.push(req);
		return {
			agentRunId: "run-1",
			worktree: req.worktree as string,
			exitCode: 0,
			stdout: "ok",
			stderr: "",
			durationMs: 10,
		};
	};

	const msg = makeMessage({
		offer_id: "00000000-0000-0000-0000-000000000abc",
		role: "review",
		required_capabilities: ["review", "qa"],
		route_hint: "claude-code",
		briefing_id: "br-1",
		dispatch_id: 42,
		proposal_id: 999,
		claim_token: "tok-1",
		lease_ttl_seconds: 60,
	});

	await handleOfferDispatch("claude/agency-bot", msg, {
		spawn: fakeSpawn as never,
		exec,
		logger: silentLogger(),
		resolveWorktree: () => "test-worktree",
		renewalIntervalMs: 1_000_000, // effectively suppress renewal during test
	});

	// Wait for fire-and-forget runSpawn to complete.
	for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

	assert.equal(spawnCalls.length, 1, "spawnAgent called exactly once");
	const spawnReq = spawnCalls[0];
	assert.equal(spawnReq.worktree, "test-worktree");
	assert.equal(spawnReq.proposalId, 999);
	assert.equal(spawnReq.stage, "review");
	assert.equal(spawnReq.briefingId, "br-1");
	assert.deepEqual(spawnReq.capabilities, ["review", "qa"]);
	assert.equal(
		spawnReq.agentLabel,
		undefined,
		"agentLabel must be undefined so P852 structured identity fires",
	);

	// Lifecycle assertions: only fn_complete_work_offer (orchestrator is mechanical;
	// no uplink message is sent).
	const completeCalls = execCalls.filter((c) =>
		c.sql.includes("fn_complete_work_offer"),
	);
	assert.equal(completeCalls.length, 1, "fn_complete_work_offer called exactly once");
	assert.deepEqual(
		completeCalls[0].params,
		[42, "claude/agency-bot", "tok-1", "delivered"],
		"fn_complete_work_offer called with mechanical args (no LLM text)",
	);
});

test("handleOfferDispatch: failed spawn marks offer 'failed' via fn_complete_work_offer", async () => {
	const { calls: execCalls, exec } = recordingExec();

	const fakeSpawn = async (): Promise<SpawnResult> => {
		throw new Error("provider unreachable");
	};

	const msg = makeMessage({
		offer_id: "00000000-0000-0000-0000-deadbeef0001",
		role: "develop",
		required_capabilities: [],
		route_hint: "claude-code",
		dispatch_id: 50,
		claim_token: "tok-2",
		lease_ttl_seconds: 60,
	});

	await handleOfferDispatch("claude/agency-bot", msg, {
		spawn: fakeSpawn as never,
		exec,
		logger: silentLogger(),
		resolveWorktree: () => "test-worktree",
		renewalIntervalMs: 1_000_000,
	});

	for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

	const completeCalls = execCalls.filter((c) =>
		c.sql.includes("fn_complete_work_offer"),
	);
	assert.equal(completeCalls.length, 1);
	assert.deepEqual(completeCalls[0].params, [
		50,
		"claude/agency-bot",
		"tok-2",
		"failed",
	]);
});

test("handleOfferDispatch: empty capabilities falls back to [role]", async () => {
	const spawnCalls: Array<Record<string, unknown>> = [];
	const { exec } = recordingExec();

	const fakeSpawn = async (req: Record<string, unknown>): Promise<SpawnResult> => {
		spawnCalls.push(req);
		return {
			agentRunId: "run-2",
			worktree: req.worktree as string,
			exitCode: 0,
			stdout: "",
			stderr: "",
			durationMs: 1,
		};
	};

	const msg = makeMessage({
		offer_id: "00000000-0000-0000-0000-000000000def",
		role: "gate-review",
		required_capabilities: [],
		route_hint: "claude-code",
		dispatch_id: 11,
		claim_token: "tok-3",
	});

	await handleOfferDispatch("claude/agency-bot", msg, {
		spawn: fakeSpawn as never,
		exec,
		logger: silentLogger(),
		resolveWorktree: () => "wt",
		renewalIntervalMs: 1_000_000,
	});

	for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

	assert.deepEqual(spawnCalls[0].capabilities, ["gate-review"]);
});

test("handleOfferDispatch: malformed payload (no role) is rejected without spawn", async () => {
	let spawnCalled = false;
	const { calls: execCalls, exec } = recordingExec();

	const msg = makeMessage({ offer_id: "00000000-0000-0000-0000-000000000bad" });

	await handleOfferDispatch("claude/agency-bot", msg, {
		spawn: (async () => {
			spawnCalled = true;
			return {} as SpawnResult;
		}) as never,
		exec,
		logger: silentLogger(),
	});

	assert.equal(spawnCalled, false, "spawn must not run for malformed payload");
	assert.equal(execCalls.length, 0, "no SQL calls for malformed payload");
});

test("handleOfferDispatch: missing dispatch_id or claim_token aborts before spawn", async () => {
	let spawnCalled = false;
	const { calls: execCalls, exec } = recordingExec();

	// Payload has role + offer_id but no dispatch_id/claim_token — liaison
	// cannot renew or complete the offer mechanically, so it must refuse.
	const msg = makeMessage({
		offer_id: "00000000-0000-0000-0000-000000000ccc",
		role: "review",
		required_capabilities: [],
		route_hint: "claude-code",
	});

	await handleOfferDispatch("claude/agency-bot", msg, {
		spawn: (async () => {
			spawnCalled = true;
			return {} as SpawnResult;
		}) as never,
		exec,
		logger: silentLogger(),
	});

	assert.equal(spawnCalled, false);
	assert.equal(execCalls.length, 0);
});

test("handleOfferDispatch: renewal timer fires fn_renew_lease while spawn runs", async () => {
	let renewCount = 0;
	const exec: SqlExec = async (sql) => {
		if (sql.includes("fn_renew_lease")) renewCount++;
		return { rows: [] };
	};

	// Spawn that resolves after 250ms — renewal timer ticks every 50ms → ~4 renewals.
	const fakeSpawn = (): Promise<SpawnResult> =>
		new Promise((resolve) => {
			setTimeout(() => {
				resolve({
					agentRunId: "run-3",
					worktree: "wt",
					exitCode: 0,
					stdout: "",
					stderr: "",
					durationMs: 250,
				});
			}, 250);
		});

	const msg = makeMessage({
		offer_id: "00000000-0000-0000-0000-000000000eee",
		role: "develop",
		required_capabilities: [],
		route_hint: "claude-code",
		dispatch_id: 77,
		claim_token: "tok-4",
		lease_ttl_seconds: 60,
	});

	await handleOfferDispatch("claude/agency-bot", msg, {
		spawn: fakeSpawn as never,
		exec,
		logger: silentLogger(),
		resolveWorktree: () => "wt",
		renewalIntervalMs: 50,
	});

	// Wait for spawn to finish + a few extra ticks for the renewal timer to clear.
	await new Promise((r) => setTimeout(r, 400));
	assert.ok(
		renewCount >= 2,
		`expected at least 2 renewals during 250ms spawn; got ${renewCount}`,
	);
});
