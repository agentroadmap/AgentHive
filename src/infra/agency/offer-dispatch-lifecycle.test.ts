/**
 * P902 AC-9: offer_dispatch full lifecycle integration tests.
 *
 * Simulates the liaison receiving an `offer_dispatch` LiaisonMessage, going
 * through the full runSpawn path, and verifies:
 *   - spawnAgent is called with correct shape (worktree, proposalId, role,
 *     capabilities, roleProfileId from payload — no agentLabel)
 *   - fn_renew_lease fires while spawn is in-flight
 *   - fn_complete_work_offer('delivered') is called on success
 *   - fn_complete_work_offer('failed') is called on spawn error
 *   - spawn_failure uplink is emitted when spawn fails (AC-5)
 *   - no spawn_failure uplink is emitted on success
 *   - roleProfileId from the offer payload flows through to spawnAgent (AC-7)
 *
 * Pure-mocked: no DB, no real spawn.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { handleOfferDispatch, type SqlExec } from "./offer-dispatch-handler.ts";
import type { LiaisonMessage } from "./liaison-message-types.ts";
import type { SpawnResult } from "../../core/orchestration/agent-spawner.ts";
import type { sendMessage } from "./liaison-message-service.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMsg(payload: Record<string, unknown>): LiaisonMessage {
	return {
		message_id: "00000000-0000-0000-0000-ac9000000001",
		agency_id: "claude/agency-bot",
		sequence: 1n,
		direction: "orchestrator->liaison",
		kind: "offer_dispatch",
		correlation_id: "00000000-0000-0000-0000-ac9000000002",
		payload,
		signed_at: new Date().toISOString(),
		signature: "test-sig",
	};
}

function makeExec(): {
	calls: Array<{ sql: string; params: unknown[] }>;
	exec: SqlExec;
} {
	const calls: Array<{ sql: string; params: unknown[] }> = [];
	return {
		calls,
		exec: async (sql, params) => {
			calls.push({ sql, params: params ?? [] });
			return { rows: [] };
		},
	};
}

function makeUplinkCapture(): {
	calls: Parameters<typeof sendMessage>[0][];
	fn: typeof sendMessage;
} {
	const calls: Parameters<typeof sendMessage>[0][] = [];
	return {
		calls,
		fn: async (opts) => {
			calls.push(opts);
			return {} as never;
		},
	};
}

function noop(): Pick<Console, "log" | "warn" | "error"> {
	return { log: () => {}, warn: () => {}, error: () => {} };
}

async function drainMicrotasks(n = 15) {
	for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

// ─── AC-9 Test 1: Successful spawn → delivered, no uplink ───────────────────

test("AC-9: successful spawn → fn_complete_work_offer('delivered'), no spawn_failure uplink", async () => {
	const { calls: execCalls, exec } = makeExec();
	const { calls: uplinkCalls, fn: sendUplink } = makeUplinkCapture();
	const spawnCalls: Record<string, unknown>[] = [];

	const fakeSpawn = async (req: Record<string, unknown>): Promise<SpawnResult> => {
		spawnCalls.push(req);
		return { agentRunId: "r1", worktree: "wt-main", exitCode: 0, stdout: "ok", stderr: "", durationMs: 10 };
	};

	await handleOfferDispatch(
		"claude/agency-bot",
		makeMsg({
			offer_id: "offer-ac9-ok",
			role: "develop",
			required_capabilities: ["develop", "typescript"],
			route_hint: "claude-code",
			dispatch_id: 200,
			proposal_id: 500,
			claim_token: "tok-ok",
			briefing_id: "br-ok",
			worktree_hint: "wt-main",
			lease_ttl_seconds: 60,
			role_profile_id: 7,
		}),
		{ spawn: fakeSpawn as never, exec, logger: noop(), sendUplink, renewalIntervalMs: 1_000_000 },
	);
	await drainMicrotasks();

	// spawn called once with correct shape
	assert.equal(spawnCalls.length, 1);
	const sp = spawnCalls[0];
	assert.equal(sp.worktree, "wt-main");
	assert.equal(sp.proposalId, 500);
	assert.equal(sp.stage, "develop");
	assert.equal(sp.briefingId, "br-ok");
	assert.deepEqual(sp.capabilities, ["develop", "typescript"]);
	assert.equal(sp.agentLabel, undefined, "agentLabel must be absent (P852)");
	// AC-7: roleProfileId flows from payload
	assert.equal(sp.roleProfileId, 7);

	// Mechanical lifecycle: fn_complete_work_offer('delivered')
	const complete = execCalls.filter((c) => c.sql.includes("fn_complete_work_offer"));
	assert.equal(complete.length, 1);
	assert.deepEqual(complete[0].params, [200, "claude/agency-bot", "tok-ok", "delivered"]);

	// No spawn_failure uplink on success
	assert.equal(uplinkCalls.length, 0, "no uplink expected on success");
});

// ─── AC-9 Test 2: Spawn throws → failed + spawn_failure uplink ───────────────

test("AC-9: spawn throws → fn_complete_work_offer('failed') + spawn_failure uplink", async () => {
	const { calls: execCalls, exec } = makeExec();
	const { calls: uplinkCalls, fn: sendUplink } = makeUplinkCapture();

	const fakeSpawn = async (): Promise<SpawnResult> => {
		throw new Error("provider unreachable");
	};

	await handleOfferDispatch(
		"claude/agency-bot",
		makeMsg({
			offer_id: "offer-ac9-fail",
			role: "review",
			required_capabilities: [],
			route_hint: "claude-code",
			dispatch_id: 201,
			claim_token: "tok-fail",
			lease_ttl_seconds: 60,
		}),
		{ spawn: fakeSpawn as never, exec, logger: noop(), sendUplink, renewalIntervalMs: 1_000_000 },
	);
	await drainMicrotasks();

	// Mechanical lifecycle: fn_complete_work_offer('failed')
	const complete = execCalls.filter((c) => c.sql.includes("fn_complete_work_offer"));
	assert.equal(complete.length, 1);
	assert.deepEqual(complete[0].params, [201, "claude/agency-bot", "tok-fail", "failed"]);

	// AC-5: spawn_failure uplink emitted
	const failure = uplinkCalls.filter((c) => c.kind === "spawn_failure");
	assert.equal(failure.length, 1, "expected exactly one spawn_failure uplink");
	const fp = failure[0];
	assert.equal(fp.agency_id, "claude/agency-bot");
	assert.equal(fp.direction, "liaison->orchestrator");
	assert.equal((fp.payload as any).dispatch_id, 201);
	assert.equal((fp.payload as any).offer_id, "offer-ac9-fail");
	assert.equal((fp.payload as any).role, "review");
	assert.ok(
		String((fp.payload as any).error_message).includes("provider unreachable"),
		"error_message should contain the thrown message",
	);
});

// ─── AC-9 Test 3: Non-zero exit → failed + spawn_failure uplink ──────────────

test("AC-9: spawn returns non-zero exit → fn_complete_work_offer('failed') + spawn_failure uplink", async () => {
	const { calls: execCalls, exec } = makeExec();
	const { calls: uplinkCalls, fn: sendUplink } = makeUplinkCapture();

	const fakeSpawn = async (): Promise<SpawnResult> =>
		({ agentRunId: "r3", worktree: "wt", exitCode: 1, stdout: "", stderr: "OOM", durationMs: 5 });

	await handleOfferDispatch(
		"claude/agency-bot",
		makeMsg({
			offer_id: "offer-ac9-nonzero",
			role: "develop",
			required_capabilities: ["develop"],
			route_hint: "claude-code",
			dispatch_id: 202,
			claim_token: "tok-nonzero",
			lease_ttl_seconds: 60,
		}),
		{ spawn: fakeSpawn as never, exec, logger: noop(), sendUplink, renewalIntervalMs: 1_000_000 },
	);
	await drainMicrotasks();

	const complete = execCalls.filter((c) => c.sql.includes("fn_complete_work_offer"));
	assert.equal(complete.length, 1);
	assert.deepEqual(complete[0].params, [202, "claude/agency-bot", "tok-nonzero", "failed"]);

	const failure = uplinkCalls.filter((c) => c.kind === "spawn_failure");
	assert.equal(failure.length, 1);
	assert.equal((failure[0].payload as any).exit_code, 1);
});

// ─── AC-9 Test 4: Lease renewal fires while spawn is in-flight ───────────────

test("AC-9: fn_renew_lease fires at least once while spawn is in-flight (250ms spawn, 50ms renewal)", async () => {
	let renewCount = 0;
	const exec: SqlExec = async (sql) => {
		if (sql.includes("fn_renew_lease")) renewCount++;
		return { rows: [] };
	};
	const { fn: sendUplink } = makeUplinkCapture();

	const fakeSpawn = (): Promise<SpawnResult> =>
		new Promise((r) => setTimeout(() =>
			r({ agentRunId: "r4", worktree: "wt", exitCode: 0, stdout: "", stderr: "", durationMs: 250 }),
		250));

	await handleOfferDispatch(
		"claude/agency-bot",
		makeMsg({
			offer_id: "offer-ac9-renew",
			role: "develop",
			required_capabilities: [],
			route_hint: "claude-code",
			dispatch_id: 203,
			claim_token: "tok-renew",
			lease_ttl_seconds: 60,
		}),
		{ spawn: fakeSpawn as never, exec, logger: noop(), sendUplink, renewalIntervalMs: 50 },
	);

	await new Promise((r) => setTimeout(r, 400));
	assert.ok(renewCount >= 2, `expected ≥2 renewals during 250ms spawn; got ${renewCount}`);
});

// ─── AC-9 Test 5: spawn_failure uplink failure is non-fatal ──────────────────

test("AC-9: spawn_failure uplink failure does not prevent fn_complete_work_offer", async () => {
	const { calls: execCalls, exec } = makeExec();

	// sendUplink throws — verifies the .catch() path doesn't swallow completion.
	const throwingUplink: typeof sendMessage = async () => {
		throw new Error("uplink DB down");
	};

	const fakeSpawn = async (): Promise<SpawnResult> => {
		throw new Error("spawn failed");
	};

	await handleOfferDispatch(
		"claude/agency-bot",
		makeMsg({
			offer_id: "offer-ac9-uplinkfail",
			role: "review",
			required_capabilities: [],
			route_hint: "claude-code",
			dispatch_id: 204,
			claim_token: "tok-uplinkfail",
		}),
		{ spawn: fakeSpawn as never, exec, logger: noop(), sendUplink: throwingUplink, renewalIntervalMs: 1_000_000 },
	);
	await drainMicrotasks();

	// fn_complete_work_offer must still be called even when uplink throws.
	const complete = execCalls.filter((c) => c.sql.includes("fn_complete_work_offer"));
	assert.equal(complete.length, 1, "fn_complete_work_offer must fire even if uplink threw");
	assert.deepEqual(complete[0].params, [204, "claude/agency-bot", "tok-uplinkfail", "failed"]);
});
