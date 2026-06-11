/**
 * Tests for P1730 MCP init wrapper (AC-1, AC-2)
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
	recordMcpInitTiming,
	getMcpInitTimings,
	getMcpInitDiagnostics,
	clearMcpInitTimings,
	getMcpInitDiagnosisReport,
	type McpInitTiming,
} from "./mcp-init-wrapper.ts";

describe("P1730 MCP Init Wrapper", () => {
	beforeEach(() => {
		clearMcpInitTimings();
	});

	it("records MCP init timing", () => {
		const timing: McpInitTiming = {
			runId: "test-run-1",
			worktree: "claude-test",
			startMs: Date.now(),
			status: "ready",
			totalMs: 500,
		};

		recordMcpInitTiming(timing);
		const timings = getMcpInitTimings();

		expect(timings).toHaveLength(1);
		expect(timings[0]).toEqual(timing);
	});

	it("tracks multiple timing samples", () => {
		for (let i = 0; i < 5; i++) {
			recordMcpInitTiming({
				runId: `run-${i}`,
				worktree: "claude-test",
				startMs: Date.now(),
				status: "ready",
				totalMs: 100 + i * 50,
			});
		}

		const timings = getMcpInitTimings();
		expect(timings).toHaveLength(5);
	});

	it("computes diagnostics correctly", () => {
		// Record samples with known durations: 100, 150, 200
		const durations = [100, 150, 200];
		for (let i = 0; i < 3; i++) {
			recordMcpInitTiming({
				runId: `run-${i}`,
				worktree: "claude-test",
				startMs: Date.now(),
				status: "ready",
				totalMs: durations[i],
			});
		}

		const diag = getMcpInitDiagnostics();

		expect(diag.sampleCount).toBe(3);
		expect(diag.baselineMs).toBe(100);
		expect(diag.maxMs).toBe(200);
		expect(diag.avgMs).toBe(150);
	});

	it("generates diagnosis report with no samples", () => {
		const report = getMcpInitDiagnosisReport();

		expect(report).toContain("P1730 AC-1 Diagnosis");
		expect(report).toContain("0 MCP init samples");
		expect(report).toContain("No samples collected yet");
	});

	it("generates diagnosis report with samples", () => {
		for (let i = 0; i < 3; i++) {
			recordMcpInitTiming({
				runId: `run-${i}`,
				worktree: "claude-test",
				startMs: Date.now(),
				status: "ready",
				totalMs: 100 + i * 50,
			});
		}

		const report = getMcpInitDiagnosisReport();

		expect(report).toContain("P1730 AC-1 Diagnosis");
		expect(report).toContain("3 MCP init samples");
		expect(report).toContain("Baseline");
		expect(report).toContain("Maximum");
		expect(report).toContain("Average");
		expect(report).toContain("Distribution by status");
	});

	it("tracks different statuses in diagnostic", () => {
		recordMcpInitTiming({
			runId: "run-success",
			worktree: "claude-test",
			startMs: Date.now(),
			status: "ready",
			totalMs: 100,
		});

		recordMcpInitTiming({
			runId: "run-timeout",
			worktree: "claude-test",
			startMs: Date.now(),
			status: "timeout",
			totalMs: 90000,
			errorMessage: "MCP init timeout",
		});

		const report = getMcpInitDiagnosisReport();

		expect(report).toContain("ready");
		expect(report).toContain("timeout");
	});

	it("clears timings correctly", () => {
		recordMcpInitTiming({
			runId: "run-1",
			worktree: "claude-test",
			startMs: Date.now(),
			status: "ready",
			totalMs: 100,
		});

		expect(getMcpInitTimings()).toHaveLength(1);

		clearMcpInitTimings();

		expect(getMcpInitTimings()).toHaveLength(0);
	});
});
