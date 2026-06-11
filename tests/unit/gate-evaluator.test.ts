/**
 * P206 Gate Evaluator Tests
 *
 * AC-8: Test gate-evaluator.test.ts with evaluate() returning GateDecision
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	GateEvaluatorAgent,
	runGateEvaluation,
	type GateTaskRequest,
} from "../../src/apps/cubic-agents/gate-evaluator.ts";
import type { GateDecision, ProposalBrief, GateBrief } from "../../src/core/gate/evaluator.ts";

// ─── Mock Query Function ─────────────────────────────────────────────────────

class MockQueryStore {
	proposals: Map<
		number,
		{
			id: number;
			display_id: string;
			title: string;
			status: string;
			workflow_name: string;
			maturity: string;
		}
	> = new Map();

	dependencies: Map<
		number,
		{ from_proposal_id: number; resolved: boolean }[]
	> = new Map();

	acceptanceCriteria: Map<
		number,
		{ proposal_id: number; status: string }[]
	> = new Map();

	decisions: Array<{
		proposal_id: number;
		gate: string;
		verdict: string;
		reason: string;
	}> = [];

	transitioned: Map<number, string> = new Map();

	async query<T = any>(sql: string, params: any[] = []): Promise<{ rows: T[] }> {
		// Mock proposal fetch
		if (sql.includes("SELECT id, display_id, title, status")) {
			const id = params[0];
			const proposal = this.proposals.get(id);
			return {
				rows: proposal ? ([proposal] as T[]) : ([] as T[]),
			};
		}

		// Mock dependency check
		if (sql.includes("proposal_dependencies") && sql.includes("resolved = false")) {
			const id = params[0];
			const deps = this.dependencies.get(id) || [];
			const unresolvedCount = deps.filter((d) => !d.resolved).length;
			return {
				rows: [{ count: String(unresolvedCount) }] as T[],
			};
		}

		// Mock AC check
		if (sql.includes("proposal_acceptance_criteria")) {
			const id = params[0];
			const criteria = this.acceptanceCriteria.get(id) || [];
			const total = criteria.length;
			const passed = criteria.filter((c) => c.status === "pass").length;
			const failed = criteria.filter((c) => c.status === "fail").length;
			return {
				rows: [{ total: String(total), passed: String(passed), failed: String(failed) }] as T[],
			};
		}

		// Mock gate decision insert
		if (sql.includes("INSERT INTO roadmap_proposal.gate_decision_log")) {
			this.decisions.push({
				proposal_id: params[0],
				gate: params[3],
				verdict: params[4],
				reason: params[5],
			});
			return { rows: [] as T[] };
		}

		// Mock proposal transition
		if (sql.includes("UPDATE roadmap_proposal.proposal")) {
			// P740 (HF-C): UPDATE statements that bump maturity should also
			// record the new value so subsequent SELECT maturity sees it.
			// P778: Handle obsoleted_reason in setMaturityObsolete:
			//   UPDATE ... SET maturity = 'obsolete', obsoleted_reason = $2, ... WHERE id = $3
			if (sql.includes("SET maturity")) {
				if (sql.includes("obsoleted_reason")) {
					// setMaturityObsolete case: maturity is always 'obsolete', id is param 2
					const id = params[2];
					const proposal = this.proposals.get(id);
					if (proposal) proposal.maturity = "obsolete";
				} else {
					// Regular setMaturity case: id is param 2
					const newMaturity = params[1];
					const id = params[2];
					const proposal = this.proposals.get(id);
					if (proposal) proposal.maturity = newMaturity;
				}
			}
			return { rows: [] as T[] };
		}

		// P740 (HF-C): assertStatusAdvanced re-reads after transition.
		if (sql.includes("SELECT status FROM roadmap_proposal.proposal")) {
			const id = params[0];
			const transitioned = this.transitioned.get(id);
			const proposal = this.proposals.get(id);
			const status = transitioned ?? proposal?.status ?? null;
			return { rows: status ? [{ status }] as T[] : [] };
		}

		// P740 (HF-C): assertMaturityDemoted re-reads after setMaturity.
		if (sql.includes("SELECT maturity FROM roadmap_proposal.proposal")) {
			const id = params[0];
			const proposal = this.proposals.get(id);
			return { rows: proposal ? [{ maturity: proposal.maturity }] as T[] : [] };
		}

		// P740 (HF-C): discussion insert from setMaturity is best-effort.
		if (sql.includes("INSERT INTO roadmap_proposal.proposal_discussions")) {
			return { rows: [] as T[] };
		}

		// Mock version insert
		if (sql.includes("INSERT INTO proposal_version")) {
			return { rows: [] as T[] };
		}

		// Default
		return { rows: [] as T[] };
	}
}

let mockStore: MockQueryStore;

beforeEach(() => {
	mockStore = new MockQueryStore();

	// Setup test proposal
	mockStore.proposals.set(1, {
		id: 1,
		display_id: "P123",
		title: "Test Proposal",
		status: "DRAFT",
		workflow_name: "Standard RFC",
		maturity: "mature",
	});
});

afterEach(() => {
	mockStore.decisions = [];
});

describe("GateEvaluatorAgent", () => {
	const mockTransition = async (id: number, newStatus: string) => {
		mockStore.transitioned.set(id, newStatus);
	};

	describe("AC-6: check can_promote before evaluating", () => {
		it("rejects proposal with unresolved dependencies", async () => {
			// Setup: proposal with unresolved dependency
			mockStore.dependencies.set(1, [{ from_proposal_id: 1, resolved: false }]);
			mockStore.acceptanceCriteria.set(1, []);

			const agent = new GateEvaluatorAgent(
				mockStore.query.bind(mockStore) as any,
				1,
				"D1",
				mockTransition as any,
			);

			const proposal: ProposalBrief = {
				id: 1,
				display_id: "P123",
				title: "Test",
				status: "DRAFT",
			};

			const gate: GateBrief = {
				name: "D1",
				from_state: "DRAFT",
				to_state: "REVIEW",
				requires_ac: false,
			};

			const decision = await agent.evaluate(proposal, gate);

			assert.strictEqual(
				decision.verdict,
				"reject",
				"Should reject due to unresolved dependencies",
			);
			assert.ok(
				decision.reason.includes("Unresolved"),
				"Reason should mention unresolved dependencies",
			);
		});

		it("approves proposal with all dependencies resolved", async () => {
			// Setup: no dependencies and no ACs (D1 doesn't require ACs)
			mockStore.dependencies.set(1, []);
			mockStore.acceptanceCriteria.set(1, []);

			const agent = new GateEvaluatorAgent(
				mockStore.query.bind(mockStore) as any,
				1,
				"D1",
				mockTransition as any,
			);

			const proposal: ProposalBrief = {
				id: 1,
				display_id: "P123",
				title: "Test",
				status: "DRAFT",
			};

			const gate: GateBrief = {
				name: "D1",
				from_state: "DRAFT",
				to_state: "REVIEW",
				requires_ac: false,
			};

			const decision = await agent.evaluate(proposal, gate);

			assert.strictEqual(
				decision.verdict,
				"approve",
				"Should approve when dependencies resolved",
			);
		});
	});

	describe("AC-5/6: AC verification and auto-transition", () => {
		it("rejects when required ACs fail", async () => {
			// Setup: proposal with failed ACs
			mockStore.dependencies.set(1, []);
			mockStore.acceptanceCriteria.set(1, [
				{ proposal_id: 1, status: "pass" },
				{ proposal_id: 1, status: "fail" },
			]);

			const agent = new GateEvaluatorAgent(
				mockStore.query.bind(mockStore) as any,
				1,
				"D2",
				mockTransition as any,
			);

			const proposal: ProposalBrief = {
				id: 1,
				display_id: "P123",
				title: "Test",
				status: "REVIEW",
			};

			const gate: GateBrief = {
				name: "D2",
				from_state: "REVIEW",
				to_state: "DEVELOP",
				requires_ac: true, // D2 requires AC
			};

			const decision = await agent.evaluate(proposal, gate);

			assert.strictEqual(decision.verdict, "reject", "Should reject due to failed ACs");
			assert.ok(decision.reason.includes("Failed"), "Reason should mention failed ACs");
		});

		it("approves when all required ACs pass", async () => {
			// Setup: proposal with all ACs passing
			mockStore.dependencies.set(1, []);
			mockStore.acceptanceCriteria.set(1, [
				{ proposal_id: 1, status: "pass" },
				{ proposal_id: 1, status: "pass" },
				{ proposal_id: 1, status: "pass" },
			]);

			const agent = new GateEvaluatorAgent(
				mockStore.query.bind(mockStore) as any,
				1,
				"D2",
				mockTransition as any,
			);

			const proposal: ProposalBrief = {
				id: 1,
				display_id: "P123",
				title: "Test",
				status: "REVIEW",
			};

			const gate: GateBrief = {
				name: "D2",
				from_state: "REVIEW",
				to_state: "DEVELOP",
				requires_ac: true,
			};

			const decision = await agent.evaluate(proposal, gate);

			assert.strictEqual(decision.verdict, "approve", "Should approve when all ACs pass");
			assert.ok(
				decision.reason.includes("AC pass rate"),
				"Reason should show AC pass rate",
			);
		});
	});

	describe("AC-5: gate_decision_log recording", () => {
		it("records approve verdict", async () => {
			mockStore.dependencies.set(1, []);
			mockStore.acceptanceCriteria.set(1, []);

			const agent = new GateEvaluatorAgent(
				mockStore.query.bind(mockStore) as any,
				1,
				"D1",
			);

			const proposal: ProposalBrief = {
				id: 1,
				display_id: "P123",
				title: "Test",
				status: "DRAFT",
			};

			const gate: GateBrief = {
				name: "D1",
				from_state: "DRAFT",
				to_state: "REVIEW",
				requires_ac: false,
			};

			await agent.evaluate(proposal, gate);

			assert.strictEqual(
				mockStore.decisions.length,
				1,
				"Should record one decision",
			);
			assert.strictEqual(
				mockStore.decisions[0].verdict,
				"approve",
				"Recorded verdict should be approve",
			);
			assert.strictEqual(
				mockStore.decisions[0].gate,
				"D1",
				"Recorded gate should be D1",
			);
		});

		it("records reject verdict", async () => {
			mockStore.dependencies.set(1, [{ from_proposal_id: 1, resolved: false }]);

			const agent = new GateEvaluatorAgent(
				mockStore.query.bind(mockStore) as any,
				1,
				"D1",
			);

			const proposal: ProposalBrief = {
				id: 1,
				display_id: "P123",
				title: "Test",
				status: "DRAFT",
			};

			const gate: GateBrief = {
				name: "D1",
				from_state: "DRAFT",
				to_state: "REVIEW",
				requires_ac: false,
			};

			await agent.evaluate(proposal, gate);

			assert.strictEqual(
				mockStore.decisions[0].verdict,
				"reject",
				"Recorded verdict should be reject",
			);
		});
	});

	describe("runGateEvaluation factory function", () => {
		it("runs gate evaluation from task request", async () => {
			mockStore.dependencies.set(1, []);
			mockStore.acceptanceCriteria.set(1, []);

			const request: GateTaskRequest = {
				proposal_id: 1,
				gate_name: "D1",
				from_state: "DRAFT",
				to_state: "REVIEW",
			};

			const decision = await runGateEvaluation(
				request,
				mockStore.query.bind(mockStore) as any,
			);

			assert.strictEqual(decision.verdict, "approve");
		});

		it("raises error for missing proposal", async () => {
			const request: GateTaskRequest = {
				proposal_id: 999,
				gate_name: "D1",
				from_state: "DRAFT",
				to_state: "REVIEW",
			};

			try {
				await runGateEvaluation(
					request,
					mockStore.query.bind(mockStore) as any,
				);
				assert.fail("Should have raised an error");
			} catch (err: any) {
				assert.ok(
					err.message.includes("not found"),
					"Error should mention proposal not found",
				);
			}
		});
	});

	describe("P778 AC-8 & AC-9: Closure verdicts (wontfix, discard, replace, escalate, nonissue)", () => {
		it("applies reject closure verdict: sets maturity=obsolete, status unchanged", async () => {
			// Setup: proposal at DRAFT with mature maturity
			mockStore.dependencies.set(1, []);
			mockStore.acceptanceCriteria.set(1, []);
			mockStore.proposals.set(1, {
				id: 1,
				display_id: "P123",
				title: "Test",
				status: "DRAFT",
				workflow_name: "Standard RFC",
				maturity: "mature",
			});

			const agent = new GateEvaluatorAgent(
				mockStore.query.bind(mockStore) as any,
				1,
				"D1",
				mockTransition as any,
			);

			const proposal: ProposalBrief = {
				id: 1,
				display_id: "P123",
				title: "Test",
				status: "DRAFT",
			};

			const gate: GateBrief = {
				name: "D1",
				from_state: "DRAFT",
				to_state: "REVIEW",
				requires_ac: false,
			};

			// Manually apply a reject verdict (closure verdict)
			const decision: GateDecision = {
				verdict: "reject",
				reason: "Not ready for review",
			};

			await agent["applyVerdict"](proposal, gate, decision);

			// Verify maturity was set to obsolete
			const proposalAfter = mockStore.proposals.get(1);
			assert.strictEqual(proposalAfter?.maturity, "obsolete", "Maturity should be obsolete");
			// Verify status was NOT changed
			assert.strictEqual(proposalAfter?.status, "DRAFT", "Status should remain unchanged");
		});

		it("applies wontfix closure verdict: sets maturity=obsolete", async () => {
			mockStore.dependencies.set(1, []);
			mockStore.acceptanceCriteria.set(1, []);
			mockStore.proposals.set(1, {
				id: 1,
				display_id: "P456",
				title: "Test2",
				status: "REVIEW",
				workflow_name: "Standard RFC",
				maturity: "mature",
			});

			const agent = new GateEvaluatorAgent(
				mockStore.query.bind(mockStore) as any,
				1,
				"D2",
				mockTransition as any,
			);

			const proposal: ProposalBrief = {
				id: 1,
				display_id: "P456",
				title: "Test2",
				status: "REVIEW",
			};

			const gate: GateBrief = {
				name: "D2",
				from_state: "REVIEW",
				to_state: "DEVELOP",
				requires_ac: false,
			};

			const decision: GateDecision = {
				verdict: "wontfix",
				reason: "Superseded by P789",
			};

			await agent["applyVerdict"](proposal, gate, decision);

			// Verify maturity is obsolete
			const proposalAfter = mockStore.proposals.get(1);
			assert.strictEqual(proposalAfter?.maturity, "obsolete", "Maturity should be obsolete");
			// Verify status unchanged
			assert.strictEqual(proposalAfter?.status, "REVIEW", "Status should remain REVIEW");
		});

		it("records closure verdict in gate_decision_log", async () => {
			mockStore.dependencies.set(1, []);
			mockStore.acceptanceCriteria.set(1, []);
			mockStore.proposals.set(1, {
				id: 1,
				display_id: "P999",
				title: "Test4",
				status: "DRAFT",
				workflow_name: "Standard RFC",
				maturity: "mature",
			});

			const agent = new GateEvaluatorAgent(
				mockStore.query.bind(mockStore) as any,
				1,
				"D1",
			);

			const proposal: ProposalBrief = {
				id: 1,
				display_id: "P999",
				title: "Test4",
				status: "DRAFT",
			};

			const gate: GateBrief = {
				name: "D1",
				from_state: "DRAFT",
				to_state: "REVIEW",
				requires_ac: false,
			};

			// Manually invoke recordGateDecision for a closure verdict
			const decision: GateDecision = {
				verdict: "replace",
				reason: "Replaced by P888",
			};

			await agent["recordGateDecision"](proposal, gate, decision);

			// Verify decision was logged
			assert.strictEqual(
				mockStore.decisions.length,
				1,
				"Should record one decision",
			);
			const logged = mockStore.decisions[0];
			assert.strictEqual(logged.verdict, "replace", "Verdict should be 'replace'");
			assert.strictEqual(logged.gate, "D1", "Gate should be D1");
		});
	});
});

describe("P206 Acceptance Criteria", () => {
	it("AC-4: GateEvaluatorAgent.evaluate() returns GateDecision", async () => {
		mockStore.dependencies.set(1, []);
		mockStore.acceptanceCriteria.set(1, []);

		const agent = new GateEvaluatorAgent(
			mockStore.query.bind(mockStore) as any,
			1,
			"D1",
		);

		const proposal: ProposalBrief = {
			id: 1,
			display_id: "P123",
			title: "Test",
			status: "DRAFT",
		};

		const gate: GateBrief = {
			name: "D1",
			from_state: "DRAFT",
			to_state: "REVIEW",
			requires_ac: false,
		};

		const decision = await agent.evaluate(proposal, gate);

		// Verify GateDecision structure
		assert.ok(decision.verdict, "Should have verdict");
		assert.ok(
			["approve", "reject", "abstain"].includes(decision.verdict),
			"Verdict should be approve/reject/abstain",
		);
		assert.ok(decision.reason, "Should have reason");
	});

	it("AC-7: On approval, proposal.status updated in gate_decision_log", async () => {
		mockStore.dependencies.set(1, []);
		mockStore.acceptanceCriteria.set(1, []);

		const agent = new GateEvaluatorAgent(
			mockStore.query.bind(mockStore) as any,
			1,
			"D1",
		);

		const proposal: ProposalBrief = {
			id: 1,
			display_id: "P123",
			title: "Test",
			status: "DRAFT",
		};

		const gate: GateBrief = {
			name: "D1",
			from_state: "DRAFT",
			to_state: "REVIEW",
			requires_ac: false,
		};

		await agent.evaluate(proposal, gate);

		// Verify decision was recorded
		assert.ok(mockStore.decisions.length > 0, "Should record decision");
		const recorded = mockStore.decisions[0];
		assert.strictEqual(recorded.verdict, "approve");
		assert.strictEqual(recorded.gate, "D1");
	});

});
