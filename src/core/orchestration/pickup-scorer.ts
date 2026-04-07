/**
 * Resource-Aware Pickup Scorer
 * Multi-dimensional scoring that matches agents to proposals across five axes:
 * 1. capability_fit - does the agent have the required skills?
 * 2. cost_efficiency - match agent cost class to proposal priority
 * 3. difficulty_match - agent capability tier vs proposal difficulty
 * 4. importance_weight - priority * bottleneck factor
 * 5.load_balance - spread work across available agents
 */

export type CostClass = "low" | "medium" | "high";
export type Difficulty = "easy" | "medium" | "hard";
export type Priority = "high" | "medium" | "low";

export interface AgentProfile {
	name: string;
	capabilities: string[];
	costClass: CostClass;
	availability: "active" | "idle" | "offline";
	currentLoad: number; // number of active claims
	completionHistory?: Record<string, number>; // label -> completion count
}

export interface ProposalRequires {
	cost_class?: CostClass;
	capability?: string;
	difficulty?: Difficulty;
}

export interface ScorableProposal {
	id: string;
	title: string;
	priority?: Priority;
	labels: string[];
	requires?: ProposalRequires[];
	needs_capabilities?: string[];
	acceptanceCriteriaCount: number;
	dependencyDepth: number;
	downstreamCount: number; // number of proposals that depend on this one
}

export interface ScoreBreakdown {
	capability_fit: number;
	cost_efficiency: number;
	difficulty_match: number;
	importance_weight: number;
	load_balance: number;
	total: number;
	explanation: string;
}

export interface ScoredProposal {
	proposal: ScorableProposal;
	score: ScoreBreakdown;
}

const COST_RANK: Record<CostClass, number> = { low: 1, medium: 2, high: 3 };
const DIFFICULTY_RANK: Record<Difficulty, number> = {
	easy: 1,
	medium: 2,
	hard: 3,
};
const PRIORITY_WEIGHT: Record<Priority, number> = {
	high: 1.5,
	medium: 1.0,
	low: 0.7,
};

/**
 * Compute capability fit score.
 * Ratio of agent capabilities that match proposal requirements.
 */
export function computeCapabilityFit(
	agent: AgentProfile,
	proposal: ScorableProposal,
): number {
	const requiredCaps = new Set<string>();

	// From requires field
	for (const req of proposal.requires || []) {
		if (req.capability) requiredCaps.add(req.capability);
	}

	// From needs_capabilities field
	for (const cap of proposal.needs_capabilities || []) {
		requiredCaps.add(cap);
	}

	if (requiredCaps.size === 0) return 1.0; // No requirements = perfect fit

	const agentCaps = new Set(agent.capabilities);
	let matches = 0;
	for (const req of requiredCaps) {
		if (agentCaps.has(req)) matches++;
	}

	return matches / requiredCaps.size;
}

/**
 * Compute cost efficiency score.
 * High-priority proposals prefer high-cost agents; low-priority prefer cost-efficient.
 */
export function computeCostEfficiency(
	agent: AgentProfile,
	proposal: ScorableProposal,
): number {
	const agentCost = COST_RANK[agent.costClass];
	const priority = proposal.priority || "medium";

	// Required cost class from proposal
	const requiredCost = proposal.requires?.find((r) => r.cost_class);
	const minCost = requiredCost ? COST_RANK[requiredCost.cost_class!] : 1;

	// Agent must meet minimum cost requirement
	if (agentCost < minCost) return 0;

	const _priorityWeight = PRIORITY_WEIGHT[priority];

	if (priority === "high") {
		// High priority: prefer high-cost agents (they're more capable)
		return agentCost / 3;
	}
	if (priority === "low") {
		// Low priority: prefer cost-efficient (low-cost) agents
		return (4 - agentCost) / 3;
	}
	// Medium priority: neutral
	return 0.7;
}

/**
 * Compute difficulty match score.
 * Match agent capability tier to proposal difficulty.
 */
export function computeDifficultyMatch(
	agent: AgentProfile,
	proposal: ScorableProposal,
): number {
	// Infer difficulty from proposal properties
	const difficulty = inferDifficulty(proposal);
	const diffRank = DIFFICULTY_RANK[difficulty];

	// Map agent cost class to capability tier (higher cost = higher capability)
	const agentTier = COST_RANK[agent.costClass];

	// Perfect match: agent tier equals difficulty
	const diff = Math.abs(agentTier - diffRank);
	if (diff === 0) return 1.0;
	if (diff === 1) return 0.6;
	return 0.2; // Mismatch
}

/**
 * Infer difficulty from proposal properties.
 */
export function inferDifficulty(proposal: ScorableProposal): Difficulty {
	// Check explicit difficulty in requires
	const explicit = proposal.requires?.find((r) => r.difficulty);
	if (explicit?.difficulty) return explicit.difficulty;

	// Infer from AC count and dependency depth
	const acCount = proposal.acceptanceCriteriaCount;
	const depth = proposal.dependencyDepth;

	const score = acCount * 0.3 + depth * 0.4;
	if (score >= 5) return "hard";
	if (score >= 2) return "medium";
	return "easy";
}

/**
 * Compute importance weight based on priority and bottleneck factor.
 */
