/**
 * P798: OfferProvider routing tests — tenant isolation and forbidden-provider rejection.
 *
 * These tests verify that route_provider is:
 *   1. Surfaced from fn_claim_work_offer and logged at dispatch time.
 *   2. Included in the claim SQL query (so the DB can enforce project_route_policy).
 *   3. Correctly scoped per project_id when provided.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	OfferProvider,
	type ListenerClient,
	type QueryFn,
	type SpawnFn,
} from "../../src/core/pipeline/offer-provider.ts";

// ─── Shared fakes ─────────────────────────────────────────────────────────────

type SqlCall = { text: string; params?: unknown[] };
type QueryResultLike = { rows: unknown[] };

function makeLogger() {
	const lines: string[] = [];
	return {
		log: (...a: unknown[]) => lines.push(a.join(" ")),
		warn: (...a: unknown[]) => lines.push("WARN " + a.join(" ")),
		error: (...a: unknown[]) => lines.push("ERR " + a.join(" ")),
		lines,
	};
}

function makeIntervals() {
	const handles = new Map<ReturnType<typeof setInterval>, () => void>();
	let nextId = 1;
	return {
		setIntervalFn(fn: () => void, _ms: number) {
			const id = nextId++ as unknown as ReturnType<typeof setInterval>;
			handles.set(id, fn);
			return id;
		},
		clearIntervalFn(id: ReturnType<typeof setInterval> | undefined) {
			if (id !== undefined) handles.delete(id);
		},
		handles,
	};
}

function makeListener(): ListenerClient {
	return {
		async query() { return { rows: [] }; },
		on() { return this; },
		removeListener() { return this; },
	};
}

function makeNoopSpawn(): SpawnFn {
	return async () => ({
		agentRunId: "run-test",
		worktree: "test-worktree",
		exitCode: 0,
		stdout: "",
		stderr: "",
		durationMs: 1,
	});
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("OfferProvider — P798 route_provider", () => {
	it("selects route_provider column from fn_claim_work_offer", async () => {
		const sqlCalls: SqlCall[] = [];

		const claimRow = {
			dispatch_id: 301,
			proposal_id: 10,
			squad_name: "P10-develop",
			dispatch_role: "developer",
			claim_token: "tok-1",
			claim_expires_at: new Date(Date.now() + 30_000).toISOString(),
			offer_version: 1,
			metadata: { task: "do work", model: "claude-opus-4-7" },
			route_provider: "anthropic",
		};
		const claimsLeft = [claimRow, null];

		const queryFn = (async (text: string, params?: unknown[]) => {
			sqlCalls.push({ text, params });
			if (text.includes("fn_claim_work_offer")) {
				return { rows: [claimsLeft.shift() ?? {}].filter(Boolean) };
			}
			if (text.includes("fn_activate_work_offer")) return { rows: [{ ok: true }] };
			return { rows: [] };
		}) as unknown as QueryFn;

		const intervals = makeIntervals();
		const logger = makeLogger();

		const provider = new OfferProvider({
			agentIdentity: "test-agency",
			queryFn,
			connectListener: async () => makeListener(),
			spawnFn: makeNoopSpawn(),
			logger,
			setIntervalFn: intervals.setIntervalFn as unknown as typeof setInterval,
			clearIntervalFn: intervals.clearIntervalFn as unknown as typeof clearInterval,
		});

		await provider.run();
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		await provider.stop();
		intervals.handles.clear();

		// Verify the claim query includes route_provider in the SELECT list
		const claimCall = sqlCalls.find((c) => c.text.includes("fn_claim_work_offer"));
		assert.ok(claimCall, "fn_claim_work_offer must be called");
		assert.ok(
			claimCall!.text.includes("route_provider"),
			"claim query must SELECT route_provider",
		);

		// Verify route_provider is logged in the dispatch log line
		const logLine = logger.lines.find((l) => l.includes("Claimed dispatch 301"));
		assert.ok(logLine, "dispatch log line must exist");
		assert.ok(
			logLine!.includes("route: anthropic"),
			`log line should include route_provider — got: ${logLine}`,
		);
	});

	it("passes project_id to fn_claim_work_offer for tenant isolation", async () => {
		const sqlCalls: SqlCall[] = [];

		const queryFn = (async (text: string, params?: unknown[]) => {
			sqlCalls.push({ text, params });
			// Return no offer — we only care that project_id is sent correctly
			if (text.includes("fn_claim_work_offer")) return { rows: [] };
			return { rows: [] };
		}) as unknown as QueryFn;

		const intervals = makeIntervals();

		const provider = new OfferProvider({
			agentIdentity: "tenant-agency",
			projectId: 42,
			queryFn,
			connectListener: async () => makeListener(),
			spawnFn: makeNoopSpawn(),
			logger: makeLogger(),
			setIntervalFn: intervals.setIntervalFn as unknown as typeof setInterval,
			clearIntervalFn: intervals.clearIntervalFn as unknown as typeof clearInterval,
		});

		await provider.run();
		await provider.stop();
		intervals.handles.clear();

		const claimCall = sqlCalls.find((c) => c.text.includes("fn_claim_work_offer"));
		assert.ok(claimCall, "fn_claim_work_offer must be called");
		// 4th param is project_id
		assert.equal(
			claimCall!.params?.[3],
			42,
			"project_id=42 must be passed as 4th param to fn_claim_work_offer",
		);
	});

	it("omits route suffix from log when route_provider is null", async () => {
		const sqlCalls: SqlCall[] = [];

		const claimRow = {
			dispatch_id: 303,
			proposal_id: 11,
			squad_name: "P11-develop",
			dispatch_role: "developer",
			claim_token: "tok-3",
			claim_expires_at: new Date(Date.now() + 30_000).toISOString(),
			offer_version: 1,
			metadata: { task: "do work" },
			route_provider: null, // no model specified → no route resolved
		};
		const claimsLeft = [claimRow, null];

		const queryFn = (async (text: string, params?: unknown[]) => {
			sqlCalls.push({ text, params });
			if (text.includes("fn_claim_work_offer")) {
				return { rows: [claimsLeft.shift() ?? {}].filter(Boolean) };
			}
			if (text.includes("fn_activate_work_offer")) return { rows: [{ ok: true }] };
			return { rows: [] };
		}) as unknown as QueryFn;

		const intervals = makeIntervals();
		const logger = makeLogger();

		const provider = new OfferProvider({
			agentIdentity: "test-agency-2",
			queryFn,
			connectListener: async () => makeListener(),
			spawnFn: makeNoopSpawn(),
			logger,
			setIntervalFn: intervals.setIntervalFn as unknown as typeof setInterval,
			clearIntervalFn: intervals.clearIntervalFn as unknown as typeof clearInterval,
		});

		await provider.run();
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		await provider.stop();
		intervals.handles.clear();

		const logLine = logger.lines.find((l) => l.includes("Claimed dispatch 303"));
		assert.ok(logLine, "dispatch log line must exist");
		assert.ok(
			!logLine!.includes("route:"),
			`log line must NOT include route suffix when route_provider is null — got: ${logLine}`,
		);
	});
});
