/**
 * P751: Readiness resolver.
 *
 * Standalone, testable module that owns the `assessReadiness()` logic
 * (originally part of the legacy gate-pipeline, retired by P754). The
 * scanQueues() loop uses this to decide whether a mature proposal needs
 * a prep agent (incomplete RFC) or a gate agent (ready to advance).
 *
 * The DB fetch (fetchProposalDetail) is co-located here so readiness-resolver
 * owns the full proposal detail lifecycle — gate-scanner-v2 only carries the
 * lightweight v_mature_queue projection.
 */

import { query } from "../../infra/postgres/pool.ts";
import { RfcStates } from "../workflow/state-names.ts";
import type { RoleProfile } from "./role-resolver.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReadinessMode = "prep" | "gate" | "skip";

export interface ProposalDetail {
	id: number;
	displayId: string;
	status: string;
	maturity: string;
	title: string;
	priority: string | null;
	summary: string | null;
	design: string | null;
	alternatives: string | null;
	drawbacks: string | null;
	dependency: string | null;
	unresolvedDependencies: number;
	totalAcceptanceCriteria: number;
	blockingAcceptanceCriteria: number;
	passedAcceptanceCriteria: number;
	latestDecision: string | null;
}

export interface ReadinessResult {
	mode: ReadinessMode;
	reasons: string[];
}

// ─── DB fetch ─────────────────────────────────────────────────────────────────

/**
 * Load the full proposal detail row needed for readiness assessment.
 * Returns null if the proposal is not found.
 */
export async function fetchProposalDetail(
	proposalId: number,
): Promise<ProposalDetail | null> {
	const { rows } = await query<{
		id: number;
		display_id: string;
		status: string;
		maturity: string;
		title: string;
		priority: string | null;
		summary: string | null;
		design: string | null;
		alternatives: string | null;
		drawbacks: string | null;
		dependency: string | null;
		unresolved_dependencies: number;
		total_acceptance_criteria: number;
		blocking_acceptance_criteria: number;
		passed_acceptance_criteria: number;
		latest_decision: string | null;
	}>(
		`SELECT
		    p.id,
		    p.display_id,
		    p.status,
		    p.maturity,
		    p.title,
		    p.priority,
		    p.summary,
		    p.design,
		    p.alternatives,
		    p.drawbacks,
		    p.dependency_note AS dependency,
		    COALESCE(dep.unresolved_dependencies, 0) AS unresolved_dependencies,
		    COALESCE(ac.total_acceptance_criteria, 0) AS total_acceptance_criteria,
		    COALESCE(ac.blocking_acceptance_criteria, 0) AS blocking_acceptance_criteria,
		    COALESCE(ac.passed_acceptance_criteria, 0) AS passed_acceptance_criteria,
		    dec.latest_decision
		 FROM roadmap_proposal.proposal p
		 LEFT JOIN LATERAL (
		    SELECT COUNT(*) FILTER (WHERE dependency_type = 'blocks' AND resolved = false)
		        AS unresolved_dependencies
		    FROM roadmap_proposal.proposal_dependencies
		    WHERE from_proposal_id = p.id
		 ) dep ON true
		 LEFT JOIN LATERAL (
		    SELECT
		        COUNT(*) AS total_acceptance_criteria,
		        COUNT(*) FILTER (WHERE status IN ('pending', 'fail')) AS blocking_acceptance_criteria,
		        COUNT(*) FILTER (WHERE status = 'pass') AS passed_acceptance_criteria
		    FROM roadmap_proposal.proposal_acceptance_criteria
		    WHERE proposal_id = p.id
		 ) ac ON true
		 LEFT JOIN LATERAL (
		    SELECT decision AS latest_decision
		    FROM roadmap_proposal.proposal_decision
		    WHERE proposal_id = p.id
		    ORDER BY decided_at DESC
		    LIMIT 1
		 ) dec ON true
		 WHERE p.id = $1
		 LIMIT 1`,
		[proposalId],
	);

	const row = rows[0];
	if (!row) return null;

	return {
		id: row.id,
		displayId: row.display_id,
		status: row.status,
		maturity: row.maturity,
		title: row.title,
		priority: row.priority ?? null,
		summary: row.summary ?? null,
		design: row.design ?? null,
		alternatives: row.alternatives ?? null,
		drawbacks: row.drawbacks ?? null,
		dependency: row.dependency ?? null,
		unresolvedDependencies: row.unresolved_dependencies ?? 0,
		totalAcceptanceCriteria: row.total_acceptance_criteria ?? 0,
		blockingAcceptanceCriteria: row.blocking_acceptance_criteria ?? 0,
		passedAcceptanceCriteria: row.passed_acceptance_criteria ?? 0,
		latestDecision: row.latest_decision ?? null,
	};
}

