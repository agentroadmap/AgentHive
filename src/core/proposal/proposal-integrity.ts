/**
 * Proposal Transition Integrity (AC-12, AC-17)
 *
 * Validates proposal transitions against the workflow rules stored in
 * proposal_valid_transitions and returns machine-readable structured errors
 * with specific ErrorCode values. No raw exceptions escape to MCP callers.
 *
 * ErrorCodes:
 *   INVALID_TRANSITION     — no valid transition rule exists for from→to
 *   MATURITY_GATE_BLOCKED  — current-stage maturity is not 'mature'
 *   AC_GATE_FAILED         — non-waived acceptance criteria are pending/fail
 *   DAG_CYCLE_DETECTED     — dependency would create a cycle
 *   LEASE_CONFLICT         — another agent holds an active lease
 *   ROLE_VIOLATION         — agent lacks the required role for this transition
 */

import { query } from "../../infra/postgres/pool.ts";
import { Maturity } from "../workflow/state-names.ts";
import type {
	ProposalAcceptanceCriterionRow,
	ProposalRow,
} from "../../infra/postgres/proposal-storage-v2.ts";

// ─── Error Codes ─────────────────────────────────────────────────────

export type ErrorCode =
	| "INVALID_TRANSITION"
	| "MATURITY_GATE_BLOCKED"
	| "AC_GATE_FAILED"
	| "DAG_CYCLE_DETECTED"
	| "LEASE_CONFLICT"
	| "ROLE_VIOLATION"
	| "DRAFT_QUALITY_GATE";

// ─── Structured Error ────────────────────────────────────────────────

export interface ValidationError {
	code: ErrorCode;
	message: string;
	context?: Record<string, unknown>;
}

export interface TransitionValidationResult {
	valid: boolean;
	error?: ValidationError;
}

// ─── Transition Rule Row ─────────────────────────────────────────────

interface TransitionRuleRow {
	from_state: string;
	to_state: string;
	allowed_reasons: string[] | null;
	allowed_roles: string[] | null;
	requires_ac: string | null;
}

// ─── Lease Row ───────────────────────────────────────────────────────

interface LeaseRow {
	agent_identity: string;
	expires_at: string | null;
	released_at: string | null;
}

// ─── Cycle Check Row ─────────────────────────────────────────────────

interface CycleCheckRow {
	would_create_cycle: boolean;
	cycle_path: string[] | null;
}

/**
 * Validate a transition is allowed by the workflow rules.
 * Returns a structured ValidationError or valid=true.
 *
 * AC-12: proposal-integrity.ts rejects any transition violating workflow rules
 * and returns a machine-readable structured error (not a raw exception).
 *
 * AC-17: returns ValidationError with machine-readable ErrorCode for every
 * rejection path — no raw exceptions or unstructured strings escape to callers.
 */
export async function validateTransition(
	proposalId: number,
	fromState: string,
	toState: string,
	agentIdentity: string,
): Promise<TransitionValidationResult> {
	// 1. Check the transition rule exists
	const ruleResult = await validateTransitionRule(proposalId, fromState, toState);
	if (!ruleResult.valid) return ruleResult;

	// 2. Check DRAFT quality gate (DRAFT→REVIEW only)
	const draftResult = await validateDraftQuality(proposalId, fromState, toState);
	if (!draftResult.valid) return draftResult;

	// 3. Check maturity gate
	const maturityResult = await validateMaturityGate(proposalId, fromState);
	if (!maturityResult.valid) return maturityResult;

	// 4. Check AC gate (if requires_ac is set for this transition)
	const acResult = await validateACGate(proposalId, toState);
	if (!acResult.valid) return acResult;

	// 5. Check lease (if required)
	const leaseResult = await validateLease(proposalId, agentIdentity);
	if (!leaseResult.valid) return leaseResult;

	// 6. Check DAG cycle (for dependency-related transitions)
	const dagResult = await validateNoCycles(proposalId, toState);
	if (!dagResult.valid) return dagResult;

	return { valid: true };
}

/**
 * P428: Block DRAFT→REVIEW when design, motivation, or ACs are missing.
 * Returns DRAFT_QUALITY_GATE with missingFields list so the operator knows exactly what to fix.
 */
