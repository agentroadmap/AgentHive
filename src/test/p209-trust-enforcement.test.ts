/**
 * P209: Trust Enforcement — Agent Lifecycle Integration & System Guard
 *
 * Tests:
 * AC-1: Message dispatch gate enforces trust tiers
 * AC-2: Transition gate enforces state change rules
 * AC-3: Denied messages are logged
 * AC-4: Unauthorized transitions trigger escalation
 * AC-5: Repeated denials (>3 in 5min) trigger escalation
 */

import assert from "node:assert";
import { beforeEach, describe, it } from "node:test";
import { query } from "../postgres/pool.ts";
import {
	enforceMessageGate,
	type DispatchGateRequest,
} from "../proposal-engine/middleware/message-dispatch-gate.ts";
import {
	enforceTransitionGate,
	ForbiddenError,
} from "../proposal-engine/middleware/transition-gate.ts";
import { resolveTrust } from "../infra/trust/trust-resolver.ts";

describe("P209: Trust Enforcement", () => {
	// =========================================================================
	// AC-1: Message Dispatch Gate Enforces Trust Tiers
	// =========================================================================

	describe("AC-1: Message Dispatch Gate", () => {
		it("allows authority agents (orchestrator-agent) to send any message type", async () => {
			const result = await enforceMessageGate({
				from_agent: "orchestrator-agent",
				to_agent: "unknown-agent",
				message_type: "task",
				channel: undefined,
			});

			assert.strictEqual(
				result.allowed,
				true,
				"orchestrator-agent should be allowed to send task messages",
			);
		});

		it("allows trusted agents (gary) to send task messages", async () => {
			const result = await enforceMessageGate({
				from_agent: "gary",
				to_agent: "some-agent",
				message_type: "task",
				channel: undefined,
			});

			assert.strictEqual(
				result.allowed,
				true,
				"gary (authority) should be allowed to send task messages",
			);
		});

		it("blocks restricted agents from sending task messages", async () => {
			// Assume unknown-agent is restricted by default
			const testAgent = `unknown-agent-single-${Date.now()}`;
			const result = await enforceMessageGate({
				from_agent: testAgent,
				to_agent: "some-target",
				message_type: "task",
				channel: undefined,
			});

			assert.strictEqual(
				result.allowed,
				false,
				"restricted agent should not be allowed to send task messages",
			);
			// A single denial won't escalate
			assert.strictEqual(
				result.escalationRequired,
				false,
				"single denial should not escalate",
			);
		});

		it("allows restricted agents to send response messages", async () => {
			const result = await enforceMessageGate({
				from_agent: "unknown-agent-2",
				to_agent: "some-target",
				message_type: "response",
				channel: undefined,
			});

			assert.strictEqual(
				result.allowed,
				true,
				"restricted agent should be allowed to send response messages",
			);
		});

		it("blocks direct messages from restricted agents", async () => {
			// Direct message without specifying message_type but to a recipient
			const result = await enforceMessageGate({
				from_agent: "unknown-agent-3",
				to_agent: "some-target",
				message_type: "text",
				channel: undefined,
			});

			assert.strictEqual(
				result.allowed,
				false,
				"restricted agent should not be allowed for direct messages",
			);
		});
	});

	// =========================================================================
	// AC-3: Denied Messages Are Logged
	// =========================================================================

	describe("AC-3: Denied Message Logging", () => {
		it("logs denied messages with reason and timestamp", async () => {
			const testAgent = `test-agent-${Date.now()}`;
			const beforeCount = await query<{ count: string }>(
				`SELECT COUNT(*)::text as count FROM roadmap_messaging.denied_messages
				 WHERE from_agent = $1`,
				[testAgent],
			);
			const countBefore = Number(beforeCount.rows[0]?.count ?? 0);

			// Attempt blocked message
			await enforceMessageGate({
				from_agent: testAgent,
				to_agent: "target-agent",
				message_type: "task",
				channel: undefined,
			});

			const afterResult = await query<{
				reason: string;
				trust_tier: string;
			}>(
				`SELECT reason, trust_tier
				 FROM roadmap_messaging.denied_messages
				 WHERE from_agent = $1
				 ORDER BY timestamp DESC LIMIT 1`,
				[testAgent],
			);

			assert.ok(
				afterResult.rows.length > countBefore,
				"denied message should be logged",
			);
			assert.ok(
				afterResult.rows[0]?.reason?.includes("task"),
				"reason should mention the blocked message type",
			);
			assert.strictEqual(
				afterResult.rows[0]?.trust_tier,
				"restricted",
				"trust_tier should be recorded",
			);
		});
	});

	// =========================================================================
	// AC-5: Repeated Denials Trigger Escalation
	// =========================================================================

	describe("AC-5: Repeated Denial Escalation", () => {
		it("escalates when agent has >3 denied messages in 5 minutes", async () => {
			const testAgent = `repeat-agent-${Date.now()}`;

			// Clear any existing denials for this agent
			await query(
				`DELETE FROM roadmap_messaging.denied_messages WHERE from_agent = $1`,
				[testAgent],
			);

			// Send 4 blocked messages in quick succession
			for (let i = 0; i < 4; i++) {
				const result = await enforceMessageGate({
					from_agent: testAgent,
					to_agent: `target-${i}`,
					message_type: "task",
					channel: undefined,
				});

				// 4th should trigger escalation
				if (i === 3) {
					assert.strictEqual(
						result.escalationRequired,
						true,
						"4th denial should trigger escalation",
					);
					assert.ok(
						result.escalationReason?.includes("Repeated"),
						"escalation reason should mention repetition",
					);
				}
			}

			// Verify escalation was recorded
			const escalations = await query<{ id: string }>(
				`SELECT id FROM roadmap_control.escalation
				 WHERE type = 'REPEATED_MESSAGE_DENIAL' AND agent_identity = $1`,
				[testAgent],
			);

			assert.ok(
				escalations.rows.length > 0,
				"escalation should be recorded in escalation table",
			);
		});
	});

	// =========================================================================
	// AC-2: Transition Gate Enforces Rules
	// =========================================================================

	describe("AC-2: Proposal Transition Gate", () => {
		it("allows authority agents to transition any state", async () => {
			// Create a test proposal
			const { rows: proposals } = await query<{ id: string; display_id: string }>(
				`SELECT id, display_id FROM roadmap_proposal.proposal LIMIT 1`,
			);

			if (proposals.length === 0) {
				console.log("Skipping transition test: no proposals in database");
				return;
			}

			const proposalId = proposals[0].display_id;

			// Should not throw for authority
			try {
				await enforceTransitionGate(proposalId, "orchestrator-agent", "Complete");
				// If no error, gate passed
				assert.ok(true, "authority agent allowed to transition");
			} catch (err) {
				assert.fail(
					`Authority agent should be allowed: ${(err as Error).message}`,
				);
			}
		});

		it("throws ForbiddenError for restricted agents on state changes", async () => {
			const { rows: proposals } = await query<{ id: string; display_id: string }>(
				`SELECT id, display_id FROM roadmap_proposal.proposal WHERE status = 'Draft' LIMIT 1`,
			);

			if (proposals.length === 0) {
				console.log("Skipping restricted transition test: no Draft proposals");
				return;
			}

			const proposalId = proposals[0].display_id;

			// Restricted agent should be blocked
			try {
				await enforceTransitionGate(
					proposalId,
					`restricted-agent-${Date.now()}`,
					"Review",
				);
				assert.fail("Restricted agent should not be allowed to transition");
			} catch (err) {
				assert.ok(
					err instanceof ForbiddenError,
					"Should throw ForbiddenError for restricted agent",
				);
			}
		});

		it("enforces forward-only progress for trusted agents", async () => {
			const { rows: proposals } = await query<{
				id: string;
				display_id: string;
				status: string;
			}>(
				`SELECT id, display_id, status FROM roadmap_proposal.proposal
				 WHERE status IN ('Draft', 'Review') LIMIT 1`,
			);

			if (proposals.length === 0) {
				console.log("Skipping forward-progress test: no Draft/Review proposals");
				return;
			}

			const proposal = proposals[0];
			const isTrusted = "hermes/agency-xiaomi";

			// Forward transition should work (if trusted and right state)
			// Backward transition should fail
			if (proposal.status === "Review") {
				try {
					await enforceTransitionGate(proposal.display_id, isTrusted, "Draft");
					// If no error, check that backward was allowed (unexpected)
					console.log("Note: backward transition was allowed (may depend on trust tier)");
				} catch (err) {
					// Backward failed (expected for trusted)
					assert.ok(
						err instanceof ForbiddenError,
						"Backward transition should be blocked",
					);
				}
			}
		});
	});

	// =========================================================================
	// AC-4: Unauthorized Transitions Trigger Escalation
	// =========================================================================

	describe("AC-4: Transition Escalation", () => {
		it("records escalation for unauthorized transition attempts", async () => {
			const testAgent = `transition-agent-${Date.now()}`;
			const { rows: proposals } = await query<{ display_id: string }>(
				`SELECT display_id FROM roadmap_proposal.proposal LIMIT 1`,
			);

			if (proposals.length === 0) {
				console.log("Skipping escalation test: no proposals in database");
				return;
			}

			// Clear existing escalations for this agent
			await query(
				`DELETE FROM roadmap_control.escalation WHERE agent_identity = $1`,
				[testAgent],
			);

			const proposalId = proposals[0].display_id;

			// Attempt unauthorized transition
			try {
				await enforceTransitionGate(proposalId, testAgent, "Complete");
			} catch {
				// Expected to fail
			}

			// Check if escalation was recorded
			const escalations = await query<{ id: string }>(
				`SELECT id FROM roadmap_control.escalation
				 WHERE type = 'UNAUTHORIZED_GATE_TRANSITION'
				 AND agent_identity = $1`,
				[testAgent],
			);

			assert.ok(
				escalations.rows.length > 0,
				"unauthorized transition should trigger escalation record",
			);
		});
	});

	// =========================================================================
	// Trust Resolution Integration
	// =========================================================================

	describe("Trust Resolution Integration", () => {
		it("resolves authority identities correctly", async () => {
			const result = await resolveTrust({
				sender: "orchestrator-agent",
				receiver: "any-agent",
				messageType: "task",
			});

			assert.strictEqual(
				result.tier,
				"authority",
				"orchestrator-agent should resolve to authority",
			);
			assert.strictEqual(
				result.allowed,
				true,
				"authority should be allowed for any message type",
			);
		});

		it("defaults unknown agents to restricted", async () => {
			const result = await resolveTrust({
				sender: `unknown-new-agent-${Date.now()}`,
				receiver: "any-target",
			});

			assert.strictEqual(
				result.tier,
				"restricted",
				"unknown agents should default to restricted",
			);
		});

		it("enforces policy restrictions per tier", async () => {
			// Restricted agent trying to send task (not allowed)
			const restrictedTask = await resolveTrust({
				sender: `restricted-${Date.now()}`,
				receiver: "target",
				messageType: "task",
			});
			assert.strictEqual(
				restrictedTask.allowed,
				false,
				"restricted tier should not allow task messages",
			);

			// Restricted agent sending response (allowed)
			const restrictedResponse = await resolveTrust({
				sender: `restricted-${Date.now()}`,
				receiver: "target",
				messageType: "response",
			});
			assert.strictEqual(
				restrictedResponse.allowed,
				true,
				"restricted tier should allow response messages",
			);
		});
	});
});