export function computeImportanceWeight(proposal: ScorableProposal): number {
	const priorityWeight = PRIORITY_WEIGHT[proposal.priority || "medium"];

	// Bottleneck factor: proposals blocking many others are more important
	const bottleneckFactor = 1 + Math.log2(1 + proposal.downstreamCount);

	return priorityWeight * bottleneckFactor;
}

/**
 * Compute load balance score.
 * Prefer agents with fewer active claims.
 */
export function computeLoadBalance(agent: AgentProfile): number {
	return 1 / (1 + agent.currentLoad);
}

/**
 * Compute performance history bonus.
 * Agents with higher completion rates for similar proposals get a bonus.
 */
export function computePerformanceBonus(
	agent: AgentProfile,
	proposal: ScorableProposal,
): number {
	if (!agent.completionHistory) return 1.0;

	let totalCompletions = 0;
	let relevantCompletions = 0;

	for (const [label, count] of Object.entries(agent.completionHistory)) {
		totalCompletions += count;
		if (proposal.labels.includes(label)) {
			relevantCompletions += count;
		}
	}

	if (totalCompletions === 0) return 1.0; // No history = neutral

	// Bonus for relevant experience
	const relevanceRatio =
		proposal.labels.length > 0
			? relevantCompletions / Math.max(1, totalCompletions)
			: 0;
	return 1 + relevanceRatio * 0.5; // Up to 1.5x bonus
}

/**
 * Score a single proposal for a given agent.
 */
export function scoreProposal(
	agent: AgentProfile,
	proposal: ScorableProposal,
): ScoreBreakdown {
	const capability_fit = computeCapabilityFit(agent, proposal);
	const cost_efficiency = computeCostEfficiency(agent, proposal);
	const difficulty_match = computeDifficultyMatch(agent, proposal);
	const importance_weight = computeImportanceWeight(proposal);
	const load_balance = computeLoadBalance(agent);
	const perfBonus = computePerformanceBonus(agent, proposal);

	const total =
		capability_fit *
		cost_efficiency *
		difficulty_match *
		importance_weight *
		load_balance *
		perfBonus;

	// Build explanation
	const parts: string[] = [];
	if (capability_fit < 1)
		parts.push(`capability fit: ${(capability_fit * 100).toFixed(0)}%`);
	if (cost_efficiency < 0.5) parts.push(`cost mismatch`);
	if (difficulty_match < 1)
		parts.push(
			`difficulty ${inferDifficulty(proposal)} vs tier ${agent.costClass}`,
		);
	if (proposal.downstreamCount > 2)
		parts.push(`blocks ${proposal.downstreamCount} proposals`);
	if (agent.currentLoad > 0)
		parts.push(`agent has ${agent.currentLoad} active claims`);

	const explanation = parts.length > 0 ? parts.join("; ") : "good match";

	return {
		capability_fit,
		cost_efficiency,
		difficulty_match,
		importance_weight,
		load_balance,
		total,
		explanation,
	};
}

/**
 * Score all proposals for an agent and return ranked results.
 */
export function scoreProposals(
	agent: AgentProfile,
	proposals: ScorableProposal[],
): ScoredProposal[] {
	const results: ScoredProposal[] = [];

	for (const proposal of proposals) {
		const score = scoreProposal(agent, proposal);
		results.push({ proposal, score });
	}

	// Sort by total score descending
	results.sort((a, b) => b.score.total - a.score.total);

	return results;
}

/**
 * Score proposals for multiple agents and find optimal assignments.
 * Returns assignments where each proposal goes to the best-fit agent.
 */
export function optimalAssignment(
	agents: AgentProfile[],
	proposals: ScorableProposal[],
): Map<string, { agent: string; score: ScoreBreakdown }> {
	const assignments = new Map<
		string,
		{ agent: string; score: ScoreBreakdown }
	>();
	const agentLoads = new Map(agents.map((a) => [a.name, a.currentLoad]));

	// Score all agent-proposal pairs
	const pairs: Array<{
		agent: string;
		proposal: string;
		score: number;
		breakdown: ScoreBreakdown;
	}> = [];

	for (const agent of agents) {
		if (agent.availability === "offline") continue;

		for (const proposal of proposals) {
			// Temporarily adjust load for scoring
			const adjustedAgent = {
				...agent,
				currentLoad: agentLoads.get(agent.name) || 0,
			};
			const breakdown = scoreProposal(adjustedAgent, proposal);
			pairs.push({
				agent: agent.name,
				proposal: proposal.id,
				score: breakdown.total,
				breakdown,
			});
		}
	}

	// Sort by score descending
	pairs.sort((a, b) => b.score - a.score);

	// Greedy assignment: assign highest-scoring pairs first
	const assignedProposals = new Set<string>();
	const assignedAgents = new Set<string>();

	for (const pair of pairs) {
		if (assignedProposals.has(pair.proposal)) continue;
		if (assignedAgents.has(pair.agent)) continue;

		assignments.set(pair.proposal, {
			agent: pair.agent,
			score: pair.breakdown,
		});
		assignedProposals.add(pair.proposal);
		assignedAgents.add(pair.agent);

		// Increment agent load for subsequent assignments
		agentLoads.set(pair.agent, (agentLoads.get(pair.agent) || 0) + 1);
	}

	return assignments;
}