async function validateDraftQuality(
	proposalId: number,
	fromState: string,
	toState: string,
): Promise<TransitionValidationResult> {
	if (fromState.toLowerCase() !== "draft" || toState.toLowerCase() !== "review") {
		return { valid: true };
	}

	const { rows: proposalRows } = await query<{ design: string | null; motivation: string | null }>(
		`SELECT design, motivation FROM roadmap_proposal.proposal WHERE id = $1 LIMIT 1`,
		[proposalId],
	);

	if (proposalRows.length === 0) {
		return {
			valid: false,
			error: {
				code: "INVALID_TRANSITION",
				message: `Proposal ${proposalId} not found`,
				context: { proposalId },
			},
		};
	}

	const { design, motivation } = proposalRows[0];
	const missingFields: string[] = [];

	if (!design || design.trim() === "") missingFields.push("design");
	if (!motivation || motivation.trim() === "") missingFields.push("motivation");

	const { rows: acRows } = await query<{ count: string }>(
		`SELECT COUNT(*) AS count FROM roadmap_proposal.proposal_acceptance_criteria WHERE proposal_id = $1`,
		[proposalId],
	);

	if (parseInt(acRows[0]?.count ?? "0", 10) === 0) missingFields.push("acceptance_criteria");

	if (missingFields.length > 0) {
		return {
			valid: false,
			error: {
				code: "DRAFT_QUALITY_GATE",
				message: `Cannot advance to Review: missing required fields: ${missingFields.join(", ")}`,
				context: { proposalId, missingFields },
			},
		};
	}

	return { valid: true };
}

/**
 * AC-12: Check that a valid transition rule exists in proposal_valid_transitions.
 */
async function validateTransitionRule(
	proposalId: number,
	fromState: string,
	toState: string,
): Promise<TransitionValidationResult> {
	// Read directly from proposal_valid_transitions via the proposal's actual
	// workflow template (same path as gate_decision). Dropped the proposal_type_config
	// JOIN — it was an indirection that broke when ptc had no row for the workflow
	// name (e.g. 'Standard RFC' only maps 'directive' not 'feature' in ptc).
	const { rows } = await query<TransitionRuleRow>(
		`SELECT pvt.from_state, pvt.to_state, pvt.allowed_reasons, pvt.allowed_roles, pvt.requires_ac
     FROM roadmap_proposal.proposal_valid_transitions pvt
     JOIN roadmap.workflows w ON w.proposal_id = $1
     JOIN roadmap.workflow_templates wt ON wt.id = w.template_id
     WHERE pvt.workflow_name = wt.name
       AND LOWER(pvt.from_state) = LOWER($2)
       AND LOWER(pvt.to_state) = LOWER($3)
     LIMIT 1`,
		[proposalId, fromState, toState],
	);

	if (rows.length === 0) {
		return {
			valid: false,
			error: {
				code: "INVALID_TRANSITION",
				message: `Transition ${fromState} → ${toState} is not allowed for this proposal's workflow`,
				context: { fromState, toState, proposalId },
			},
		};
	}

	return { valid: true };
}

/**
 * AC-5: Check that current-stage maturity is 'mature' before promotion.
 * Returns structured error identifying the blocking stage.
 */
async function validateMaturityGate(
	proposalId: number,
	currentState: string,
): Promise<TransitionValidationResult> {
	const { rows } = await query<{ maturity: string }>(
		`SELECT maturity FROM roadmap_proposal.proposal WHERE id = $1 LIMIT 1`,
		[proposalId],
	);

	if (rows.length === 0) {
		return {
			valid: false,
			error: {
				code: "INVALID_TRANSITION",
				message: `Proposal ${proposalId} not found`,
				context: { proposalId },
			},
		};
	}

	const maturityState = rows[0].maturity;

	if (maturityState !== Maturity.MATURE) {
		return {
			valid: false,
			error: {
				code: "MATURITY_GATE_BLOCKED",
				message: `Cannot promote: proposal maturity is '${maturityState}', must be '${Maturity.MATURE}' to transition from ${currentState}`,
				context: {
					proposalId,
					currentState,
					currentMaturity: maturityState,
					requiredMaturity: Maturity.MATURE,
				},
			},
		};
	}

	return { valid: true };
}

/**
 * AC-19: Check acceptance criteria gate.
 * Blocks the Accepted transition when any non-waived criterion is pending or fail.
 * Returns structured error identifying the blocking criterion item_number(s).
 */
async function validateACGate(
	proposalId: number,
	toState: string,
): Promise<TransitionValidationResult> {
	// Only gate transitions to Accepted/Complete states
	const gatedStates = ["accepted", "complete", "merged"];
	if (!gatedStates.includes(toState.toLowerCase())) {
		return { valid: true };
	}

	const { rows } = await query<ProposalAcceptanceCriterionRow>(
		`SELECT item_number, criterion_text, status
     FROM roadmap_proposal.proposal_acceptance_criteria
     WHERE proposal_id = $1
       AND status NOT IN ('pass', 'waived')
     ORDER BY item_number ASC`,
		[proposalId],
	);

	if (rows.length > 0) {
		const blockingItems = rows.map((r) => r.item_number);
		const blockingDetails = rows.map(
			(r) => `#${r.item_number} (${r.status}): ${r.criterion_text}`,
		);

		return {
			valid: false,
			error: {
				code: "AC_GATE_FAILED",
				message: `Cannot transition to ${toState}: ${rows.length} acceptance criterion/criteria not satisfied`,
				context: {
					proposalId,
					toState,
					blockingItemNumbers: blockingItems,
					blockingDetails,
				},
			},
		};
	}

	return { valid: true };
}

