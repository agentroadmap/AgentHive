/**
 * P3310 — Child A: Dynamic task-difficulty / required-capability signal.
 *
 * Deterministic (NO LLM) heuristic that runs when a work offer is minted. It
 * computes:
 *   - difficulty_score ∈ [0,1]            (continuous blast-radius signal)
 *   - required_capability_tier            (P1005/P1091 tier vocabulary)
 *   - task_class                          (P3310 AC-3 enum)
 *
 * These are persisted on roadmap_workforce.squad_dispatch so the adaptive
 * work-model matching group can route work by difficulty × capability:
 *   - Child C matcher (P3312) consumes `required_capability_tier`.
 *   - Child B reliability-ledger (P3311) + Child D (P3313) key on `task_class`.
 *
 * AC-2 invariant: this module performs ZERO network / LLM calls. It is a pure
 * function of its inputs and is fully unit-testable.
 *
 * AC-4 invariant: the emitted tier reuses the canonical tier vocabulary from
 * the P1005/P1091 route resolver (`getTierRank`) — free < lower < mid <
 * frontier — so Child C can rank it directly.
 */

import { getTierRank } from "./resolvers/tier-aware-resolver.ts";

/**
 * P3310 AC-3: task classes assignable per work item. The string values MUST
 * match the `squad_dispatch_task_class_check` CHECK constraint on
 * roadmap_workforce.squad_dispatch.task_class (see migration 268).
 *
 * Siblings import this enum — do not rename the members or change the values.
 */
export const TASK_CLASS = {
	MCP_PROTOCOL: "mcp_protocol",
	CODE_DEV: "code_dev",
	GATE_REVIEW: "gate_review",
	TRIAGE: "triage",
	MECHANICAL: "mechanical",
	RESEARCH: "research",
} as const;

export type TaskClass = (typeof TASK_CLASS)[keyof typeof TASK_CLASS];

/** All legal task_class values, in CHECK-constraint order. */
export const TASK_CLASS_VALUES: readonly TaskClass[] = Object.values(TASK_CLASS);

export function isTaskClass(v: unknown): v is TaskClass {
	return typeof v === "string" && (TASK_CLASS_VALUES as readonly string[]).includes(v);
}

/**
 * Capability tiers, reusing the P1005/P1091 tier vocabulary (AC-4). Ordered
 * low → high; `getTierRank` (the canonical ranker) backs the ordering so a
 * single source of truth governs tier comparison across the codebase.
 */
export type CapabilityTier = "free" | "lower" | "mid" | "frontier";

/** Ascending tier ladder reused by the difficulty→tier mapping below. */
export const CAPABILITY_TIER_LADDER: readonly CapabilityTier[] = [
	"free",
	"lower",
	"mid",
	"frontier",
];

/** Canonical numeric rank for a capability tier (delegates to P1091). */
export function capabilityTierRank(tier: CapabilityTier): number {
	return getTierRank(tier);
}

/**
 * Map a role to its task_class (AC-3). Mirrors the dispatch-role taxonomy used
 * by ROLE_TO_REQUIRED_CAPABILITIES so classification stays consistent with the
 * capability routing already in place.
 */
export function classifyTaskClass(role: string | null | undefined): TaskClass {
	const r = (role ?? "").toLowerCase().trim();

	// Review-family roles → gate_review.
	if (
		r.includes("review") ||
		r.includes("skeptic") ||
		r === "gate_decision_agent" ||
		r === "merge_decision_agent"
	) {
		return TASK_CLASS.GATE_REVIEW;
	}
	if (r.includes("triage")) return TASK_CLASS.TRIAGE;
	if (r.includes("research") || r === "researcher") return TASK_CLASS.RESEARCH;
	if (r.includes("mcp") || r.includes("protocol")) return TASK_CLASS.MCP_PROTOCOL;
	// Deterministic / mechanical floor roles.
	if (r.includes("mechanical") || r.includes("reaper") || r.includes("janitor")) {
		return TASK_CLASS.MECHANICAL;
	}
	// developer / engineer / architect / drafter / enhancer / integration / qa
	return TASK_CLASS.CODE_DEV;
}

/**
 * Keywords that signal high architectural blast radius. Presence in the task
 * text bumps difficulty. Kept small + auditable on purpose (AC-2 determinism).
 */
