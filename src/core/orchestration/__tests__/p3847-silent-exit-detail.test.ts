/**
 * P3847 AC-1: a non-success spawn exit must never persist an empty error_detail.
 *
 * The live bug: silent spawns (notably ~20-min AGENTHIVE_SPAWN_TIMEOUT_MS kills
 * that produced no stderr AND no stdout) were written to agent_runs as 'failed'
 * with error_detail='' — 582/639 failed runs in a 7d sample, each ~1.2M ms,
 * completely undiagnosable. synthesizeSilentExitDetail() guarantees an
 * attributable diagnostic and explicitly flags a duration-at-timeout as a
 * silent spawn-timeout.
 */

import { describe, it, expect, mock } from "bun:test";

const queryMock = mock(async () => ({ rows: [], rowCount: 0 }));
mock.module("../../../infra/postgres/pool.ts", () => ({
	query: (...args: unknown[]) => queryMock(...args),
}));

import { synthesizeSilentExitDetail } from "../agent-spawner.ts";

describe("P3847 AC-1: synthesizeSilentExitDetail", () => {
	it("flags a silent 20-min spawn timeout (empty stderr, empty stdout, duration>=timeout)", () => {
		const detail = synthesizeSilentExitDetail({
			errorDetail: "",
			outcome: "failed",
			exitCode: null,
			stdoutLen: 0,
			durationMs: 1_200_000,
			timeoutMs: 1_200_000,
		});
		expect(detail.length).toBeGreaterThan(0);
		expect(detail).toContain("hit spawn timeout");
		expect(detail).toContain("silent/no-progress");
		expect(detail).toContain("outcome=failed");
	});

	it("synthesizes a diagnostic for a non-timeout failure with empty stderr", () => {
		const detail = synthesizeSilentExitDetail({
			errorDetail: "",
			outcome: "failed",
			exitCode: 1,
			stdoutLen: 42,
			durationMs: 5_000,
			timeoutMs: 1_200_000,
		});
		expect(detail.length).toBeGreaterThan(0);
		expect(detail).toContain("exitCode=1");
		expect(detail).toContain("stdout_len=42");
		expect(detail).not.toContain("hit spawn timeout");
	});

	it("never blanks an existing stderr-derived detail", () => {
		const original = "TypeError: boom\n  at foo()";
		const detail = synthesizeSilentExitDetail({
			errorDetail: original,
			outcome: "failed",
			exitCode: 1,
			stdoutLen: 0,
			durationMs: 5_000,
			timeoutMs: 1_200_000,
		});
		expect(detail).toBe(original);
	});

	it("leaves a successful (completed) run's detail untouched", () => {
		const detail = synthesizeSilentExitDetail({
			errorDetail: "",
			outcome: "completed",
			exitCode: 0,
			stdoutLen: 100,
			durationMs: 5_000,
			timeoutMs: 1_200_000,
		});
		expect(detail).toBe("");
	});
});
