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
import {
	_resetActiveSpawnForTest,
	_resetMaxInFlightCacheForTest,
	handleOfferDispatch,
	type SqlExec,
} from "./offer-dispatch-handler.ts";
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

test("handleOfferDispatch: spawns with capabilities and agencyId as agentLabel; calls fn_complete_work_offer on success", async () => {
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
		"claude/agency-bot",
		"agentLabel must be the agency id so spawned subprocess claims as the named agent",
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

test("handleOfferDispatch: paused agency declines spawn and completes offer as failed", async () => {
	_resetActiveSpawnForTest();
	_resetMaxInFlightCacheForTest();
	let spawnCalled = false;
	const execCalls: Array<{ sql: string; params: unknown[] }> = [];
	const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
	const exec: SqlExec = async (sql, params) => {
		execCalls.push({ sql, params: params ?? [] });
		if (sql.includes("FROM roadmap.agency"))
			return { rows: [{ paused_until: future }] };
		return { rows: [] };
	};

	const msg = makeMessage({
		offer_id: "00000000-0000-0000-0000-000000000fff",
		role: "develop",
		required_capabilities: [],
		route_hint: "claude-code",
		dispatch_id: 99,
		claim_token: "tok-paused",
		lease_ttl_seconds: 60,
	});

	await handleOfferDispatch("claude/agency-bot", msg, {
		spawn: (async () => {
			spawnCalled = true;
			return {} as SpawnResult;
		}) as never,
		exec,
		logger: silentLogger(),
		resolveWorktree: () => "wt",
		renewalIntervalMs: 1_000_000,
	});

	assert.equal(spawnCalled, false, "paused agency must not spawn");
	const completeCalls = execCalls.filter((c) =>
		c.sql.includes("fn_complete_work_offer"),
	);
	assert.equal(completeCalls.length, 1, "offer completed-as-failed so reaper requeues to another agency");
	assert.deepEqual(completeCalls[0].params, [99, "claude/agency-bot", "tok-paused", "failed"]);
});

test("handleOfferDispatch: codex usage-limit detected → throttle + pause SQL fired", async () => {
	const execCalls: Array<{ sql: string; params: unknown[] }> = [];
	const exec: SqlExec = async (sql, params) => {
		execCalls.push({ sql, params: params ?? [] });
		if (sql.includes("FROM roadmap.agency"))
			return { rows: [{ paused_until: null }] };
		return { rows: [] };
	};

	const fakeSpawn = async (req: Record<string, unknown>): Promise<SpawnResult> => ({
		agentRunId: "run-codex-limit",
		worktree: req.worktree as string,
		exitCode: 1,
		stdout:
			"OpenAI Codex v0.130.0\nERROR: You've hit your usage limit. Upgrade to Pro... try again at 3:21 PM.",
		stderr: "",
		durationMs: 100,
	});

	const msg = makeMessage({
		offer_id: "00000000-0000-0000-0000-00000000c0de",
		role: "develop",
		required_capabilities: [],
		route_hint: "codex",
		dispatch_id: 200,
		claim_token: "tok-codex",
		lease_ttl_seconds: 60,
	});

	await handleOfferDispatch("calvin", msg, {
		spawn: fakeSpawn as never,
		exec,
		logger: silentLogger(),
		resolveWorktree: () => "codex-one",
		renewalIntervalMs: 1_000_000,
	});

	for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

	const throttleCalls = execCalls.filter((c) =>
		c.sql.includes("host_model_route_throttle"),
	);
	assert.equal(throttleCalls.length, 1, "throttle row upserted exactly once");
	assert.equal(throttleCalls[0].params[0], "openai");
	assert.equal(throttleCalls[0].params[1], "gpt-5.4");
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

// ── Single-active-spawn invariant ─────────────────────────────────────────────

test("handleOfferDispatch: at-capacity agency returns offer via fn_return_work_offer (max_in_flight=1)", async () => {
	_resetActiveSpawnForTest();
	_resetMaxInFlightCacheForTest();
	const execCalls: Array<{ sql: string; params: unknown[] }> = [];
	const exec: SqlExec = async (sql, params) => {
		execCalls.push({ sql, params: params ?? [] });
		if (sql.includes("FROM roadmap.agency"))
			return { rows: [{ paused_until: null }] };
		if (sql.includes("FROM roadmap_workforce.provider_registry"))
			return { rows: [{ max_in_flight: 1 }] };
		return { rows: [] };
	};

	// First spawn is a deferred promise — we control when it resolves so the
	// test process doesn't hang on a pending activeSpawn.
	let firstSpawnResolve: (v: SpawnResult) => void = () => {};
	const firstSpawn = (req: Record<string, unknown>): Promise<SpawnResult> =>
		new Promise<SpawnResult>((resolve) => {
			firstSpawnResolve = resolve;
		});

	const msg1 = makeMessage({
		offer_id: "00000000-0000-0000-0000-aaaaaaaaaaa1",
		role: "develop",
		required_capabilities: [],
		route_hint: "claude-code",
		dispatch_id: 100,
		claim_token: "tok-first",
		lease_ttl_seconds: 60,
	});

	await handleOfferDispatch("alex", msg1, {
		spawn: firstSpawn as never,
		exec,
		logger: silentLogger(),
		resolveWorktree: () => "wt",
		renewalIntervalMs: 1_000_000,
	});

	// Now a second offer arrives while the first spawn is still pending.
	let secondSpawnCalled = false;
	const secondSpawn = async (_req: Record<string, unknown>): Promise<SpawnResult> => {
		secondSpawnCalled = true;
		return {} as SpawnResult;
	};

	const msg2 = makeMessage({
		offer_id: "00000000-0000-0000-0000-bbbbbbbbbbb2",
		role: "develop",
		required_capabilities: [],
		route_hint: "claude-code",
		dispatch_id: 200,
		claim_token: "tok-second",
		lease_ttl_seconds: 60,
	});

	await handleOfferDispatch("alex", msg2, {
		spawn: secondSpawn as never,
		exec,
		logger: silentLogger(),
		resolveWorktree: () => "wt",
		renewalIntervalMs: 1_000_000,
	});

	assert.equal(secondSpawnCalled, false, "second offer must NOT trigger a spawn");

	// Decline must go through fn_return_work_offer, NOT fn_complete_work_offer.
	const completeCalls = execCalls.filter((c) =>
		c.sql.includes("fn_complete_work_offer"),
	);
	assert.equal(
		completeCalls.length,
		0,
		"capacity decline must NOT use fn_complete_work_offer (no failure pollution)",
	);
	const returnCalls = execCalls.filter((c) =>
		c.sql.includes("fn_return_work_offer"),
	);
	assert.equal(returnCalls.length, 1, "exactly one fn_return_work_offer call");
	assert.equal(returnCalls[0].params[0], 200);
	assert.equal(returnCalls[0].params[1], "alex");
	assert.equal(returnCalls[0].params[2], "tok-second");
	assert.match(
		String(returnCalls[0].params[3]),
		/agency_at_capacity:\d+\/\d+/,
		"reason should embed the observed count/max",
	);

	// Resolve the first spawn so its finally clears activeSpawn and the test
	// process can exit cleanly. (Without this the runner hangs on a pending
	// promise stored in module state.)
	firstSpawnResolve({
		agentRunId: "run-first",
		worktree: "wt",
		exitCode: 0,
		stdout: "",
		stderr: "",
		durationMs: 1,
	});
	for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
});

test("handleOfferDispatch: after spawn completes, agency accepts the NEXT offer", async () => {
	_resetActiveSpawnForTest();
	_resetMaxInFlightCacheForTest();
	const execCalls: Array<{ sql: string; params: unknown[] }> = [];
	const exec: SqlExec = async (sql, params) => {
		execCalls.push({ sql, params: params ?? [] });
		if (sql.includes("FROM roadmap.agency"))
			return { rows: [{ paused_until: null }] };
		if (sql.includes("FROM roadmap_workforce.provider_registry"))
			return { rows: [{ max_in_flight: 1 }] };
		return { rows: [] };
	};

	let spawn1Calls = 0;
	const fastSpawn = async (req: Record<string, unknown>): Promise<SpawnResult> => {
		spawn1Calls++;
		return {
			agentRunId: "run-fast",
			worktree: req.worktree as string,
			exitCode: 0,
			stdout: "ok",
			stderr: "",
			durationMs: 1,
		};
	};

	const mk = (id: number, token: string) =>
		makeMessage({
			offer_id: `00000000-0000-0000-0000-${id.toString().padStart(12, "0")}`,
			role: "develop",
			required_capabilities: [],
			route_hint: "claude-code",
			dispatch_id: id,
			claim_token: token,
			lease_ttl_seconds: 60,
		});

	await handleOfferDispatch("pablo", mk(1, "tok-1"), {
		spawn: fastSpawn as never,
		exec,
		logger: silentLogger(),
		resolveWorktree: () => "wt",
		renewalIntervalMs: 1_000_000,
	});

	// Wait for the first spawn to settle (it's instant) + tick for finally.
	for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));

	await handleOfferDispatch("pablo", mk(2, "tok-2"), {
		spawn: fastSpawn as never,
		exec,
		logger: silentLogger(),
		resolveWorktree: () => "wt",
		renewalIntervalMs: 1_000_000,
	});

	for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));

	assert.equal(spawn1Calls, 2, "both offers should produce a spawn — the second is accepted after the first settles");
});

