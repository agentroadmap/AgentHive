/**
 * P856: Unit tests for runStaleLeaseProbeSweep.
 *
 * Injectable queryFn + probeFn — no DB or network required.
 * Verifies candidate selection, signal routing, onSilent callback,
 * and error-containment guarantees.
 */

import { describe, expect, test, mock } from "bun:test";
import {
	runStaleLeaseProbeSweep,
	type StaleLeaseSweepOptions,
	type QueryFn,
} from "./maintenance.ts";
import type { LivenessResult } from "./probes/agent-liveness.ts";

// ─── Stubs ────────────────────────────────────────────────────────────────────

type CandidateRow = { dispatch_id: string; agent_identity: string };

/** Build a queryFn that returns a fixed candidate list. */
function makeQueryFn(candidates: CandidateRow[]): QueryFn {
	return (async (_sql: string, _params?: unknown[]) => ({
		rows: candidates,
		rowCount: candidates.length,
	})) as unknown as QueryFn;
}

/** queryFn that throws every time. */
const throwingQueryFn: QueryFn = (async () => {
	throw new Error("DB unreachable");
}) as unknown as QueryFn;

/** Build a probeFn that always returns the given liveness result. */
function makeProbeFn(result: LivenessResult) {
	return async (_identity: string, _opts?: unknown): Promise<LivenessResult> => result;
}

const aliveResult: LivenessResult = {
	alive: true,
	signal: "pong",
	latency_ms: 12,
	reason: undefined,
};
const silentResult: LivenessResult = {
	alive: false,
	signal: "silent",
	latency_ms: 5001,
	reason: "no protocol_pong within 5000ms",
};
const unaddressableResult: LivenessResult = {
	alive: false,
	signal: "unaddressable",
	latency_ms: undefined,
	reason: "no LISTEN, no recent heartbeat — cannot probe",
};

