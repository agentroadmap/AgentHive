/**
 * P3310: Deterministic difficulty assessor for work offers.
 *
 * Invoked at offer-mint time to emit difficulty_score ∈ [0,1] and
 * required_capability_tier on squad_dispatch rows.  Consumed by Child C
 * (unified matcher P3312) as the tier-floor selector.
 *
 * Pure heuristic — no LLM call.  All computation is deterministic and
 * unit-testable.  DB I/O (fetching AC rows, rework count, proposal overrides)
 * happens in the caller (postWorkOfferImpl); this module only computes.
 */

/** Reuses P1005/P1091 tier vocabulary (fn_tier_rank order: free<lower<mid<frontier). */
export const CAPABILITY_TIERS = ['free', 'lower', 'mid', 'frontier'] as const;
export type CapabilityTier = typeof CAPABILITY_TIERS[number];

export const TASK_CLASSES = [
	'mcp_protocol',
	'code_dev',
	'gate_review',
	'triage',
	'mechanical',
	'research',
] as const;
export type TaskClass = typeof TASK_CLASSES[number];

export interface DifficultyInput {
	/** Dispatch role (developer, architect, gate-reviewer, …) */
	role: string;
	/** Count of acceptance criteria on the proposal */
	acCount: number;
	/** Average word count per AC criterion text (proxy for complexity) */
	acAvgWords: number;
	/** Completed prior dispatches for (proposal_id, role) — rework escalation */
	reworkCount: number;
	/** From proposal.task_class — overrides heuristic-derived class if set */
	taskClassOverride?: string | null;
	/** From proposal.tier_override — overrides heuristic-derived tier if set */
	tierOverride?: string | null;
}

export interface DifficultyAssessment {
	/** Weighted heuristic score in [0, 1] */
	difficulty_score: number;
	/** Minimum capability tier required; reuses P1005/P1091 vocabulary */
	required_capability_tier: CapabilityTier;
	/** Task category */
	task_class: TaskClass;
}

const VALID_TIERS = new Set<string>(CAPABILITY_TIERS);
const VALID_TASK_CLASSES = new Set<string>(TASK_CLASSES);

/** Derive task_class from role name, with optional explicit override. */
export function resolveTaskClass(role: string, override?: string | null): TaskClass {
	if (override && VALID_TASK_CLASSES.has(override)) {
		return override as TaskClass;
	}
	const r = role.toLowerCase();
	if (
		r.startsWith('gate') ||
		r.startsWith('skeptic') ||
		r === 'reviewer-d1' ||
		r === 'reviewer' ||
		r === 'code-reviewer' ||
		r === 'architecture-reviewer' ||
		r === 'gate_decision_agent' ||
		r === 'merge_decision_agent'
	) {
		return 'gate_review';
	}
	if (r === 'developer' || r === 'engineer' || r === 'architect' || r === 'integration' || r === 'qa') {
		return 'code_dev';
	}
	if (r === 'researcher' || r === 'enhancer' || r === 'drafter') {
		return 'research';
	}
	if (r === 'triage') {
		return 'triage';
	}
	return 'mechanical';
}

/** Base score contribution from task class. */
function roleBaseScore(taskClass: TaskClass): number {
	switch (taskClass) {
		case 'mcp_protocol': return 0.30;
		case 'code_dev':     return 0.25;
		case 'gate_review':  return 0.20;
		case 'research':     return 0.20;
		case 'triage':       return 0.10;
		case 'mechanical':   return 0.05;
	}
}

/** AC count contribution: more acceptance criteria = harder work item. */
function acCountScore(count: number): number {
	if (count <= 3)  return 0;
	if (count <= 7)  return 0.10;
	if (count <= 11) return 0.20;
	return 0.30; // 12+
}

/** Map a continuous difficulty score to the coarsest matching tier. */
export function scoreToTier(score: number): CapabilityTier {
	if (score < 0.25) return 'lower';
	if (score < 0.50) return 'mid';
	return 'frontier';
}

/**
 * Compute difficulty assessment from heuristic inputs.
 *
 * Score breakdown:
 *   role base         0.05–0.30  (mechanical=0.05, code_dev=0.25, mcp_protocol=0.30)
 *   AC count          0–0.30     (0–3=0, 4–7=0.10, 8–11=0.20, 12+=0.30)
 *   AC text complexity 0 or 0.10 (avg > 40 words per criterion)
 *   rework escalation 0–0.30     (each prior rework +0.10, capped at 3)
 *
 * Tier thresholds: <0.25→lower, 0.25–0.50→mid, ≥0.50→frontier.
 * An explicit tier_override on the proposal takes precedence over computed tier.
 */
export function assessDifficulty(input: DifficultyInput): DifficultyAssessment {
	const task_class = resolveTaskClass(input.role, input.taskClassOverride);

	let score = roleBaseScore(task_class);
	score += acCountScore(input.acCount);
	if (input.acAvgWords > 40) score += 0.10;
	score += Math.min(input.reworkCount * 0.10, 0.30);
	// Round to 3 decimal places and clamp to [0, 1]
	const difficulty_score = Math.min(1, Math.max(0, Number(score.toFixed(3))));

	let required_capability_tier: CapabilityTier;
	if (input.tierOverride && VALID_TIERS.has(input.tierOverride)) {
		required_capability_tier = input.tierOverride as CapabilityTier;
	} else {
		required_capability_tier = scoreToTier(difficulty_score);
	}

	return { difficulty_score, required_capability_tier, task_class };
}
