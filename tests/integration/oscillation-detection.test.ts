/**
 * Tests for dag-health.ts — Oscillation Detection (AC-7)
 *
 * Tests the oscillation detection types and formatting functions.
 */
import assert from "node:assert";
import { describe, it } from "node:test";

// Import types and formatting functions (unit-testable without DB)
import {
	type ProposalOscillationResult,
	type OscillationAlert,
	formatOscillationAlerts,
} from "../../src/core/dag/dag-health.ts";

describe("dag-health: OscillationAlert structure", () => {
	it("should represent a warning-level alert correctly", () => {
		const alert: OscillationAlert = {
			severity: "warning",
			message: "Proposal P045 oscillates between Review↔Building (3 cycles, threshold: 3)",
			proposalId: 45,
			displayId: "P045",
			cycleCount: 3,
			threshold: 3,
		};
		assert.strictEqual(alert.severity, "warning");
		assert.strictEqual(alert.proposalId, 45);
		assert.strictEqual(alert.displayId, "P045");
		assert.strictEqual(alert.cycleCount, 3);
		assert.strictEqual(alert.threshold, 3);
	});

	it("should represent a critical-level alert correctly", () => {
		const alert: OscillationAlert = {
			severity: "critical",
			message: "Proposal P046 oscillates between Review↔Building (8 cycles, threshold: 3)",
			proposalId: 46,
			displayId: "P046",
			cycleCount: 8,
			threshold: 3,
		};
		assert.strictEqual(alert.severity, "critical");
		assert.strictEqual(alert.cycleCount, 8);
	});
});

describe("dag-health: ProposalOscillationResult structure", () => {
	it("should represent oscillation correctly", () => {
		const result: ProposalOscillationResult = {
			proposalId: 45,
			displayId: "P045",
			oscillationCount: 6,
			isOscillating: true,
			transitionPattern: [
				"Review→DEVELOP",
				"DEVELOP→Review",
				"Review→DEVELOP",
				"DEVELOP→Review",
				"Review→DEVELOP",
				"DEVELOP→Review",
			],
			timestamps: [
				"2026-04-08T01:00:00.000Z",
				"2026-04-08T02:00:00.000Z",
				"2026-04-08T03:00:00.000Z",
				"2026-04-08T04:00:00.000Z",
				"2026-04-08T05:00:00.000Z",
				"2026-04-08T06:00:00.000Z",
			],
			cycleCount: 3,
		};
		assert.strictEqual(result.isOscillating, true);
		assert.strictEqual(result.cycleCount, 3);
		assert.strictEqual(result.transitionPattern.length, 6);
	});

	it("should represent non-oscillation correctly", () => {
		const result: ProposalOscillationResult = {
			proposalId: 45,
			displayId: "P045",
			oscillationCount: 0,
			isOscillating: false,
			transitionPattern: [],
			timestamps: [],
			cycleCount: 0,
		};
		assert.strictEqual(result.isOscillating, false);
		assert.strictEqual(result.cycleCount, 0);
	});
});

describe("dag-health: formatOscillationAlerts", () => {
	it("should format no alerts correctly", () => {
		const formatted = formatOscillationAlerts([]);
		assert.ok(formatted.includes("✅"));
		assert.ok(formatted.includes("No"));
	});

	it("should format warning alerts with yellow circle", () => {
		const alerts: OscillationAlert[] = [
			{
				severity: "warning",
				message: "test",
				proposalId: 45,
				displayId: "P045",
				cycleCount: 3,
				threshold: 3,
			},
		];
		const formatted = formatOscillationAlerts(alerts);
		assert.ok(formatted.includes("⚠️"));
		assert.ok(formatted.includes("🟡"));
		assert.ok(formatted.includes("P045"));
		assert.ok(formatted.includes("3 cycles"));
	});

	it("should format critical alerts with red circle", () => {
		const alerts: OscillationAlert[] = [
			{
				severity: "critical",
				message: "test",
				proposalId: 46,
				displayId: "P046",
				cycleCount: 10,
				threshold: 3,
			},
		];
		const formatted = formatOscillationAlerts(alerts);
		assert.ok(formatted.includes("🔴"));
		assert.ok(formatted.includes("P046"));
		assert.ok(formatted.includes("10 cycles"));
	});

	it("should format multiple alerts", () => {
		const alerts: OscillationAlert[] = [
			{
				severity: "warning",
				message: "test1",
				proposalId: 45,
				displayId: "P045",
				cycleCount: 3,
				threshold: 3,
			},
			{
				severity: "critical",
				message: "test2",
				proposalId: 46,
				displayId: "P046",
				cycleCount: 5,
				threshold: 3,
			},
		];
		const formatted = formatOscillationAlerts(alerts);
		assert.ok(formatted.includes("2 proposal(s)"));
		assert.ok(formatted.includes("P045"));
		assert.ok(formatted.includes("P046"));
	});
});
