/**
 * Stage Enforcer — validates that a proposed stage transition is permitted
 * by the workflow template's stage sequence.
 *
 * Called before inserting into transition_queue to catch illegal jumps.
 * Reads from roadmap.workflow_stages (source of truth post-P227).
 */

import { query } from "../infra/postgres/pool.ts";

export interface TransitionRequest {
	proposalId: number;
	templateId: number;
	fromStage: string;
	toStage: string;
}

export interface EnforcementResult {
	allowed: boolean;
	reason?: string;
}

interface StageRow {
	stage_name: string;
	stage_order: number;
}

/**
 * Returns the ordered stage list for a workflow template.
 * Non-terminal stages only (order < 90).
 */
async function loadStages(templateId: number): Promise<StageRow[]> {
	const r = await query<StageRow>(
		`SELECT stage_name, stage_order
		   FROM roadmap.workflow_stages
		  WHERE template_id = $1 AND stage_order < 90
		  ORDER BY stage_order`,
		[templateId],
	);
	return r.rows;
}

/**
 * Enforces that the proposed transition follows the workflow's stage sequence.
 *
 * Rules:
 *   - Forward transitions must advance exactly to the next stage in sequence.
 *   - Backward transitions (iterate/revision) are always allowed — they are
 *     caught by the SMDL transition labels rather than order checks.
 *   - Terminal transitions (to stages with order >= 90) are always allowed.
 */
export async function enforceStageSequence(
	req: TransitionRequest,
): Promise<EnforcementResult> {
	const stages = await loadStages(req.templateId);

	const fromIdx = stages.findIndex((s) => s.stage_name === req.fromStage);
	const toIdx = stages.findIndex((s) => s.stage_name === req.toStage);

	// Unknown stages — check terminal list
	if (fromIdx === -1) {
		// fromStage might itself be terminal; that's a no-op case
		return { allowed: true };
	}

	if (toIdx === -1) {
		// toStage not in non-terminal list — check if it's a known terminal
		const terminal = await query<{ stage_name: string }>(
			`SELECT stage_name FROM roadmap.workflow_stages
			  WHERE template_id = $1 AND stage_order >= 90 AND stage_name = $2`,
			[req.templateId, req.toStage],
		);
		if (terminal.rows.length > 0) {
			return { allowed: true };
		}
		return {
			allowed: false,
			reason: `Unknown stage "${req.toStage}" for template ${req.templateId}`,
		};
	}

	const fromOrder = stages[fromIdx].stage_order;
	const toOrder = stages[toIdx].stage_order;

	// Backward transition — permitted (caller enforces label/role constraints)
	if (toOrder < fromOrder) {
		return { allowed: true };
	}

	// Forward transition — must advance to the immediately next stage
	const nextStage = stages[fromIdx + 1];
	if (!nextStage) {
		return {
			allowed: false,
			reason: `Stage "${req.fromStage}" has no next stage in template ${req.templateId}`,
		};
	}

	if (nextStage.stage_name !== req.toStage) {
		return {
			allowed: false,
			reason: `Illegal stage skip: "${req.fromStage}" → "${req.toStage}". ` +
				`Required next stage is "${nextStage.stage_name}". ` +
				`All quality gates (CODE_REVIEW, TEST_WRITING, TEST_EXECUTION) must be traversed in order.`,
		};
	}

	return { allowed: true };
}

/**
 * Throws if the transition is not allowed. Convenience wrapper.
 */
export async function assertStageSequence(req: TransitionRequest): Promise<void> {
	const result = await enforceStageSequence(req);
	if (!result.allowed) {
		throw new Error(`[StageEnforcer] ${result.reason}`);
	}
}