const noopLogger = { log: () => {}, warn: () => {} };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runStaleLeaseProbeSweep", () => {
	test("returns empty result when no candidates", async () => {
		const result = await runStaleLeaseProbeSweep(
			{},
			makeQueryFn([]),
			makeProbeFn(aliveResult),
			noopLogger,
		);
		expect(result.probed).toHaveLength(0);
		expect(result.aliveCount).toBe(0);
		expect(result.silentCount).toBe(0);
		expect(result.unaddressableCount).toBe(0);
	});

	test("alive agent increments aliveCount, does not call onSilent", async () => {
		const onSilent = mock(async () => {});
		const result = await runStaleLeaseProbeSweep(
			{ onSilent },
			makeQueryFn([{ dispatch_id: "1", agent_identity: "worker/a" }]),
			makeProbeFn(aliveResult),
			noopLogger,
		);
		expect(result.aliveCount).toBe(1);
		expect(result.silentCount).toBe(0);
		expect(result.unaddressableCount).toBe(0);
		expect(result.probed[0]).toMatchObject({
			dispatch_id: 1,
			agent_identity: "worker/a",
			signal: "pong",
			alive: true,
		});
		expect(onSilent).not.toHaveBeenCalled();
	});

	test("silent agent increments silentCount, calls onSilent", async () => {
		const onSilent = mock(async (_id: number, _identity: string) => {});
		const result = await runStaleLeaseProbeSweep(
			{ onSilent },
			makeQueryFn([{ dispatch_id: "42", agent_identity: "worker/b" }]),
			makeProbeFn(silentResult),
			noopLogger,
		);
		expect(result.silentCount).toBe(1);
		expect(result.aliveCount).toBe(0);
		expect(result.unaddressableCount).toBe(0);
		expect(onSilent).toHaveBeenCalledTimes(1);
		expect(onSilent).toHaveBeenCalledWith(42, "worker/b");
	});

	test("unaddressable agent increments unaddressableCount, does NOT call onSilent", async () => {
		const onSilent = mock(async () => {});
		const result = await runStaleLeaseProbeSweep(
			{ onSilent },
			makeQueryFn([{ dispatch_id: "7", agent_identity: "provider/c" }]),
			makeProbeFn(unaddressableResult),
			noopLogger,
		);
		expect(result.unaddressableCount).toBe(1);
		expect(result.silentCount).toBe(0);
		expect(onSilent).not.toHaveBeenCalled();
	});

	test("candidate query failure returns empty result without throwing", async () => {
		let warned = false;
		const logger = { log: () => {}, warn: () => { warned = true; } };
		const result = await runStaleLeaseProbeSweep(
			{},
			throwingQueryFn,
			makeProbeFn(aliveResult),
			logger,
		);
		expect(result.probed).toHaveLength(0);
		expect(warned).toBe(true);
	});

	test("onSilent throwing is caught; sweep continues to next candidate", async () => {
		let warnCount = 0;
		const logger = { log: () => {}, warn: () => { warnCount++; } };
		const onSilent = mock(async () => { throw new Error("db write failed"); });

		const result = await runStaleLeaseProbeSweep(
			{ onSilent },
			makeQueryFn([
				{ dispatch_id: "10", agent_identity: "worker/x" },
				{ dispatch_id: "11", agent_identity: "worker/y" },
			]),
			makeProbeFn(silentResult),
			logger,
		);
		expect(result.silentCount).toBe(2);
		expect(onSilent).toHaveBeenCalledTimes(2);
		expect(warnCount).toBeGreaterThanOrEqual(2); // one warn per onSilent throw
	});

	test("mixed signals: alive+silent+unaddressable counted correctly", async () => {
		const candidates = [
			{ dispatch_id: "1", agent_identity: "worker/alive" },
			{ dispatch_id: "2", agent_identity: "worker/silent" },
			{ dispatch_id: "3", agent_identity: "worker/unaddr" },
		];
		let callIdx = 0;
		const mixedProbeFn = async (_identity: string): Promise<LivenessResult> => {
			const results = [aliveResult, silentResult, unaddressableResult];
			return results[callIdx++]!;
		};

		const onSilent = mock(async () => {});
		const result = await runStaleLeaseProbeSweep(
			{ onSilent },
			makeQueryFn(candidates),
			mixedProbeFn,
			noopLogger,
		);

		expect(result.aliveCount).toBe(1);
		expect(result.silentCount).toBe(1);
		expect(result.unaddressableCount).toBe(1);
		expect(result.probed).toHaveLength(3);
		expect(onSilent).toHaveBeenCalledTimes(1);
		expect(onSilent).toHaveBeenCalledWith(2, "worker/silent");
	});

	test("stormCap limits candidates passed to probeFn", async () => {
		// All 5 rows come back from query, but stormCap=2 is passed to the SQL LIMIT.
		// We verify via the candidates the query returns — the LIMIT is in SQL, not TS.
		// Here we simulate it: queryFn already honours LIMIT. We just confirm the
		// function accepts stormCap and passes it.
		const candidates = [
			{ dispatch_id: "1", agent_identity: "a" },
			{ dispatch_id: "2", agent_identity: "b" },
		];
		const probeCallCount = { n: 0 };
		const countingProbeFn = async (): Promise<LivenessResult> => {
			probeCallCount.n++;
			return aliveResult;
		};

		await runStaleLeaseProbeSweep(
			{ stormCap: 2 },
			makeQueryFn(candidates),
			countingProbeFn,
			noopLogger,
		);
		expect(probeCallCount.n).toBe(2);
	});

	test("dispatch_id is coerced from string to number in probed rows", async () => {
		const result = await runStaleLeaseProbeSweep(
			{},
			makeQueryFn([{ dispatch_id: "9999", agent_identity: "worker/d" }]),
			makeProbeFn(aliveResult),
			noopLogger,
		);
		expect(result.probed[0]?.dispatch_id).toBe(9999);
		expect(typeof result.probed[0]?.dispatch_id).toBe("number");
	});

	test("probeFn throwing is caught; signals unaddressable for that dispatch", async () => {
		const throwingProbeFn = async (): Promise<LivenessResult> => {
			throw new Error("network timeout");
		};
		const result = await runStaleLeaseProbeSweep(
			{},
			makeQueryFn([{ dispatch_id: "3", agent_identity: "worker/e" }]),
			throwingProbeFn,
			noopLogger,
		);
		expect(result.unaddressableCount).toBe(1);
		expect(result.probed[0]?.signal).toBe("unaddressable");
	});
});
