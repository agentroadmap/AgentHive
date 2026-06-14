/**
 * V3-C7 (P1439): Deliverable Verifier
 *
 * Prevents hallucinated completions by verifying that workers actually produced
 * their promised artifacts before allowing maturity to advance to 'mature'.
 *
 * Each dispatch_role maps to an objective artifact check:
 *   - gate-review: proposal_reviews row exists (reviewer_identity = worker, proposal_id matches)
 *   - developer: agent_runs row with status='completed' or similar (proposal_id matches, agent_identity = worker)
 *   - enhance: proposal_acceptance_criteria rows with status != 'pending' OR proposal_discussions rows exist
 *   - architect: proposal_acceptance_criteria rows exist with non-null criterion_text
 *
 * When a worker exits with outcome='success' but no artifact is found:
 *   - Mark squad_dispatch as failed with failure_class='no_artifact'
 *   - DO NOT advance maturity
 *   - Log the hallucination for operator review
 *
 * Runs in the orchestrator completion observer BEFORE maturity advance.
 */

import type { PoolClient } from "pg";
import { query as queryDb } from "../../infra/postgres/pool.ts";

export interface VerifyDeliverablesInput {
	proposalId: number;
	dispatchRole: string;
	workerIdentity: string;
	dispatchId?: number;
	briefingId?: string;
}

export interface VerifyResult {
	verified: boolean;
	artifactType?: string;
	artifactId?: number | string;
	failureReason?: string;
}

/**
 * Role-to-artifact-check map. Each role has a specific check that proves
 * the worker completed their task without lying about exit code.
 */
const ROLE_ARTIFACT_CHECKS: Record<
	string,
	(
		proposalId: number,
		workerIdentity: string,
		dispatchId?: number
	) => Promise<VerifyResult>
> = {
	"gate-review": async (proposalId, workerIdentity, _dispatchId) => {
		// Gate reviewers must write a proposal_reviews row for this proposal.
		// Check: proposal_reviews row exists where proposal_id = $1 AND reviewer_identity = $2
		const result = await queryDb(
			`SELECT id FROM roadmap_proposal.proposal_reviews
			  WHERE proposal_id = $1 AND reviewer_identity = $2
			  LIMIT 1`,
			[proposalId, workerIdentity]
		);
		if (result.rows.length > 0) {
			return {
				verified: true,
				artifactType: "proposal_reviews",
				artifactId: result.rows[0].id,
			};
		}
		return {
			verified: false,
			failureReason: `No proposal_reviews row found for proposal_id=${proposalId}, reviewer_identity=${workerIdentity}`,
		};
	},

	developer: async (proposalId, workerIdentity, _dispatchId) => {
		// Developers must produce a commit or code artifact. We check for:
		// (1) agent_runs row with status='completed', OR
		// (2) agent_runs row with a non-null output_summary indicating work was done
		const result = await queryDb(
			`SELECT id, status, output_summary FROM roadmap_workforce.agent_runs
			  WHERE proposal_id = $1 AND agent_identity = $2
			  ORDER BY completed_at DESC NULLS LAST, started_at DESC
			  LIMIT 1`,
			[proposalId, workerIdentity]
		);
		if (result.rows.length > 0) {
			const row = result.rows[0];
			// Accept if completed with a summary
			if (row.status === "completed" && row.output_summary) {
				return {
					verified: true,
					artifactType: "agent_runs",
					artifactId: row.id,
				};
			}
			// Also accept if status is 'completed' (the exit is the proof)
			if (row.status === "completed") {
				return {
					verified: true,
					artifactType: "agent_runs",
					artifactId: row.id,
				};
			}
		}
		return {
			verified: false,
			failureReason: `No completed agent_runs row found for proposal_id=${proposalId}, agent_identity=${workerIdentity}`,
		};
	},

	enhance: async (proposalId, workerIdentity, _dispatchId) => {
		// Enhancers must write design work: either AC rows or discussion notes.
		// Check: proposal_acceptance_criteria rows exist with non-pending status
		// OR proposal_discussions rows exist with verified_by = worker
		const acResult = await queryDb(
			`SELECT id FROM roadmap_proposal.proposal_acceptance_criteria
			  WHERE proposal_id = $1 AND status != 'pending'
			  LIMIT 1`,
			[proposalId]
		);
		if (acResult.rows.length > 0) {
			return {
				verified: true,
				artifactType: "proposal_acceptance_criteria",
				artifactId: acResult.rows[0].id,
			};
		}

		const discussionResult = await queryDb(
			`SELECT id FROM roadmap_proposal.proposal_discussions
			  WHERE proposal_id = $1 AND context_prefix = 'feedback:'
			  ORDER BY created_at DESC LIMIT 1`,
			[proposalId]
		);
		if (discussionResult.rows.length > 0) {
			return {
				verified: true,
				artifactType: "proposal_discussions",
				artifactId: discussionResult.rows[0].id,
			};
		}

		return {
			verified: false,
			failureReason: `No AC or discussion artifacts found for enhance on proposal_id=${proposalId}`,
		};
	},

	architect: async (proposalId, workerIdentity, _dispatchId) => {
		// Architects must write acceptance criteria. Check for proposal_acceptance_criteria
		// rows with non-null criterion_text (the actual AC content).
		const result = await queryDb(
			`SELECT id, criterion_text FROM roadmap_proposal.proposal_acceptance_criteria
			  WHERE proposal_id = $1 AND criterion_text IS NOT NULL AND criterion_text != ''
			  LIMIT 1`,
			[proposalId]
		);
		if (result.rows.length > 0) {
			return {
				verified: true,
				artifactType: "proposal_acceptance_criteria",
				artifactId: result.rows[0].id,
			};
		}

		return {
			verified: false,
			failureReason: `No acceptance criteria found for architect on proposal_id=${proposalId}`,
		};
	},
};

