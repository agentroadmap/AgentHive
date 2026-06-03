/**
 * P226: Tiered model routing based on task difficulty and role requirements.
 *
 * selectModelByTaskDifficulty() queries model_routes filtered by the tier
 * preference derived from task type, difficulty, and reasoning requirements.
 * Easy/routine work targets lower-cost tiers; gate_review and novel-reasoning
 * work targets frontier routes.
 */

import { query as defaultQuery } from "../infra/postgres/pool.ts";
import type { QueryResult, QueryResultRow } from "pg";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ModelTier = "frontier" | "mid" | "lower" | "tool";

export interface TaskMetadata {
	task_type: string;
	difficulty: "easy" | "medium" | "hard";
	requires_novel_reasoning: boolean;
	proposal_id: bigint;
}

export interface ModelRoute {
	id: number;
	model_name: string;
	tier: ModelTier;
	route_provider: string;
	agent_provider: string;
	cost_per_1k_input: number;
	confidence_threshold: number;
	is_enabled: boolean;
}

type QueryFn = <T extends QueryResultRow = Record<string, unknown>>(
	text: string,
	params?: unknown[],
) => Promise<QueryResult<T>>;

// ─── Tier selection ───────────────────────────────────────────────────────────

type Difficulty = TaskMetadata["difficulty"];

/**
 * Per-task-type tier preference table.
 *
 * Rows that are absent fall back to the generic difficulty mapping:
 *   hard/medium → mid, easy → lower.
 * novel_reasoning always escalates by one tier regardless of this table.
 *
 * "verification" is always lower — deterministic checks never need LLM reasoning.
 * "gate_review" scales by difficulty so easy reviews don't burn frontier tokens.
 */
export const TIER_PREFERENCE: Record<string, Record<Difficulty, ModelTier>> = {
	gate_review: { hard: "frontier", medium: "mid", easy: "lower" },
	architecture_review: { hard: "frontier", medium: "frontier", easy: "mid" },
	security_review: { hard: "frontier", medium: "frontier", easy: "mid" },
	verification: { hard: "lower", medium: "lower", easy: "lower" },
	code_gen: { hard: "mid", medium: "mid", easy: "lower" },
	test_writing: { hard: "mid", medium: "lower", easy: "lower" },
	research: { hard: "frontier", medium: "mid", easy: "lower" },
};

export function preferredTierForTask(task: TaskMetadata): ModelTier {
	const row = TIER_PREFERENCE[task.task_type];
	let tier: ModelTier = row ? row[task.difficulty] : task.difficulty === "easy" ? "lower" : "mid";

	if (task.requires_novel_reasoning) {
		// Escalate one tier upward for novel-reasoning tasks, capped at frontier
		if (tier === "lower") tier = "mid";
		else if (tier === "mid") tier = "frontier";
	}

	return tier;
}

// ─── Route selector ───────────────────────────────────────────────────────────

/**
 * Select the best available model route for a task, ranked by cost within tier.
 *
 * Tries the preferred tier first, then falls back up the cost ladder so work
 * is never dropped due to an empty tier. The caller's injected queryFn may
 * return a subset of routes (e.g. for unit tests), in which case the first
 * returned row wins.
 */
export async function selectModelByTaskDifficulty(
	task: TaskMetadata,
	queryFn: QueryFn = defaultQuery,
): Promise<ModelRoute> {
	const preferredTier = preferredTierForTask(task);

	const tierOrder: ModelTier[] =
		preferredTier === "frontier"
			? ["frontier", "mid", "lower"]
			: preferredTier === "mid"
				? ["mid", "lower", "frontier"]
				: ["lower", "mid", "frontier"];

	for (const tier of tierOrder) {
		const { rows } = await queryFn<ModelRoute>(
			`SELECT
				id,
				model_name,
				tier,
				route_provider,
				agent_provider,
				COALESCE(cost_per_million_input / 1000.0, 0) AS cost_per_1k_input,
				COALESCE(confidence_threshold, 0.70) AS confidence_threshold,
				is_enabled
			FROM roadmap.model_routes
			WHERE is_enabled = true
			  AND tier = $1
			  AND cooldown_until IS NULL
			ORDER BY cost_per_million_input ASC NULLS LAST
			LIMIT 1`,
			[tier],
		);
		if (rows.length > 0) return rows[0];
	}

	throw new Error(
		`No enabled model found for task_type=${task.task_type} difficulty=${task.difficulty}`,
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
