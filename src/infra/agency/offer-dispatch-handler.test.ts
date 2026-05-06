/**
 * P299-D: offer-dispatch-handler unit tests.
 *
 * Pure-mocked: no DB, no real spawn. Verifies the message contract — that the
 * handler invokes `spawnAgent` with the right shape (no agentLabel, with
 * capabilities) and emits a `claim_status` uplink with the right outcome.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { handleOfferDispatch } from "./offer-dispatch-handler.ts";
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

test("handleOfferDispatch: spawns with capabilities and undefined agentLabel", async () => {
	const spawnCalls: Array<Record<string, unknown>> = [];
	const sendCalls: Array<Record<string, unknown>> = [];

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

	const fakeSend = async (
		opts: Record<string, unknown>,
	): Promise<LiaisonMessage> => {
		sendCalls.push(opts);
		return makeMessage(opts.payload as Record<string, unknown>);
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
	});

	await handleOfferDispatch("claude/agency-bot", msg, {
		spawn: fakeSpawn as never,
		send: fakeSend as never,
		logger: silentLogger(),
		resolveWorktree: () => "test-worktree",
	});

	// Wait briefly for the fire-and-forget runSpawnAndReport to complete.
	await new Promise((r) => setImmediate(r));
	await new Promise((r) => setImmediate(r));

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

	assert.equal(sendCalls.length, 1, "claim_status uplink sent");
	const uplink = sendCalls[0];
	assert.equal(uplink.kind, "claim_status");
	assert.equal(uplink.direction, "liaison->orchestrator");
	assert.equal(uplink.agency_id, "claude/agency-bot");
	assert.equal(uplink.correlation_id, msg.correlation_id);
	const uplinkPayload = uplink.payload as Record<string, unknown>;
	assert.equal(uplinkPayload.offer_id, "00000000-0000-0000-0000-000000000abc");
	assert.equal(uplinkPayload.status, "delivered");
	assert.equal(uplinkPayload.exit_code, 0);
});

test("handleOfferDispatch: failed spawn produces 'failed' uplink", async () => {
	const sendCalls: Array<Record<string, unknown>> = [];

	const fakeSpawn = async (): Promise<SpawnResult> => {
		throw new Error("provider unreachable");
	};

	const fakeSend = async (
		opts: Record<string, unknown>,
	): Promise<LiaisonMessage> => {
		sendCalls.push(opts);
		return makeMessage(opts.payload as Record<string, unknown>);
	};

	const msg = makeMessage({
		offer_id: "00000000-0000-0000-0000-deadbeef0001",
		role: "develop",
		required_capabilities: [],
		route_hint: "claude-code",
		dispatch_id: 50,
	});

	await handleOfferDispatch("claude/agency-bot", msg, {
		spawn: fakeSpawn as never,
		send: fakeSend as never,
		logger: silentLogger(),
		resolveWorktree: () => "test-worktree",
	});

	await new Promise((r) => setImmediate(r));
	await new Promise((r) => setImmediate(r));

	assert.equal(sendCalls.length, 1);
	const uplinkPayload = sendCalls[0].payload as Record<string, unknown>;
	assert.equal(uplinkPayload.status, "failed");
	assert.match(
		String(uplinkPayload.summary ?? ""),
		/provider unreachable/,
	);
});

test("handleOfferDispatch: empty capabilities falls back to [role]", async () => {
	const spawnCalls: Array<Record<string, unknown>> = [];

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

	const fakeSend = async (): Promise<LiaisonMessage> =>
		makeMessage({});

	const msg = makeMessage({
		offer_id: "00000000-0000-0000-0000-000000000def",
		role: "gate-review",
		required_capabilities: [],
		route_hint: "claude-code",
	});

	await handleOfferDispatch("claude/agency-bot", msg, {
		spawn: fakeSpawn as never,
		send: fakeSend as never,
		logger: silentLogger(),
		resolveWorktree: () => "wt",
	});

	await new Promise((r) => setImmediate(r));
	await new Promise((r) => setImmediate(r));

	assert.deepEqual(spawnCalls[0].capabilities, ["gate-review"]);
});

test("handleOfferDispatch: malformed payload (no role) is rejected without spawn", async () => {
	let spawnCalled = false;
	let sendCalled = false;

	const msg = makeMessage({ offer_id: "00000000-0000-0000-0000-000000000bad" });

	await handleOfferDispatch("claude/agency-bot", msg, {
		spawn: (async () => {
			spawnCalled = true;
			return {} as SpawnResult;
		}) as never,
		send: (async () => {
			sendCalled = true;
			return makeMessage({});
		}) as never,
		logger: silentLogger(),
	});

	assert.equal(spawnCalled, false, "spawn must not run for malformed payload");
	assert.equal(sendCalled, false, "no uplink for malformed payload");
});