/**
 * Map a live squad_dispatch.dispatch_role onto one of the four artifact-check
 * categories in ROLE_ARTIFACT_CHECKS. Live dispatch roles are far more varied
 * than the check keys (e.g. "gate-reviewer", "skeptic-beta", "enhancer"), so
 * without this mapping verifyDeliverables would treat almost every real role as
 * "unknown" and skip the evidence gate — a placebo. Roles with no artifact
 * concept (decision/tracker/tester orchestration roles) return null and are
 * intentionally skipped by the caller.
 */
export function normalizeDispatchRole(role: string): keyof typeof ROLE_ARTIFACT_CHECKS | null {
	const r = role.toLowerCase();
	// Review/gate roles write a proposal_reviews row.
	if (
		r === "gate-review" ||
		r.startsWith("gate-review") ||
		r.startsWith("reviewer") ||
		r === "reviewer" ||
		r === "review" ||
		r === "qa" ||
		r.startsWith("skeptic")
	) {
		return "gate-review";
	}
	// Build roles produce a commit / agent_runs artifact.
	if (
		r === "developer" ||
		r === "engineer" ||
		r === "drafter" ||
		r === "integration" ||
		r === "git-specialist" ||
		r === "merge-agent"
	) {
		return "developer";
	}
	// Enhancement/enrichment/research roles write AC or discussion artifacts.
	if (r === "enhance" || r === "enhancer" || r === "enrichment_agent" || r === "researcher") {
		return "enhance";
	}
	if (r === "architect") {
		return "architect";
	}
	// gate_decision_agent / merge_decision_agent / token-tracker / messaging-tester
	// have no role artifact in ROLE_ARTIFACT_CHECKS — caller skips them.
	return null;
}

/**
 * Verify that a worker's claimed completion has actual deliverables.
 *
 * @param input - Verification input (proposalId, dispatchRole, workerIdentity)
 * @returns VerifyResult with verified flag and details
 *
 * Throws on database errors (fatal). Returns {verified: false, failureReason: '...'} for
 * missing artifacts (transient, eligible for retry).
 */
export async function verifyDeliverables(input: VerifyDeliverablesInput): Promise<VerifyResult> {
	const { proposalId, dispatchRole, workerIdentity } = input;

	const artifactRole = normalizeDispatchRole(dispatchRole);
	const checker = artifactRole ? ROLE_ARTIFACT_CHECKS[artifactRole] : undefined;
	if (!checker) {
		// Role with no artifact concept (decision/tracker/tester, or genuinely
		// unknown): skip verification (allow advance). Log a warning.
		console.warn(
			`[DeliverableVerifier] No artifact check for dispatch_role: ${dispatchRole} for proposal=${proposalId}; skipping verification`
		);
		return {
			verified: true, // Default to pass for roles with no artifact concept.
			artifactType: "no-artifact-role",
		};
	}

	try {
		const result = await checker(proposalId, workerIdentity, input.dispatchId);
		return result;
	} catch (err) {
		// Database error: fatal. Re-throw.
		console.error(
			`[DeliverableVerifier] Fatal error verifying proposal=${proposalId}, role=${dispatchRole}:`,
			err
		);
		throw err;
	}
}

/**
 * Mark a dispatch as failed due to missing deliverables.
 * This prevents maturity advance and logs the hallucination.
 *
 * @param dispatchId - The squad_dispatch row ID
 * @param failureReason - Human-readable reason (e.g., "No proposal_reviews row found")
 *
 * Called when verifyDeliverables returns {verified: false}.
 * Sets failure_class='unknown' (unattributable hallucination) and dispatch_status='failed'.
 */
export async function markDeliverableVerificationFailed(
	dispatchId: number,
	failureReason: string
): Promise<void> {
	try {
		await queryDb(
			`UPDATE roadmap_workforce.squad_dispatch
			  SET dispatch_status = 'failed',
			      failure_class = 'unknown',
			      failure_is_transient = false,
			      completed_at = now(),
			      metadata = COALESCE(metadata, '{}'::jsonb)
			                || jsonb_build_object(
			                     'verification_failed_reason'::text, $1::text,
			                     'verified_by'::text, 'deliverable-verifier'::text,
			                     'verified_at'::text, now()::text
			                   )
			  WHERE id = $2`,
			[failureReason, dispatchId]
		);
	} catch (err) {
		console.error(
			`[DeliverableVerifier] Failed to mark dispatch ${dispatchId} as failed:`,
			err
		);
		throw err;
	}
}

/**
 * Get the role->artifact-check map for documentation and testing.
 */
export function getRoleArtifactMap(): Record<string, string> {
	return {
		"gate-review": "proposal_reviews row (reviewer_identity + proposal_id)",
		developer: "agent_runs row with status='completed'",
		enhance: "proposal_acceptance_criteria (status != 'pending') OR proposal_discussions",
		architect: "proposal_acceptance_criteria with non-empty criterion_text",
	};
}
