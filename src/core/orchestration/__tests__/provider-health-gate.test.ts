/**
 * P3795 AC-6: integration coverage for the hard provider-health routing gate
 * inside the offer-dispatch handler.
 *
 * Pure-mocked (no DB, no real spawn), mirroring offer-dispatch-handler.test.ts:
 * a recording `exec` returns empty rows for every query so the pre-spawn
 * admission checks pass permissively, and a fake `spawn` records whether it ran.
 * The provider is steered via `route_hint` (the preferred_provider DB lookup
 * returns no rows → falls back to the hint), and provider health is controlled
 * by seeding the shared HealthCache directly.
 *
 * Cases:
 *   (a) fresh error   → blocked: zero spawns, fn_complete_work_offer('failed')
 *   (b) fresh ok      → spawn proceeds
 *   (c) stale error   → fail-open: spawn proceeds
 *   (d) flag disabled → gate skipped: spawn proceeds despite a fresh error
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_resetActiveSpawnForTest,
	_resetMaxInFlightCacheForTest,
	handleOfferDispatch,
	type SqlExec,
} from "../../../infra/agency/offer-dispatch-handler.ts";
import type { LiaisonMessage } from "../../../infra/agency/liaison-message-types.ts";
import type { SpawnResult } from "../agent-spawner.ts";
import {
	clearCachedProviderHealth,
	setCached,
} from "../../provider-health/cache.ts";

const PROVIDER = "openai-p3795-test";

function makeMessage(payload: Record<string, unknown>): LiaisonMessage {
	return {
		message_id: "00000000-0000-0000-0000-000000000777",
		agency_id: "agency-p3795",
		sequence: 1n,
		direction: "orchestrator->liaison",
		kind: "offer_dispatch",
		correlation_id: "00000000-0000-0000-0000-aaaaaaaaa777",
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

async function runDispatch(): Promise<{
	spawnCalls: Array<Record<string, unknown>>;
	execCalls: Array<{ sql: string; params: unknown[] }>;
}> {
	const spawnCalls: Array<Record<string, unknown>> = [];
	const { calls: execCalls, exec } = recordingExec();
	const fakeSpawn = async (req: Record<string, unknown>): Promise<SpawnResult> => {
		spawnCalls.push(req);
		return {
			agentRunId: "run-p3795",
			worktree: req.worktree as string,
			exitCode: 0,
			stdout: "ok",
			stderr: "",
			durationMs: 5,
		};
	};

	const msg = makeMessage({
		offer_id: "00000000-0000-0000-0000-000000000abc",
		role: "develop",
		required_capabilities: [],
		route_hint: PROVIDER,
		dispatch_id: 3795,
		proposal_id: 37950,
		claim_token: "tok-p3795",
		lease_ttl_seconds: 60,
	});

	await handleOfferDispatch("agency-p3795", msg, {
		spawn: fakeSpawn as never,
		exec,
		logger: silentLogger(),
		resolveWorktree: () => "test-worktree",
		renewalIntervalMs: 1_000_000,
	});
	// Drain the fire-and-forget runSpawn. The persona path does a dynamic
	// import() that is slow on first load (transform/IO) and cached after, so a
	// setImmediate flush alone races it — poll on real timers until the dispatch
	// settles (either a spawn ran or the offer was completed by the gate block).
	const deadline = Date.now() + 3_000;
	const settled = () =>
		spawnCalls.length > 0 ||
		execCalls.some((c) => c.sql.includes("fn_complete_work_offer"));
	while (Date.now() < deadline && !settled()) {
		await new Promise((r) => setTimeout(r, 10));
	}
	// A few extra ticks so the post-completion escalation_log insert lands.
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
	return { spawnCalls, execCalls };
}

describe("provider-health routing gate in offer dispatch (P3795 AC-6)", () => {
	beforeEach(() => {
		_resetActiveSpawnForTest?.();
		_resetMaxInFlightCacheForTest?.();
		clearCachedProviderHealth();
		delete process.env.PROVIDER_HEALTH_GATE_ENABLED;
		delete process.env.AGENTHIVE_AGENT_PROVIDER;
		delete process.env.AGENCY_PROVIDER;
	});
	afterEach(() => {
		clearCachedProviderHealth();
		delete process.env.PROVIDER_HEALTH_GATE_ENABLED;
	});

	it("(a) fresh error → blocked: no spawn, offer completed as 'failed', escalation logged", async () => {
		setCached(PROVIDER, null, { status: "error", checkedAt: Date.now() });
		const { spawnCalls, execCalls } = await runDispatch();

		expect(spawnCalls.length).toBe(0);
		const completes = execCalls.filter((c) =>
			c.sql.includes("fn_complete_work_offer"),
		);
		expect(completes.length).toBe(1);
		expect(completes[0].params).toEqual([3795, "agency-p3795", "tok-p3795", "failed"]);
		const escalations = execCalls.filter((c) =>
			c.sql.includes("roadmap.escalation_log"),
		);
		expect(escalations.length).toBe(1);
		expect(escalations[0].params[0]).toBe("PROVIDER_HEALTH_GATE");
		expect(escalations[0].params[1]).toBe("agency-p3795");
	});

	it("(b) fresh ok → spawn proceeds", async () => {
		setCached(PROVIDER, null, { status: "ok", checkedAt: Date.now() });
		const { spawnCalls } = await runDispatch();
		expect(spawnCalls.length).toBe(1);
		expect(spawnCalls[0].provider).toBe(PROVIDER);
	});

	it("(c) stale error → fail-open: spawn proceeds", async () => {
		setCached(PROVIDER, null, {
			status: "error",
			checkedAt: Date.now() - 10 * 60_000,
		});
		const { spawnCalls } = await runDispatch();
		expect(spawnCalls.length).toBe(1);
	});

	it("(d) PROVIDER_HEALTH_GATE_ENABLED=false → gate skipped, spawn proceeds despite fresh error", async () => {
		process.env.PROVIDER_HEALTH_GATE_ENABLED = "false";
		setCached(PROVIDER, null, { status: "error", checkedAt: Date.now() });
		const { spawnCalls } = await runDispatch();
		expect(spawnCalls.length).toBe(1);
	});
});