test("handleOfferDispatch: max_in_flight=2 allows two concurrent spawns, returns the third", async () => {
	_resetActiveSpawnForTest();
	_resetMaxInFlightCacheForTest();
	const execCalls: Array<{ sql: string; params: unknown[] }> = [];
	const exec: SqlExec = async (sql, params) => {
		execCalls.push({ sql, params: params ?? [] });
		if (sql.includes("FROM roadmap.agency"))
			return { rows: [{ paused_until: null }] };
		if (sql.includes("FROM roadmap_workforce.provider_registry"))
			return { rows: [{ max_in_flight: 2 }] };
		return { rows: [] };
	};

	// Deferred spawns so the first two stay active simultaneously.
	const resolvers: Array<(v: SpawnResult) => void> = [];
	let spawnCallCount = 0;
	const deferredSpawn = (req: Record<string, unknown>): Promise<SpawnResult> => {
		spawnCallCount++;
		return new Promise<SpawnResult>((resolve) => {
			resolvers.push(resolve);
		});
	};

	const mk = (id: number, token: string) =>
		makeMessage({
			offer_id: `00000000-0000-0000-0000-${id.toString().padStart(12, "0")}`,
			role: "develop",
			required_capabilities: [],
			route_hint: "claude-code",
			dispatch_id: id,
			claim_token: token,
			lease_ttl_seconds: 60,
		});

	await handleOfferDispatch("pete", mk(11, "t1"), {
		spawn: deferredSpawn as never, exec, logger: silentLogger(),
		resolveWorktree: () => "wt", renewalIntervalMs: 1_000_000,
	});
	await handleOfferDispatch("pete", mk(12, "t2"), {
		spawn: deferredSpawn as never, exec, logger: silentLogger(),
		resolveWorktree: () => "wt", renewalIntervalMs: 1_000_000,
	});
	await handleOfferDispatch("pete", mk(13, "t3"), {
		spawn: deferredSpawn as never, exec, logger: silentLogger(),
		resolveWorktree: () => "wt", renewalIntervalMs: 1_000_000,
	});

	assert.equal(spawnCallCount, 2, "first two offers spawn; third is over capacity");
	const returnCalls = execCalls.filter((c) =>
		c.sql.includes("fn_return_work_offer"),
	);
	assert.equal(returnCalls.length, 1, "third offer returned");
	assert.equal(returnCalls[0].params[0], 13, "the third dispatch_id was returned");

	// Cleanup so the test runner can exit.
	for (const r of resolvers) {
		r({ agentRunId: "run", worktree: "wt", exitCode: 0, stdout: "", stderr: "", durationMs: 1 });
	}
	for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
});
