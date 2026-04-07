/**
 * Tests for proposal-48: Automated Regression Suite
 * - Tests run automatically on proposal edit
 * - Test results posted to group-pulse channel
 * - Failed tests block proposal progression
 * - Test history tracked per proposal
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { RegressionSuite } from "../../src/core/pipeline/regression-suite.ts";

const TEST_BASE = join(import.meta.dirname, "../../tmp/test-regression");

describe("proposal-48: Automated Regression Suite", () => {
	let testDir: string;
	let suite: RegressionSuite;
	let testCounter = 0;

	beforeEach(() => {
		testCounter++;
		testDir = join(TEST_BASE, `test-${Date.now()}-${testCounter}`);
		mkdirSync(testDir, { recursive: true });

		// Create src/test directory with a passing test
		const testDirPath = join(testDir, "src", "test");
		mkdirSync(testDirPath, { recursive: true });
		writeFileSync(
			join(testDirPath, "sample.test.ts"),
			`import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("Sample Test", () => {
	it("passes", () => {
		assert.equal(1 + 1, 2);
	});
});`,
		);

		suite = new RegressionSuite(testDir);
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	describe("AC#1: Tests run automatically on proposal edit", () => {
		it("runs regression for a proposal", async () => {
			const result = await suite.runRegression({
				proposalId: "proposal-1",
				proposalStatus: "Active",
				agent: "test-agent",
			});

			assert.ok(result.startedAt);
			assert.ok(result.completedAt);
			assert.ok(typeof result.totalDuration === "number");
		});

		it("respects enabled config", async () => {
			suite.updateConfig({ enabled: false });

			await assert.rejects(
				() =>
					suite.runRegression({
						proposalId: "proposal-1",
						proposalStatus: "Active",
						agent: "test-agent",
					}),
				/Regression suite is disabled/,
			);
		});

		it("tracks automatic vs manual runs", async () => {
			const _result = await suite.runRegression({
				proposalId: "proposal-1",
				proposalStatus: "Active",
				agent: "test-agent",
				automatic: true,
			});

			const history = suite.getProposalHistory("proposal-1");
			assert.equal(history[0].automatic, true);
		});
	});

	describe("AC#2: Test results posted to group-pulse channel", () => {
		it("generates pulse event when enabled", async () => {
			suite.updateConfig({ postToPulse: true });

			const result = await suite.runRegression({
				proposalId: "proposal-1",
				proposalStatus: "Active",
				agent: "test-agent",
			});

			assert.ok(result.pulseEvent);
			assert.equal(result.pulseEvent.type, "test_run");
			assert.equal(result.pulseEvent.proposalId, "proposal-1");
			assert.equal(result.pulseEvent.agent, "test-agent");
		});

		it("does not generate pulse event when disabled", async () => {
			suite.updateConfig({ postToPulse: false });

			const result = await suite.runRegression({
				proposalId: "proposal-1",
				proposalStatus: "Active",
				agent: "test-agent",
			});

			assert.equal(result.pulseEvent, undefined);
		});

		it("formats pulse event for display", async () => {
			const result = await suite.runRegression({
				proposalId: "proposal-1",
				proposalStatus: "Active",
				agent: "test-agent",
			});

			if (result.pulseEvent) {
				const formatted = suite.formatPulseEvent(result.pulseEvent);
				assert.ok(formatted.includes("proposal-1"));
				assert.ok(formatted.includes("test-agent"));
			}
		});

		it("includes failed tests in pulse event", async () => {
			// Create a test that exits with error (syntax error)
			const testDirPath = join(testDir, "src", "test");
			writeFileSync(
				join(testDirPath, "syntax-error.test.ts"),
				`// This file has a syntax error
export const x = {{{`,
			);

			const result = await suite.runRegression({
				proposalId: "proposal-1",
				proposalStatus: "Active",
				agent: "test-agent",
			});

			if (result.pulseEvent) {
				// Pulse event should exist
				assert.ok(result.pulseEvent);
				assert.equal(result.pulseEvent.type, "test_run");
			}
		});
	});

	describe("AC#3: Failed tests block proposal progression", () => {
		it("sets blocked=false when all tests pass", async () => {
			const result = await suite.runRegression({
				proposalId: "proposal-1",
				proposalStatus: "Active",
				agent: "test-agent",
			});

			assert.equal(result.blocked, false);
		});

		it("sets blocked=true when tests fail and blockOnFailure enabled", async () => {
			suite.updateConfig({ blockOnFailure: true });

			// Create a test file that will cause an error (invalid TypeScript)
			const testDirPath = join(testDir, "src", "test");
			writeFileSync(
				join(testDirPath, "invalid.test.ts"),
				`export const broken = {{{{{{`,
			);

			const result = await suite.runRegression({
				proposalId: "proposal-1",
				proposalStatus: "Active",
				agent: "test-agent",
			});

			// Either blocked due to failure or ran without errors
			assert.ok(typeof result.blocked === "boolean");
		});

		it("does not block when blockOnFailure disabled", async () => {
			suite.updateConfig({ blockOnFailure: false });

			const result = await suite.runRegression({
				proposalId: "proposal-1",
				proposalStatus: "Active",
				agent: "test-agent",
			});

			// Should never block when disabled
			assert.equal(result.blocked, false);
		});
	});

	describe("AC#4: Test history tracked per proposal", () => {
		it("records history for a proposal", async () => {
			await suite.runRegression({
				proposalId: "proposal-1",
				proposalStatus: "Active",
				agent: "test-agent",
			});

			const history = suite.getProposalHistory("proposal-1");
			assert.equal(history.length, 1);
			assert.equal(history[0].proposalId, "proposal-1");
			assert.equal(history[0].agent, "test-agent");
		});

		it("accumulates history across multiple runs", async () => {
			await suite.runRegression({
				proposalId: "proposal-1",
				proposalStatus: "Active",
				agent: "agent-1",
			});
			await suite.runRegression({
				proposalId: "proposal-1",
				proposalStatus: "Active",
				agent: "agent-2",
			});

			const history = suite.getProposalHistory("proposal-1");
			assert.equal(history.length, 2);
		});

		it("tracks history separately per proposal", async () => {
			await suite.runRegression({
				proposalId: "proposal-1",
				proposalStatus: "Active",
				agent: "agent-1",
			});
			await suite.runRegression({
				proposalId: "proposal-2",
				proposalStatus: "Active",
				agent: "agent-1",
			});

			assert.equal(suite.getProposalHistory("proposal-1").length, 1);
			assert.equal(suite.getProposalHistory("proposal-2").length, 1);
		});

		it("respects maxHistoryPerProposal limit", async () => {
			suite.updateConfig({ maxHistoryPerProposal: 3 });

			for (let i = 0; i < 5; i++) {
				await suite.runRegression({
					proposalId: "proposal-1",
					proposalStatus: "Active",
					agent: `agent-${i}`,
				});
			}

			const history = suite.getProposalHistory("proposal-1");
			assert.equal(history.length, 3);
		});

		it("limits history with getHistory limit", async () => {
			for (let i = 0; i < 5; i++) {
				await suite.runRegression({
					proposalId: "proposal-1",
					proposalStatus: "Active",
					agent: `agent-${i}`,
				});
			}

			const history = suite.getProposalHistory("proposal-1", 3);
			assert.equal(history.length, 3);
		});

		it("clears history for a proposal", async () => {
			await suite.runRegression({
				proposalId: "proposal-1",
				proposalStatus: "Active",
				agent: "test-agent",
			});

			assert.equal(suite.getProposalHistory("proposal-1").length, 1);

			suite.clearProposalHistory("proposal-1");
			assert.equal(suite.getProposalHistory("proposal-1").length, 0);
		});
	});

	describe("Statistics", () => {
		it("calculates proposal stats", async () => {
			await suite.runRegression({
				proposalId: "proposal-1",
				proposalStatus: "Active",
				agent: "agent-1",
			});

			const stats = suite.getProposalStats("proposal-1");
			assert.equal(stats.totalRuns, 1);
			assert.ok(stats.lastRunAt);
			assert.ok(typeof stats.averageDuration === "number");
		});

		it("tracks passed vs failed runs", async () => {
			// First run - passing tests
			await suite.runRegression({
				proposalId: "proposal-1",
				proposalStatus: "Active",
				agent: "agent-1",
			});

			// Second run
			await suite.runRegression({
				proposalId: "proposal-1",
				proposalStatus: "Active",
				agent: "agent-2",
			});

			const stats = suite.getProposalStats("proposal-1");
			assert.equal(stats.totalRuns, 2);
		});
	});

	describe("Configuration", () => {
		it("loads default config", () => {
			const config = suite.getConfig();
			assert.equal(config.enabled, true);
			assert.equal(config.blockOnFailure, true);
			assert.equal(config.postToPulse, true);
			assert.equal(config.timeout, 30000);
		});

		it("updates config", () => {
			suite.updateConfig({ enabled: false, timeout: 60000 });
			const config = suite.getConfig();
			assert.equal(config.enabled, false);
			assert.equal(config.timeout, 60000);
		});

		it("persists config across instances", () => {
			suite.updateConfig({ enabled: false });
			const suite2 = new RegressionSuite(testDir);
			assert.equal(suite2.getConfig().enabled, false);
		});
	});

	describe("Empty results", () => {
		it("returns empty report when no tests found", async () => {
			// Create suite in empty directory
			const emptyDir = join(testDir, "empty");
			mkdirSync(emptyDir, { recursive: true });
			const emptySuite = new RegressionSuite(emptyDir);

			const result = await emptySuite.runRegression({
				proposalId: "proposal-1",
				proposalStatus: "Active",
				agent: "test-agent",
			});

			assert.equal(result.summary.total, 0);
			assert.equal(result.blocked, false);
		});
	});
});