// ─── Readiness assessment ─────────────────────────────────────────────────────

function normalizeStage(value: string | null | undefined): string {
	return (value ?? "").trim().toUpperCase();
}

/**
 * Pure function: determine dispatch mode from a fully-loaded proposal detail.
 *
 * Returns:
 *   { mode: 'gate', reasons: [] }  — proposal is complete, needs gate review
 *   { mode: 'prep', reasons: [...] } — proposal has gaps, needs prep work
 *   { mode: 'skip', reasons: [...] } — terminal state or unsupported stage
 */
export function assessReadiness(detail: ProposalDetail): ReadinessResult {
	const stage = normalizeStage(detail.status);
	const missing: string[] = [];

	if (stage === RfcStates.COMPLETE) {
		return { mode: "skip", reasons: ["terminal state"] };
	}

	if (!detail.summary?.trim()) missing.push("summary");
	if (!detail.design?.trim()) missing.push("design");
	if (!detail.totalAcceptanceCriteria) missing.push("acceptance criteria");
	if (detail.unresolvedDependencies > 0) missing.push("blocking dependencies");
	if (detail.blockingAcceptanceCriteria > 0) missing.push("open acceptance criteria");

	if (
		stage === RfcStates.DRAFT ||
		stage === RfcStates.REVIEW ||
		stage === RfcStates.DEVELOP
	) {
		return missing.length > 0
			? { mode: "prep", reasons: missing }
			: { mode: "gate", reasons: [] };
	}

	if (stage === RfcStates.MERGE) {
		const needsApproval = detail.latestDecision !== "approved";
		if (missing.length > 0 || needsApproval) {
			return {
				mode: "prep",
				reasons: [
					...missing,
					...(needsApproval ? ["merge approval evidence"] : []),
				],
			};
		}
		return { mode: "gate", reasons: [] };
	}

	return { mode: "skip", reasons: ["unsupported stage"] };
}

// ─── Task prompt builders ─────────────────────────────────────────────────────

/**
 * Build the task prompt sent to the spawned agent.
 *
 * For gate mode: reviewer-style prompt focused on stage advancement decision.
 * For prep mode: preparation-agent prompt focused on filling the listed gaps.
 *
 * AC-9 (P1113): Optional 4th parameter `profile` allows role-specific task prompts.
 * When profile is provided and profile.promptTemplate.task_prompt is a non-empty string:
 *   - Resolve template vars against the proposal detail
 *   - Prepend to the generic task with a blank-line separator
 * When profile is null/undefined or has no task_prompt, produce the same output as before.
 */
export function buildTaskPrompt(
	detail: ProposalDetail,
	mode: ReadinessMode,
	reasons: string[],
	profile?: RoleProfile | null,
): string {
	const stage = normalizeStage(detail.status);
	const readinessSummary =
		reasons.length > 0
			? `Blocking items: ${reasons.join(", ")}.`
			: "Ready to gate.";

	const genericPrompt = (() => {
		if (mode === "gate") {
			return [
				`You are the gate agent for ${detail.displayId} (${detail.title}).`,
				`Current state: ${stage}.`,
				readinessSummary,
				"",
				"Decide whether the proposal is ready to advance to the next stage. If not, return concrete missing work.",
			].join("\n");
		}

		return [
			`You are the preparation agent for ${detail.displayId} (${detail.title}).`,
			`Current state: ${stage}.`,
			reasons.length > 0
				? `Prepare the proposal by addressing: ${reasons.join(", ")}.`
				: "Enhance the proposal until it is ready for the next gate.",
			"",
			"Focus on research, clarity, acceptance criteria, and any missing evidence.",
		].join("\n");
	})();

	// AC-10 (P1113): When profile is provided, check for role-specific task_prompt.
	if (profile && profile.promptTemplate) {
		const promptTemplate = profile.promptTemplate as Record<string, unknown>;
		const taskPrompt = promptTemplate.task_prompt;
		if (typeof taskPrompt === "string" && taskPrompt.length > 0) {
			// AC-10: resolve template vars against proposal detail
			const resolved = resolveTaskPromptVars(taskPrompt, detail);
			// Prepend to generic prompt with blank-line separator
			return `${resolved}\n\n${genericPrompt}`;
		}
	}

	return genericPrompt;
}

/**
 * Resolve template variables in a role-specific task prompt.
 * Supported vars: {display_id}, {proposal_id}, {status}, {stage}
 */
function resolveTaskPromptVars(template: string, detail: ProposalDetail): string {
	return template
		.replace(/{display_id}/g, detail.displayId || "")
		.replace(/{proposal_id}/g, String(detail.id || ""))
		.replace(/{status}/g, detail.status || "")
		.replace(/{stage}/g, normalizeStage(detail.status) || "");
}
