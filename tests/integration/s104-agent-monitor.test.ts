/**
 * S104 Tests: Agent Activity Monitoring & Anomaly Detection
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type AgentEvent,
	checkDuplicates,
	checkProposalCount,
	checkRateLimit,
} from "../../src/core/identity/agent-monitor/index.ts";

describe("S104: Agent Activity Monitoring", () => {
	// AC#1: Proposal count monitor
	describe("checkProposalCount", () => {
		it("should return null when under 150", () => {
			assert.equal(checkProposalCount(100), null);
		});

		it("should warn at 151", () => {
			const alert = checkProposalCount(151);
			assert.equal(alert?.severity, "warn");
		});

		it("should critical at 201", () => {
			const alert = checkProposalCount(201);
			assert.equal(alert?.severity, "critical");
		});
	});

	// AC#2: Rate limiter
	describe("checkRateLimit", () => {
		it("should allow normal rate", () => {
			const events: AgentEvent[] = Array(5)
				.fill(null)
				.map((_, i) => ({
					agent_id: "test-agent",
					action: "create" as const,
					proposal_id: `S${i}`,
					timestamp: Date.now() - i * 60000,
				}));
			assert.equal(checkRateLimit(events, "test-agent"), null);
		});

		it("should flag rate >10/hour", () => {
			const events: AgentEvent[] = Array(12)
				.fill(null)
				.map((_, i) => ({
					agent_id: "test-agent",
					action: "create" as const,
					proposal_id: `S${i}`,
					timestamp: Date.now() - i * 60000,
				}));
			const alert = checkRateLimit(events, "test-agent");
			assert.equal(alert?.type, "rate_limit");
		});
	});

	// AC#3: Duplication detector
	describe("checkDuplicates", () => {
		it("should return null when no duplicates", () => {
			const proposals = [
				{ title: "Feature A", created_at: Date.now() - 1000 },
				{ title: "Feature B", created_at: Date.now() - 2000 },
			];
			assert.equal(checkDuplicates(proposals, "test"), null);
		});

		it("should flag 3+ duplicates", () => {
			const proposals = [
				{ title: "Same Feature", created_at: Date.now() - 1000 },
				{ title: "Same Feature", created_at: Date.now() - 2000 },
				{ title: "Same Feature", created_at: Date.now() - 3000 },
			];
			const alert = checkDuplicates(proposals, "test");
			assert.equal(alert?.type, "duplicate");
		});
	});
});