/**
 * P1340 AC-1+AC-2: Administrative identities bypass lease ownership checks.
 * 'system' is the canonical bot-side actor used by the orchestrator's auto-advance
 * path; the configured orchestrator identity is the matchmaker process itself.
 * Neither needs a per-proposal lease to flip status or maturity — they are
 * operating on the proposal's behalf and any lease conflict is incidental, not
 * structural. Anyone else (named agencies, gating roles) goes through the normal
 * lease-ownership check.
 */
export const ADMIN_IDENTITIES = new Set<string>([
	"system",
	"orchestrator",
	process.env.AGENTHIVE_ORCHESTRATOR_IDENTITY ?? "agenthive/agency-orchestrator",
]);

export function isAdminIdentity(agentIdentity: string): boolean {
	return ADMIN_IDENTITIES.has(agentIdentity);
}

/**
 * AC-LEASE: Check that the agent holds a valid active lease on the proposal.
 * If another agent holds the lease, return LEASE_CONFLICT. Admin identities
 * (P1340 AC-1) short-circuit valid:true without consulting proposal_lease.
 */
export async function validateLease(
	proposalId: number,
	agentIdentity: string,
): Promise<TransitionValidationResult> {
	// P1340 AC-1: admin-identity bypass. 'system' and the configured orchestrator
	// identity skip the lease check entirely so the auto-advance / scanQueues /
	// reaper paths can operate without first claiming a lease (which they could
	// not safely release on crash anyway).
	if (isAdminIdentity(agentIdentity)) {
		return { valid: true };
	}

	const { rows } = await query<LeaseRow>(
		`SELECT agent_identity, expires_at, released_at
     FROM roadmap_proposal.proposal_lease
     WHERE proposal_id = $1 AND released_at IS NULL
     ORDER BY claimed_at DESC
     LIMIT 1`,
		[proposalId],
	);

	// P1340 AC-3: lease-conflict errors include the explicit prop_claim --force
	// shortcut so non-admin callers can resolve without guessing the schema.
	const forceHint = (id: number) =>
		`To take over the lease: mcp_proposal action=claim { id: "${id}", agent: "${agentIdentity}", force: true } (or MCP CLI: prop_claim --id ${id} --agent ${agentIdentity} --force).`;

	if (rows.length === 0) {
		return {
			valid: false,
			error: {
				code: "LEASE_CONFLICT",
				message: `No active lease on proposal ${proposalId}. Agent '${agentIdentity}' must claim a lease before transitioning. ${forceHint(proposalId)}`,
				context: {
					proposalId,
					requestingAgent: agentIdentity,
					reason: "no_lease",
				},
			},
		};
	}

	const lease = rows[0];

	if (lease.expires_at && new Date(lease.expires_at) < new Date()) {
		return {
			valid: false,
			error: {
				code: "LEASE_CONFLICT",
				message: `Lease on proposal ${proposalId} has expired (expired: ${lease.expires_at}). Agent '${agentIdentity}' must renew or re-claim. ${forceHint(proposalId)}`,
				context: {
					proposalId,
					requestingAgent: agentIdentity,
					expiresAt: lease.expires_at,
					reason: "lease_expired",
				},
			},
		};
	}

	if (lease.agent_identity !== agentIdentity) {
		return {
			valid: false,
			error: {
				code: "LEASE_CONFLICT",
				message: `Proposal is leased by '${lease.agent_identity}', not '${agentIdentity}'. ${forceHint(proposalId)}`,
				context: {
					proposalId,
					currentLeaseHolder: lease.agent_identity,
					requestingAgent: agentIdentity,
					expiresAt: lease.expires_at,
				},
			},
		};
	}

	return { valid: true };
}

/**
 * AC-6: Check that a dependency addition would not create a cycle.
 * Uses recursive CTE to detect cycles in proposal_dependencies.
 */