const HIGH_BLAST_RADIUS_KEYWORDS = [
	"architecture",
	"migration",
	"schema",
	"refactor",
	"breaking",
	"protocol",
	"workflow",
	"state machine",
	"concurrency",
	"distributed",
	"security",
	"auth",
] as const;

export interface DifficultyInput {
	/** Dispatch role (e.g. "developer", "gate-reviewer"). */
	role: string;
	/** Free-text task description (the offer's `task` field). */
	task?: string | null;
	/** Number of acceptance criteria on the proposal. */
	acCount?: number | null;
	/**
	 * Rework signal — how many times this work has been attempted/reissued.
	 * Higher rework escalates difficulty (AC-2 rework_count escalation).
	 */
	reworkCount?: number | null;
	/**
	 * Explicit operator/proposal override. When set to a legal CapabilityTier,
	 * it is honored over the heuristic (AC-3 override).
	 */
	tierOverride?: CapabilityTier | null;
	/**
	 * Explicit task_class override. When set to a legal TaskClass, it is
	 * honored over role-based classification (AC-3 override).
	 */
	taskClassOverride?: TaskClass | null;
}

export interface DifficultyAssessment {
	/** Continuous blast-radius signal in [0,1]. */
	difficultyScore: number;
	/** Capability tier from the P1005/P1091 vocabulary (AC-4). */
	requiredCapabilityTier: CapabilityTier;
	/** Numeric rank of the tier (delegates to getTierRank). */
	tierRank: number;
	/** Assigned task_class (AC-3). */
	taskClass: TaskClass;
	/** True when an explicit override (tier or task_class) was honored. */
	overridden: boolean;
}

function clamp01(n: number): number {
	if (Number.isNaN(n)) return 0;
	if (n < 0) return 0;
	if (n > 1) return 1;
	return n;
}

/** Map a difficulty score in [0,1] to a capability tier (AC-1 / AC-4). */
export function scoreToTier(score: number): CapabilityTier {
	const s = clamp01(score);
	if (s >= 0.75) return "frontier";
	if (s >= 0.45) return "mid";
	if (s >= 0.2) return "lower";
	return "free";
}

/**
 * P3310 core: deterministic difficulty assessor. Pure function — no I/O.
 *
 * Scoring components (each capped, then summed and clamped to [0,1]):
 *   - AC count:      up to 0.45 (12+ ACs saturates).
 *   - Blast radius:  up to 0.30 (distinct high-blast keywords in task text).
 *   - Rework:        up to 0.30 (each prior rework adds 0.15).
 *   - Class floor:   gate_review/research carry a small floor so a trivial
 *                    review still lands above free.
 */
export function assessDifficulty(input: DifficultyInput): DifficultyAssessment {
	const taskClass = isTaskClass(input.taskClassOverride)
		? input.taskClassOverride
		: classifyTaskClass(input.role);

	// --- AC-count component (0..0.45), saturating at 12 ACs. ---
	const acCount = Math.max(0, input.acCount ?? 0);
	const acComponent = Math.min(acCount / 12, 1) * 0.45;

	// --- Blast-radius component (0..0.30): distinct high-blast keywords. ---
	const text = (input.task ?? "").toLowerCase();
	let keywordHits = 0;
	for (const kw of HIGH_BLAST_RADIUS_KEYWORDS) {
		if (text.includes(kw)) keywordHits += 1;
	}
	const blastComponent = Math.min(keywordHits / 4, 1) * 0.3;

	// --- Rework component (0..0.30): each prior rework adds 0.15. ---
	const rework = Math.max(0, input.reworkCount ?? 0);
	const reworkComponent = Math.min(rework * 0.15, 0.3);

	// --- Class floor: reviews/research are inherently non-trivial. ---
	const classFloor =
		taskClass === TASK_CLASS.GATE_REVIEW || taskClass === TASK_CLASS.RESEARCH
			? 0.15
			: 0;

	const difficultyScore = clamp01(
		acComponent + blastComponent + reworkComponent + classFloor,
	);

	// Honor explicit tier override (AC-3) over the heuristic.
	const overrideTier =
		input.tierOverride && CAPABILITY_TIER_LADDER.includes(input.tierOverride)
			? input.tierOverride
			: null;
	const requiredCapabilityTier = overrideTier ?? scoreToTier(difficultyScore);

	return {
		difficultyScore,
		requiredCapabilityTier,
		tierRank: capabilityTierRank(requiredCapabilityTier),
		taskClass,
		overridden: Boolean(overrideTier) || isTaskClass(input.taskClassOverride),
	};
}
