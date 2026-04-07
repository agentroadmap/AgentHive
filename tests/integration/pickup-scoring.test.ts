import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	type AgentProfile,
	computeCapabilityFit,
	computeCostEfficiency,
	computeDifficultyMatch,
	computeImportanceWeight,
	computeLoadBalance,
	computePerformanceBonus,
	inferDifficulty,
	optimalAssignment,
	type ScorableProposal,
	scoreProposal,
	scoreProposals,
} from "../../src/core/orchestration/pickup-scorer.ts";

// Test fixtures
const opusAgent: AgentProfile = {
	name: "Opus",
	capabilities: [
		"typescript",
		"testing",
		"code-review",
		"mcp",
		"high-reasoning",
	],
	costClass: "high",
	availability: "active",
	currentLoad: 0,
};

const haikuAgent: AgentProfile = {
	name: "Haiku",
	capabilities: ["typescript", "testing"],
	costClass: "low",
	availability: "active",
	currentLoad: 0,
};

const _midAgent: AgentProfile = {
	name: "Mid",
	capabilities: ["typescript", "mcp", "cli"],
	costClass: "medium",
	availability: "active",
	currentLoad: 1,
};

const hardProposal: ScorableProposal = {
	id: "proposal-6",
	title: "Resource-Aware Pickup Scoring",
	priority: "high",
	labels: ["core"],
	requires: [
		{ cost_class: "medium", capability: "high-reasoning", difficulty: "hard" },
	],
	acceptanceCriteriaCount: 10,
	dependencyDepth: 3,
	downstreamCount: 5,
};

const easyProposal: ScorableProposal = {
	id: "proposal-32",
	title: "DAG Visualization",
	priority: "medium",
	labels: ["visualization", "tooling"],
	requires: [],
	acceptanceCriteriaCount: 6,
	dependencyDepth: 1,
	downstreamCount: 0,
};

const lowPriorityProposal: ScorableProposal = {
	id: "proposal-11",
	title: "Scout/Map Proposal Loop",
	priority: "low",
	labels: ["research"],
	requires: [],
	acceptanceCriteriaCount: 3,
	dependencyDepth: 0,
	downstreamCount: 2,
};