async function validateNoCycles(
	proposalId: number,
	toState: string,
): Promise<TransitionValidationResult> {
	// Only check cycles for dependency-sensitive transitions
	const dependencySensitiveStates = ["merged", "complete"];
	if (!dependencySensitiveStates.includes(toState.toLowerCase())) {
		return { valid: true };
	}

	const { rows } = await query<CycleCheckRow>(
		`WITH RECURSIVE dep_graph AS (
       -- Start from this proposal's dependencies
       SELECT from_proposal_id, to_proposal_id, ARRAY[from_proposal_id] AS path
       FROM roadmap_proposal.proposal_dependencies
       WHERE from_proposal_id = $1 AND NOT resolved

       UNION ALL

       -- Follow the chain
       SELECT pd.from_proposal_id, pd.to_proposal_id, dg.path || pd.from_proposal_id
       FROM roadmap_proposal.proposal_dependencies pd
       JOIN dep_graph dg ON pd.from_proposal_id = dg.to_proposal_id
       WHERE NOT pd.resolved
         AND pd.from_proposal_id != ALL(dg.path)  -- prevent infinite loops
     )
     SELECT
       EXISTS (
         SELECT 1 FROM dep_graph
         WHERE to_proposal_id = $1
       ) AS would_create_cycle,
       ARRAY(
         SELECT to_proposal_id FROM dep_graph
         WHERE to_proposal_id = $1
         LIMIT 1
       ) AS cycle_path`,
		[proposalId],
	);

	if (rows[0]?.would_create_cycle) {
		return {
			valid: false,
			error: {
				code: "DAG_CYCLE_DETECTED",
				message: `Transition would create a dependency cycle involving proposal ${proposalId}`,
				context: {
					proposalId,
					toState,
					cyclePath: rows[0].cycle_path,
				},
			},
		};
	}

	return { valid: true };
}

/**
 * Validate role-based access for a transition.
 * AC-12: checks allowed_roles from proposal_valid_transitions.
 */
export async function validateRole(
	proposalId: number,
	fromState: string,
	toState: string,
	agentRoles: string[],
): Promise<TransitionValidationResult> {
	const { rows } = await query<{ allowed_roles: string[] | null }>(
		`SELECT pvt.allowed_roles
     FROM roadmap_proposal.proposal_valid_transitions pvt
     JOIN roadmap.workflows w ON w.proposal_id = $1
     JOIN roadmap.workflow_templates wt ON wt.id = w.template_id
     WHERE pvt.workflow_name = wt.name
       AND LOWER(pvt.from_state) = LOWER($2)
       AND LOWER(pvt.to_state) = LOWER($3)
     LIMIT 1`,
		[proposalId, fromState, toState],
	);

	if (rows.length === 0 || !rows[0].allowed_roles) {
		// No role restriction
		return { valid: true };
	}

	const allowedRoles = rows[0].allowed_roles;
	if (allowedRoles.includes("any")) return { valid: true };
	const hasRole = agentRoles.some((role) => allowedRoles.includes(role));

	if (!hasRole) {
		return {
			valid: false,
			error: {
				code: "ROLE_VIOLATION",
				message: `Agent lacks required role for ${fromState} → ${toState} transition`,
				context: {
					proposalId,
					fromState,
					toState,
					requiredRoles: allowedRoles,
					agentRoles,
				},
			},
		};
	}

	return { valid: true };
}

/**
 * Format a ValidationError for human-readable display.
 */
export function formatValidationError(error: ValidationError): string {
	const icon =
		error.code === "INVALID_TRANSITION"
			? "🚫"
			: error.code === "MATURITY_GATE_BLOCKED"
				? "⏳"
				: error.code === "AC_GATE_FAILED"
					? "📋"
					: error.code === "DAG_CYCLE_DETECTED"
						? "🔄"
						: error.code === "LEASE_CONFLICT"
							? "🔒"
							: error.code === "DRAFT_QUALITY_GATE"
								? "📝"
								: "⛔";
	return `${icon} [${error.code}] ${error.message}`;
}

/**
 * Check if a specific proposal has all acceptance criteria passing.
 * Returns the blocking criteria if any.
 */
export async function checkACStatus(
	proposalId: number,
): Promise<{ allPassed: boolean; blockingCriteria: ProposalAcceptanceCriterionRow[] }> {
	const { rows } = await query<ProposalAcceptanceCriterionRow>(
		`SELECT item_number, criterion_text, status, verified_by, verification_notes, verified_at
     FROM roadmap_proposal.proposal_acceptance_criteria
     WHERE proposal_id = $1
       AND status NOT IN ('pass', 'waived')
     ORDER BY item_number ASC`,
		[proposalId],
	);

	return {
		allPassed: rows.length === 0,
		blockingCriteria: rows,
	};
}

/**
 * Get the current maturity state for a proposal.
 */
export async function getMaturityState(
	proposalId: number,
): Promise<{ currentState: string; maturityState: string } | null> {
	const { rows } = await query<{ status: string; maturity: string }>(
		`SELECT status, maturity FROM roadmap_proposal.proposal WHERE id = $1 LIMIT 1`,
		[proposalId],
	);

	if (rows.length === 0) return null;
	return {
		currentState: rows[0].status,
		maturityState: rows[0].maturity,
	};
}
