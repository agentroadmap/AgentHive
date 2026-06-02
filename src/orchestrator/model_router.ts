/**
 * P226: Model Tier Router
 *
 * Selects the cheapest available model matching the required tier for a given
 * task. Tier is determined by task_type × difficulty, with an upward bump when
 * requires_novel_reasoning is true.
 *
 * Tier preference matrix:
 *   gate_review:  hard=frontier  medium=mid    easy=lower
 *   code_gen:     hard=mid       medium=mid    easy=lower
 *   research:     hard=frontier  medium=mid    easy=lower
 *   verification: *=lower  (deterministic — tier never goes above lower)
 *   review:       hard=mid       medium=mid    easy=lower
 *   test_writing: hard=mid       medium=mid    easy=lower
 *
 * Fallback chain: if no model is available at the preferred tier the router
 * tries adjacent tiers (cheaper first, then more expensive).
 */

import { query as defaultQuery } from "../infra/postgres/pool.ts";
import type { QueryResult, QueryResultRow } from "pg";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TaskType =
	| "gate_review"
	| "code_gen"
	| "research"
	| "verification"
	| "review"
	| "test_writing";

export type Difficulty = "easy" | "medium" | "hard";

export type ModelTier = "frontier" | "mid" | "lower" | "tool";

export interface TaskMetadata {
	task_type: TaskType;
	difficulty: Difficulty;
	requires_novel_reasoning: boolean;
	proposal_id: bigint;
}

export interface ModelConfig {
	id: number;
	model_name: string;
	tier: ModelTier;
	route_provider: string;
	agent_provider: string;
	/** Cost in USD per 1 000 input tokens */
	cost_per_1k_input: number;
	confidence_threshold: number;
	is_enabled: boolean;
}

type QueryFn = <T extends QueryResultRow = Record<string, unknown>>(
	text: string,
	params?: unknown[],
) => Promise<QueryResult<T>>;

// ─── Tier preference matrix ───────────────────────────────────────────────────

export const TIER_PREFERENCE: Record<TaskType, Record<Difficulty, ModelTier>> =
	{
		gate_review: { hard: "frontier", medium: "mid", easy: "lower" },
		code_gen: { hard: "mid", medium: "mid", easy: "lower" },
		research: { hard: "frontier", medium: "mid", easy: "lower" },
		verification: { hard: "lower", medium: "lower", easy: "lower" },
		review: { hard: "mid", medium: "mid", easy: "lower" },
		test_writing: { hard: "mid", medium: "mid", easy: "lower" },
	};

// When the preferred tier has no enabled models, fall back through this chain
// (always try cheaper options before escalating to more expensive ones).
const TIER_FALLBACK: Record<ModelTier, ModelTier[]> = {
	frontier: ["frontier", "mid", "lower"],
	mid: ["mid", "lower", "frontier"],
	lower: ["lower", "mid", "frontier"],
	tool: ["tool", "lower", "mid"],
};

// ─── Tier bump for novel-reasoning tasks ─────────────────────────────────────

function bumpTier(tier: ModelTier): ModelTier {
	if (tier === "lower") return "mid";
	if (tier === "mid") return "frontier";
	return tier; // frontier stays frontier
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Select the cheapest model that satisfies the tier required by the task.
 *
 * @param task     Task descriptor (type, difficulty, reasoning flag, proposal)
 * @param queryFn  Postgres query function (injected for testability)
 */
export async function selectModelByTaskDifficulty(
	task: TaskMetadata,
	queryFn: QueryFn = defaultQuery,
): Promise<ModelConfig> {
	const baseTier = TIER_PREFERENCE[task.task_type][task.difficulty];

	// Non-verifiable reasoning tasks should not be dispatched to lower-tier models
	const effectiveTier =
		task.requires_novel_reasoning && baseTier !== "frontier"
			? bumpTier(baseTier)
			: baseTier;

	const fallbackChain = TIER_FALLBACK[effectiveTier];

	for (const tier of fallbackChain) {
		const { rows } = await queryFn<ModelConfig>(
			`SELECT
				id,
				model_name,
				tier,
				route_provider,
				agent_provider,
				COALESCE(cost_per_million_input, 0) / 1000.0 AS cost_per_1k_input,
				COALESCE(confidence_threshold, 0.70)::float8 AS confidence_threshold,
				is_enabled
			FROM roadmap.model_routes
			WHERE tier = $1
			  AND is_enabled = true
			ORDER BY COALESCE(cost_per_million_input, 0) ASC
			LIMIT 1`,
			[tier],
		);

		if (rows[0]) return rows[0];
	}

	throw new Error(
		`[ModelRouter] No enabled model found for task ${task.task_type}/${task.difficulty} ` +
			`(requires_novel_reasoning=${task.requires_novel_reasoning}, ` +
			`effectiveTier=${effectiveTier})`,
	);
}

/**
 * List all models for a given tier, ordered by cost ascending.
 * Useful for dashboard and cost-planning queries.
 */
export async function listModelsByTier(
	tier: ModelTier,
	queryFn: QueryFn = defaultQuery,
): Promise<ModelConfig[]> {
	const { rows } = await queryFn<ModelConfig>(
		`SELECT
			id,
			model_name,
			tier,
			route_provider,
			agent_provider,
			COALESCE(cost_per_million_input, 0) / 1000.0 AS cost_per_1k_input,
			COALESCE(confidence_threshold, 0.70)::float8 AS confidence_threshold,
			is_enabled
		FROM roadmap.model_routes
		WHERE tier = $1
		ORDER BY COALESCE(cost_per_million_input, 0) ASC`,
		[tier],
	);
	return rows;
}