describe("Pickup Scorer", () => {
	describe("computeCapabilityFit", () => {
		test("returns 1.0 when no requirements", () => {
			const proposal: ScorableProposal = {
				...easyProposal,
				requires: [],
				needs_capabilities: [],
			};
			assert.equal(computeCapabilityFit(haikuAgent, proposal), 1.0);
		});

		test("returns 1.0 when all requirements met", () => {
			const proposal: ScorableProposal = {
				...easyProposal,
				needs_capabilities: ["typescript", "testing"],
			};
			assert.equal(computeCapabilityFit(haikuAgent, proposal), 1.0);
		});

		test("returns 0.5 when half requirements met", () => {
			const proposal: ScorableProposal = {
				...easyProposal,
				needs_capabilities: ["typescript", "nonexistent"],
			};
			assert.equal(computeCapabilityFit(haikuAgent, proposal), 0.5);
		});

		test("returns 0 when no requirements met", () => {
			const proposal: ScorableProposal = {
				...easyProposal,
				needs_capabilities: ["rust", "go"],
			};
			assert.equal(computeCapabilityFit(haikuAgent, proposal), 0);
		});
	});

	describe("computeCostEfficiency", () => {
		test("high-priority proposal prefers high-cost agent", () => {
			const highScore = computeCostEfficiency(opusAgent, hardProposal);
			const lowScore = computeCostEfficiency(haikuAgent, hardProposal);
			assert.ok(
				highScore > lowScore,
				"high-cost agent should score higher for high-priority",
			);
		});

		test("low-priority proposal prefers cost-efficient agent", () => {
			const highScore = computeCostEfficiency(opusAgent, lowPriorityProposal);
			const lowScore = computeCostEfficiency(haikuAgent, lowPriorityProposal);
			assert.ok(
				lowScore > highScore,
				"low-cost agent should score higher for low-priority",
			);
		});

		test("returns 0 when agent below minimum cost requirement", () => {
			const proposal: ScorableProposal = {
				...hardProposal,
				requires: [{ cost_class: "high" }],
			};
			assert.equal(computeCostEfficiency(haikuAgent, proposal), 0);
		});
	});

	describe("computeDifficultyMatch", () => {
		test("high-difficulty proposal matches high-cost agent", () => {
			const score = computeDifficultyMatch(opusAgent, hardProposal);
			assert.ok(score >= 0.6, "high-cost agent should match hard difficulty");
		});

		test("easy proposal matches low-cost agent", () => {
			const score = computeDifficultyMatch(haikuAgent, easyProposal);
			assert.ok(score >= 0.6, "low-cost agent should match easy difficulty");
		});

		test("mismatched difficulty reduces score", () => {
			const score = computeDifficultyMatch(haikuAgent, hardProposal);
			assert.ok(
				score < 0.6,
				"low-cost agent should not match hard difficulty well",
			);
		});
	});

	describe("computeImportanceWeight", () => {
		test("high-priority proposals get higher weight", () => {
			const highWeight = computeImportanceWeight(hardProposal);
			const lowWeight = computeImportanceWeight(lowPriorityProposal);
			assert.ok(
				highWeight > lowWeight,
				"high-priority should have higher weight",
			);
		});

		test("proposals with more dependents get higher weight", () => {
			const proposal1: ScorableProposal = {
				...easyProposal,
				downstreamCount: 0,
			};
			const proposal2: ScorableProposal = {
				...easyProposal,
				downstreamCount: 10,
			};
			assert.ok(
				computeImportanceWeight(proposal2) > computeImportanceWeight(proposal1),
			);
		});
	});

	describe("computeLoadBalance", () => {
		test("idle agent gets higher score", () => {
			const idleScore = computeLoadBalance({ ...haikuAgent, currentLoad: 0 });
			const busyScore = computeLoadBalance({ ...haikuAgent, currentLoad: 3 });
			assert.ok(idleScore > busyScore, "idle agent should score higher");
		});

		test("load 0 returns 1.0", () => {
			assert.equal(computeLoadBalance({ ...haikuAgent, currentLoad: 0 }), 1.0);
		});
	});

	describe("computePerformanceBonus", () => {
		test("no history returns 1.0", () => {
			const agent: AgentProfile = {
				...haikuAgent,
				completionHistory: undefined,
			};
			assert.equal(computePerformanceBonus(agent, easyProposal), 1.0);
		});

		test("relevant experience gives bonus", () => {
			const agent: AgentProfile = {
				...haikuAgent,
				completionHistory: { visualization: 5, tooling: 3, core: 1 },
			};
			const bonus = computePerformanceBonus(agent, easyProposal);
			assert.ok(bonus > 1.0, "relevant experience should give bonus");
			assert.ok(bonus <= 1.5, "bonus should be capped");
		});
	});

	describe("scoreProposal", () => {
		test("returns valid breakdown with all axes", () => {
			const breakdown = scoreProposal(opusAgent, hardProposal);
			assert.ok(breakdown.capability_fit >= 0 && breakdown.capability_fit <= 1);
			assert.ok(
				breakdown.cost_efficiency >= 0 && breakdown.cost_efficiency <= 1,
			);
			assert.ok(
				breakdown.difficulty_match >= 0 && breakdown.difficulty_match <= 1,
			);
			assert.ok(breakdown.importance_weight > 0);
			assert.ok(breakdown.load_balance > 0);
			assert.ok(breakdown.total > 0);
			assert.ok(typeof breakdown.explanation === "string");
		});

		test("capability mismatch results in low score", () => {
			const agent: AgentProfile = { ...haikuAgent, capabilities: [] };
			const breakdown = scoreProposal(agent, hardProposal);
			assert.equal(breakdown.capability_fit, 0);
			assert.equal(breakdown.total, 0);
		});
	});

	describe("scoreProposals", () => {
		test("returns sorted results by score", () => {
			const results = scoreProposals(opusAgent, [
				easyProposal,
				hardProposal,
				lowPriorityProposal,
			]);
			assert.equal(results.length, 3);
			// Scores should be descending
			for (let i = 1; i < results.length; i++) {
				assert.ok(
					results[i - 1]?.score.total >= results[i]?.score.total,
					"should be sorted descending",
				);
			}
		});
	});

	describe("optimalAssignment", () => {
		test("assigns each proposal to one agent", () => {
			const agents = [opusAgent, haikuAgent];
			const proposals = [hardProposal, easyProposal];
			const assignments = optimalAssignment(agents, proposals);

			assert.equal(assignments.size, 2);
			const assignedAgents = [...assignments.values()].map((a) => a.agent);
			assert.equal(
				new Set(assignedAgents).size,
				2,
				"each agent should get one proposal",
			);
		});

		test("skips offline agents", () => {
			const agents = [
				{ ...opusAgent, availability: "offline" as const },
				haikuAgent,
			];
			const proposals = [hardProposal];
			const assignments = optimalAssignment(agents, proposals);

			assert.equal(assignments.size, 1);
			assert.equal([...assignments.values()][0]?.agent, "Haiku");
		});

		test("high-difficulty proposal goes to capable agent", () => {
			const agents = [opusAgent, haikuAgent];
			const proposals = [hardProposal];
			const assignments = optimalAssignment(agents, proposals);

			// Opus should get the hard proposal
			assert.equal([...assignments.values()][0]?.agent, "Opus");
		});

		test("easy proposal goes to best overall match", () => {
			const agents = [opusAgent, haikuAgent];
			const proposals = [easyProposal];
			const assignments = optimalAssignment(agents, proposals);

			// Should assign to best scoring agent (both fit, but Opus has higher overall score)
			assert.ok(
				assignments.has("proposal-32"),
				"should assign the easy proposal",
			);
			const assignment = [...assignments.values()][0]!;
			assert.ok(
				["Opus", "Haiku"].includes(assignment.agent),
				"should assign to a capable agent",
			);
			assert.ok(assignment.score.total > 0, "should have positive score");
		});
	});

	describe("inferDifficulty", () => {
		test("uses explicit difficulty when provided", () => {
			const proposal: ScorableProposal = {
				...easyProposal,
				requires: [{ difficulty: "hard" }],
			};
			assert.equal(inferDifficulty(proposal), "hard");
		});

		test("infers from AC count and depth", () => {
			const easy: ScorableProposal = {
				...easyProposal,
				acceptanceCriteriaCount: 1,
				dependencyDepth: 0,
			};
			const hard: ScorableProposal = {
				...easyProposal,
				acceptanceCriteriaCount: 10,
				dependencyDepth: 5,
			};

			assert.equal(inferDifficulty(easy), "easy");
			assert.equal(inferDifficulty(hard), "hard");
		});
	});
});
