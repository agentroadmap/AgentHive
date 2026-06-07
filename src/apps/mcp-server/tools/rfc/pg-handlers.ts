/**
 * Postgres-backed RFC Workflow MCP Tools for AgentHive.
 *
 * Implements the RFC state machine: Draft → Review → Develop → Merge → Complete
 * With maturity lifecycle: New(0) → Active(1) → Mature(2) → Obsolete(3)
 *
 * Matches live schema on agenthive DB (applied by Andy):
 * - proposal_state_transitions (audit trail)
 * - proposal_acceptance_criteria (AC tracking)
 * - proposal_discussions (threaded, with pgvector)
 * - proposal_reviews (structured reviews)
 * - proposal_valid_transitions (data-driven state machine)
 * - proposal_dependencies (DAG)
 */

import { getPool, query } from "../../../../postgres/pool.ts";
import {
	validateLease,
	formatValidationError,
} from "../../../../core/proposal/proposal-integrity.ts";
import { RfcStates } from "../../../../core/workflow/state-names.ts";
import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";
import {
	validateAcEvidence,
	AC_SCHEMA_VERSION,
} from "../../schema/ac-evidence.ts";

// Batch-advance guard: tracks recent verify_ac timestamps per proposal (P707).
// More than 2 calls within a 5-second window returns 429 BATCH_GUARD_TRIGGERED.
const _batchGuardMap = new Map<string, number[]>();
const BATCH_WINDOW_MS = 5_000;
const BATCH_LIMIT = 2;

function checkBatchGuard(proposalId: string): { blocked: boolean; retryAfterMs?: number } {
	const now = Date.now();
	const cutoff = now - BATCH_WINDOW_MS;
	const timestamps = (_batchGuardMap.get(proposalId) ?? []).filter((t) => t > cutoff);
	if (timestamps.length >= BATCH_LIMIT) {
		const oldestInWindow = timestamps[0];
		const retryAfterMs = BATCH_WINDOW_MS - (now - oldestInWindow);
		return { blocked: true, retryAfterMs: Math.max(0, retryAfterMs) };
	}
	timestamps.push(now);
	_batchGuardMap.set(proposalId, timestamps);
	// Evict stale entries after 30 s to bound memory
	setTimeout(() => {
		const remaining = (_batchGuardMap.get(proposalId) ?? []).filter((t) => Date.now() - t < 30_000);
		if (remaining.length === 0) _batchGuardMap.delete(proposalId);
		else _batchGuardMap.set(proposalId, remaining);
	}, 30_000).unref?.();
	return { blocked: false };
}

type ResolvedProposal = {
	id: number;
	display_id: string;
	type: string;
	title: string;
	status: string;
	maturity: 'new' | 'active' | 'mature' | 'obsolete';
	summary: string | null;
	motivation: string | null;
	design: string | null;
	drawbacks: string | null;
	alternatives: string | null;
	dependency_note: string | null;
	workflow_id: number | null;
	current_stage: string | null;
	workflow_name: string | null;
};

type TransitionDefinition = {
	to_state: string;
	labels: string[] | null;
	allowed_reasons: string[] | null;
	allowed_roles: string[] | null;
	requires_ac: boolean | string;
};

function errorResult(msg: string, err: unknown): CallToolResult {
	return {
		content: [
			{
				type: "text",
				text: `⚠️ ${msg}: ${err instanceof Error ? err.message : String(err)}`,
			},
		],
	};
}

/** Transition type labels derived from from→to state mapping */
function classifyTransition(from: string, to: string): string {
	if (to === RfcStates.COMPLETE) return "decision";
	// Going backward in state sequence
	const order = [RfcStates.DRAFT, RfcStates.REVIEW, RfcStates.DEVELOP, RfcStates.MERGE, RfcStates.COMPLETE];
	const fromIdx = order.indexOf(from.toUpperCase());
	const toIdx = order.indexOf(to.toUpperCase());
	if (toIdx < fromIdx) return "iteration";
	if (toIdx === fromIdx) return "depend";
	return "mature";
}

/**
 * Coerce a proposal identifier to its canonical string form. Some MCP clients
 * pass `proposal_id` as a JS number (e.g. `594`); the downstream resolver
 * calls `.trim()` on it, which throws "identifier.trim is not a function" and
 * leaves the gate/review agents unable to read the proposal at all. Tolerate
 * both strings and numbers at the boundary.
 */
function coerceIdentifier(identifier: string | number | null | undefined): string {
	if (identifier === null || identifier === undefined) return "";
	if (typeof identifier === "number") {
		return Number.isFinite(identifier) ? String(identifier) : "";
	}
	return identifier;
}

function parseNumericIdentifier(identifier: string | number): number | null {
	const trimmed = coerceIdentifier(identifier).trim();
	if (!/^\d+$/.test(trimmed)) {
		return null;
	}
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

async function resolveProposalRecord(
	identifierIn: string | number,
): Promise<ResolvedProposal | null> {
	const identifier = coerceIdentifier(identifierIn);
	const numericId = parseNumericIdentifier(identifier);
	const { rows } = await query<ResolvedProposal>(
		`SELECT
       p.id,
       p.display_id,
       p.type,
       p.title,
       p.status,
       p.maturity,
       p.summary,
       p.motivation,
       p.design,
       p.drawbacks,
       p.alternatives,
       p.dependency_note,
       w.id AS workflow_id,
       w.current_stage,
       wt.name AS workflow_name
     FROM roadmap_proposal.proposal p
     LEFT JOIN roadmap.workflows w ON w.proposal_id = p.id
     LEFT JOIN roadmap.workflow_templates wt ON wt.id = w.template_id
     WHERE p.display_id = $1 OR p.id = $2
     LIMIT 1`,
		[identifier, numericId],
	);
	return rows[0] ?? null;
}

async function resolveProposalId(identifier: string | number): Promise<number | null> {
	const proposal = await resolveProposalRecord(identifier);
	return proposal?.id ?? null;
}

async function loadTransitionDefinition(
	proposal: ResolvedProposal,
	requestedState: string,
): Promise<TransitionDefinition | null> {
	const fromState = proposal.current_stage ?? proposal.status;

	if (proposal.workflow_id !== null) {
		const { rows } = await query<{
			to_state: string;
			labels: string[] | null;
			allowed_roles: string[] | null;
			requires_ac: boolean;
		}>(
			`SELECT
         wt.to_stage AS to_state,
         wt.labels,
         wt.allowed_roles,
         wt.requires_ac
       FROM workflow_transitions wt
       JOIN workflows w ON w.template_id = wt.template_id
       WHERE w.proposal_id = $1
         AND LOWER(wt.from_stage) = LOWER($2)
         AND LOWER(wt.to_stage) = LOWER($3)
       LIMIT 1`,
			[proposal.id, fromState, requestedState],
		);

		if (rows[0]) {
			return {
				to_state: rows[0].to_state,
				labels: rows[0].labels,
				allowed_reasons: null,
				allowed_roles: rows[0].allowed_roles,
				requires_ac: rows[0].requires_ac,
			};
		}
	}

	if (proposal.workflow_name) {
		const { rows } = await query<{
			to_state: string;
			allowed_reasons: string[] | null;
			allowed_roles: string[] | null;
			requires_ac: string;
		}>(
			`SELECT
         pvt.to_state,
         pvt.allowed_reasons,
         pvt.allowed_roles,
         pvt.requires_ac
       FROM roadmap_proposal.proposal_valid_transitions pvt
       WHERE pvt.workflow_name = $1
         AND LOWER(pvt.from_state) = LOWER($2)
         AND LOWER(pvt.to_state) = LOWER($3)
       LIMIT 1`,
			[proposal.workflow_name, fromState, requestedState],
		);

		if (rows[0]) {
			return {
				to_state: rows[0].to_state,
				labels: null,
				allowed_reasons: rows[0].allowed_reasons,
				allowed_roles: rows[0].allowed_roles,
				requires_ac: rows[0].requires_ac,
			};
		}
	}

	return null;
}

async function loadMissingRequiredFields(
	proposal: ResolvedProposal,
): Promise<string[]> {
	const { rows } = await query<{ required_fields: string[] | null }>(
		`SELECT required_fields
     FROM roadmap_proposal.proposal_type_config
     WHERE type = $1
     LIMIT 1`,
		[proposal.type],
	);

	const requiredFields = rows[0]?.required_fields ?? [];
	const content: Record<string, string | null> = {
		title: proposal.title,
		summary: proposal.summary,
		motivation: proposal.motivation,
		design: proposal.design,
		drawbacks: proposal.drawbacks,
		alternatives: proposal.alternatives,
		dependency_note: proposal.dependency_note,
	};

	return requiredFields.filter((field) => {
		const value = content[field];
		return typeof value !== "string" || value.trim().length === 0;
	});
}

async function hasOutstandingAcceptanceCriteria(
	proposalId: number,
): Promise<boolean> {
	const { rows } = await query<{ outstanding_count: number }>(
		`SELECT COUNT(*)::int AS outstanding_count
     FROM roadmap_proposal.proposal_acceptance_criteria
     WHERE proposal_id = $1
       AND status <> 'pass'`,
		[proposalId],
	);
	return (rows[0]?.outstanding_count ?? 0) > 0;
}

function transitionNeedsAcceptanceCriteria(
	definition: TransitionDefinition,
): boolean {
	if (typeof definition.requires_ac === "boolean") {
		return definition.requires_ac;
	}
	return definition.requires_ac !== "none";
}

function deriveTransitionReason(
	definition: TransitionDefinition,
	fromState: string,
	toState: string,
): string {
	return (
		definition.allowed_reasons?.[0] ??
		definition.labels?.[0] ??
		classifyTransition(fromState, toState)
	);
}

function deriveMaturityLabel(
	_proposal: ResolvedProposal,
	_fromState: string,
	_toState: string,
): string {
	return "new";
}

// ─── State Transitions ──────────────────────────────────────────────────────

export async function transitionProposal(args: {
	proposal_id: string;
	to_state: string;
	decided_by: string;
	rationale?: string;
}): Promise<CallToolResult> {
	try {
		const proposal = await resolveProposalRecord(args.proposal_id);
		if (!proposal) {
			return {
				content: [
					{ type: "text", text: `Proposal ${args.proposal_id} not found.` },
				],
			};
		}

		const fromState = proposal.current_stage ?? proposal.status;
		const transition = await loadTransitionDefinition(proposal, args.to_state);
		if (!transition) {
			return {
				content: [
					{
						type: "text",
						text: `❌ Invalid transition: ${fromState} → ${args.to_state}`,
					},
				],
			};
		}

		const missingFields = await loadMissingRequiredFields(proposal);
		if (missingFields.length > 0) {
			return {
				content: [
					{
						type: "text",
						text: `❌ Cannot transition ${args.proposal_id}: missing required fields for type ${proposal.type}: ${missingFields.join(", ")}`,
					},
				],
			};
		}

	if (
		transitionNeedsAcceptanceCriteria(transition) &&
		(await hasOutstandingAcceptanceCriteria(proposal.id))
	) {
		return {
			content: [
				{
					type: "text",
					text: `❌ Cannot transition ${args.proposal_id}: acceptance criteria must all pass first.`,
				},
			],
		};
	}

		// AC-3: Require active lease before allowing transition
		const leaseResult = await validateLease(proposal.id, args.decided_by);
		if (!leaseResult.valid) {
			return {
				content: [
					{
						type: "text",
						text: `🔒 ${formatValidationError(leaseResult.error!)}`,
					},
				],
			};
		}

		const toState = transition.to_state;
		const reason = deriveTransitionReason(transition, fromState, toState);
		const maturityLabel = deriveMaturityLabel(proposal, fromState, toState);

		await query(
			`WITH _actor AS (
         SELECT set_config('app.agent_identity', $1, true) AS agent_identity
       )
       UPDATE roadmap_proposal.proposal
       SET status = $2,
           maturity = $3,
           modified_at = NOW()
       FROM _actor
       WHERE id = $4`,
			[args.decided_by, toState, maturityLabel, proposal.id],
		);

		if (proposal.workflow_id !== null) {
			await query(
				`UPDATE workflows
         SET current_stage = $1,
             completed_at = CASE
               WHEN completed_at IS NULL
                 AND NOT EXISTS (
                   SELECT 1
                   FROM workflow_transitions wt
                   WHERE wt.template_id = workflows.template_id
                     AND LOWER(wt.from_stage) = LOWER($1)
                 )
               THEN NOW()
               ELSE completed_at
             END
         WHERE id = $2`,
				[toState, proposal.workflow_id],
			);
		}

		const { rowCount } = await query(
			`UPDATE roadmap_proposal.proposal_state_transitions
       SET transition_reason = $1,
           transitioned_by = $2,
           notes = $3
       WHERE id = (
         SELECT id
         FROM roadmap_proposal.proposal_state_transitions
         WHERE proposal_id = $4
           AND LOWER(from_state) = LOWER($5)
           AND LOWER(to_state) = LOWER($6)
         ORDER BY id DESC
         LIMIT 1
       )`,
			[
				reason,
				args.decided_by,
				args.rationale || null,
				proposal.id,
				fromState,
				toState,
			],
		);

		if ((rowCount ?? 0) === 0) {
			await query(
				`INSERT INTO roadmap_proposal.proposal_state_transitions
           (proposal_id, from_state, to_state, transition_reason, notes, transitioned_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
				[
					proposal.id,
					fromState,
					toState,
					reason,
					args.rationale || null,
					args.decided_by,
				],
			);
		}

		return {
			content: [
				{
					type: "text",
					text: `✅ ${args.proposal_id}: ${fromState} → ${toState} (${reason})\nBy: ${args.decided_by}${args.rationale ? `\nReason: ${args.rationale}` : ""}`,
				},
			],
		};
	} catch (err) {
		return errorResult("Failed to transition proposal", err);
	}
}

// ─── Acceptance Criteria ────────────────────────────────────────────────────

export async function addAcceptanceCriteria(args: {
	proposal_id: string;
	criteria: string[] | string;
}): Promise<CallToolResult> {
	try {
		const proposalId = await resolveProposalId(args.proposal_id);
		if (proposalId === null) {
			return {
				content: [
					{ type: "text", text: `Proposal ${args.proposal_id} not found.` },
				],
			};
		}

		// P156 fix: normalize criteria to always be an array.
		// If a single string is passed, wrap it so for...of doesn't iterate characters.
		const criteriaList: string[] = typeof args.criteria === "string"
			? [args.criteria]
			: Array.isArray(args.criteria)
				? args.criteria
				: [];

		if (criteriaList.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `⚠️ No acceptance criteria provided. Pass an array of strings.`,
					},
				],
			};
		}

		const { rows: maxRow } = await query(
			"SELECT COALESCE(MAX(item_number), 0) as max_idx FROM roadmap_proposal.proposal_acceptance_criteria WHERE proposal_id = $1",
			[proposalId],
		);
		let idx = maxRow[0].max_idx + 1;

		for (const criterion of criteriaList) {
			await query(
				`INSERT INTO roadmap_proposal.proposal_acceptance_criteria (proposal_id, criterion_text, item_number)
         VALUES ($1, $2, $3)`,
				[proposalId, criterion, idx++],
			);
		}

		return {
			content: [
				{
					type: "text",
					text: `✅ Added ${criteriaList.length} AC items to ${args.proposal_id}`,
				},
			],
		};
	} catch (err) {
		return errorResult("Failed to add acceptance criteria", err);
	}
}

export async function verifyAC(args: {
	proposal_id: string;
	item_number: number;
	status: string;
	verified_by: string;
	verification_notes?: string;
	details?: Record<string, unknown>;
	category?: string;
}): Promise<CallToolResult> {
	try {
		// P157 fix: validate required fields and provide clear error messages
		if (!args || !args.proposal_id || args.item_number == null || !args.status || !args.verified_by) {
			return {
				content: [
					{
						type: "text",
						text: `❌ verify_ac requires: proposal_id, item_number, status, verified_by. Got: ${JSON.stringify(args)}`,
					},
				],
			};
		}

		// P707: evidence guard — details required for 'pass' verdicts
		if (args.status === "pass") {
			const evidenceStr = args.details ? JSON.stringify(args.details) : null;
			const evidenceError = validateAcEvidence(evidenceStr);
			if (evidenceError !== null) {
				return {
					content: [
						{
							type: "text",
							text: `❌ [INVALID_EVIDENCE] ${evidenceError}. ` +
								`Pass a 'details' object with evidence (e.g. {"files": [...], "symbols": [...], "grep_evidence": "..."}) ` +
								`before marking an AC as pass. See CONVENTIONS.md §AC-Verification.`,
						},
					],
				};
			}
		}

		// P707: batch-advance guard — breaks same-millisecond bulk-pass pattern
		const guardResult = checkBatchGuard(args.proposal_id);
		if (guardResult.blocked) {
			return {
				content: [
					{
						type: "text",
						text: `❌ [BATCH_GUARD_TRIGGERED] Too many verify_ac calls for ${args.proposal_id} in 5 seconds. ` +
							`Retry after ${Math.ceil((guardResult.retryAfterMs ?? 0) / 1000)}s. ` +
							`Sequential verification required (P707).`,
					},
				],
			};
		}

		const proposalId = await resolveProposalId(args.proposal_id);
		if (proposalId === null) {
			return {
				content: [
					{ type: "text", text: `Proposal ${args.proposal_id} not found.` },
				],
			};
		}

		// Coerce item_number to integer (handles string input from MCP)
		const itemNum = typeof args.item_number === "string"
			? parseInt(args.item_number, 10)
			: args.item_number;

		// Fetch the AC first to confirm it exists and get its text
		const { rows: acRows } = await query(
			`SELECT item_number, criterion_text, status FROM roadmap_proposal.proposal_acceptance_criteria
			 WHERE proposal_id = $1 AND item_number = $2`,
			[proposalId, itemNum],
		);

		if (acRows.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `❌ AC #${itemNum} not found for ${args.proposal_id}. Use list_ac to see available criteria.`,
					},
				],
			};
		}

		const ac = acRows[0];

		// P707 batch-advance guard: max 2 ACs verified per proposal within 5 seconds
		const { rows: recentRows } = await query<{ count: string }>(
			`SELECT COUNT(*) as count
			 FROM roadmap_proposal.proposal_acceptance_criteria
			 WHERE proposal_id = $1 AND verified_at > NOW() - INTERVAL '5 seconds'`,
			[proposalId],
		);
		const recentCount = Number(recentRows[0]?.count ?? 0);
		if (recentCount >= 2) {
			return {
				content: [
					{
						type: "text",
						text: `❌ verify_ac rejected: bulk-advance guard — ${recentCount} ACs already verified in the last 5 seconds for this proposal. Wait before verifying more (P707 §AC-Verification).`,
					},
				],
			};
		}

		await query(
			`UPDATE roadmap_proposal.proposal_acceptance_criteria
			    SET status = $1, verified_by = $2, verification_notes = $3, verified_at = NOW(),
			        details = $6, details_schema_version = $7
			  WHERE proposal_id = $4 AND item_number = $5`,
			[
				args.status,
				args.verified_by,
				args.verification_notes || null,
				proposalId,
				itemNum,
				args.details ? JSON.stringify(args.details) : null,
				args.details ? AC_SCHEMA_VERSION : null,
			],
		);

		const statusEmoji: Record<string, string> = {
			pass: "✅",
			fail: "❌",
			blocked: "🔒",
			waived: "⚪",
		};
		const emoji = statusEmoji[args.status] || "•";

		return {
			content: [
				{
					type: "text",
					text: `${emoji} AC #${itemNum}: "${ac.criterion_text}" → ${args.status} (verified by ${args.verified_by})`,
				},
			],
		};
	} catch (err) {
		return errorResult("Failed to verify AC", err);
	}
}

export async function deleteAC(args: {
	proposal_id: string;
	item_number?: number;
	cleanup_singles?: boolean;
}): Promise<CallToolResult> {
	try {
		const proposalId = await resolveProposalId(args.proposal_id);
		if (proposalId === null) {
			return {
				content: [
					{ type: "text", text: `Proposal ${args.proposal_id} not found.` },
				],
			};
		}

		// Cleanup mode: delete all single-character AC entries (corrupted by P156)
		if (args.cleanup_singles) {
			const { rowCount } = await query(
				`DELETE FROM roadmap_proposal.proposal_acceptance_criteria
				 WHERE proposal_id = $1 AND LENGTH(criterion_text) = 1`,
				[proposalId],
			);
			return {
				content: [
					{
						type: "text",
						text: `🧹 Cleaned up ${rowCount ?? 0} corrupted single-character AC entries from ${args.proposal_id}`,
					},
				],
			};
		}

		// Delete by item_number
		if (args.item_number == null) {
			return {
				content: [
					{
						type: "text",
						text: `❌ delete_ac requires either item_number or cleanup_singles=true. Got: ${JSON.stringify(args)}`,
					},
				],
			};
		}

		const itemNum = typeof args.item_number === "string"
			? parseInt(args.item_number, 10)
			: args.item_number;

		const { rowCount } = await query(
			`DELETE FROM roadmap_proposal.proposal_acceptance_criteria
			 WHERE proposal_id = $1 AND item_number = $2`,
			[proposalId, itemNum],
		);

		if ((rowCount ?? 0) === 0) {
			return {
				content: [
					{
						type: "text",
						text: `❌ AC #${itemNum} not found for ${args.proposal_id}. Use list_ac to see available criteria.`,
					},
				],
			};
		}

		// Renumber remaining ACs to keep item_number sequential
		await query(
			`WITH renumbered AS (
				SELECT id, ROW_NUMBER() OVER (ORDER BY item_number) AS new_num
				FROM roadmap_proposal.proposal_acceptance_criteria
				WHERE proposal_id = $1
			)
			UPDATE roadmap_proposal.proposal_acceptance_criteria pac
			SET item_number = r.new_num
			FROM renumbered r
			WHERE pac.id = r.id AND pac.item_number != r.new_num`,
			[proposalId],
		);

		return {
			content: [
				{
					type: "text",
					text: `🗑️ Deleted AC #${itemNum} from ${args.proposal_id} and renumbered remaining criteria`,
				},
			],
		};
	} catch (err) {
		return errorResult("Failed to delete acceptance criteria", err);
	}
}

export async function listAC(args: {
	proposal_id: string;
}): Promise<CallToolResult> {
	try {
		const proposalId = await resolveProposalId(args.proposal_id);
		if (proposalId === null) {
			return {
				content: [
					{ type: "text", text: `Proposal ${args.proposal_id} not found.` },
				],
			};
		}

		const { rows } = await query(
			`SELECT item_number, criterion_text, status, verified_by, verified_at, verification_notes
       FROM roadmap_proposal.proposal_acceptance_criteria WHERE proposal_id = $1
       ORDER BY item_number`,
			[proposalId],
		);

		if (!rows.length) {
			return {
				content: [
					{
						type: "text",
						text: `No acceptance criteria for ${args.proposal_id}`,
					},
				],
			};
		}

		const statusEmoji: Record<string, string> = {
			pending: "⏳",
			pass: "✅",
			fail: "❌",
			blocked: "🔒",
			waived: "⚪",
		};
		const lines = rows.map(
			(r) =>
				`AC-${r.item_number}: ${r.criterion_text} [${statusEmoji[r.status] || "?"} ${r.status}]${r.verified_by ? ` (by ${r.verified_by})` : ""}`,
		);
		return {
			content: [
				{
					type: "text",
					text: `### AC for ${args.proposal_id}\n${lines.join("\n")}`,
				},
			],
		};
	} catch (err) {
		return errorResult("Failed to list AC", err);
	}
}

// ─── Dependencies ───────────────────────────────────────────────────────────

export async function addDependency(args: {
	proposal_id: string;
	depends_on: string;
	dep_type?: string;
}): Promise<CallToolResult> {
	try {
		const depType = args.dep_type || "blocks";
		const fromProposalId = await resolveProposalId(args.proposal_id);
		if (fromProposalId === null) {
			return {
				content: [
					{ type: "text", text: `Proposal ${args.proposal_id} not found.` },
				],
			};
		}

		const toProposalId = await resolveProposalId(args.depends_on);
		if (toProposalId === null) {
			return {
				content: [
					{
						type: "text",
						text: `Dependency target ${args.depends_on} not found.`,
					},
				],
			};
		}

		await query(
			`INSERT INTO roadmap_proposal.proposal_dependencies (from_proposal_id, to_proposal_id, dependency_type)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
			[fromProposalId, toProposalId, depType],
		);

		return {
			content: [
				{
					type: "text",
					text: `✅ ${args.proposal_id} depends on ${args.depends_on} (${depType})`,
				},
			],
		};
	} catch (err) {
		return errorResult("Failed to add dependency", err);
	}
}

export async function getDependencies(args: {
	proposal_id: string;
}): Promise<CallToolResult> {
	try {
		const proposalId = await resolveProposalId(args.proposal_id);
		if (proposalId === null) {
			return {
				content: [
					{ type: "text", text: `Proposal ${args.proposal_id} not found.` },
				],
			};
		}

		// Use v_blocking_diagram for effective blocking status (migration 020).
		// Falls back to raw query if view doesn't exist yet.
		let rows;
		try {
			const result = await query(
				`SELECT related_display_id, related_title, related_status,
				        related_maturity, dependency_type, resolved_at,
				        is_effective_blocker
				 FROM roadmap_proposal.v_blocking_diagram
				 WHERE proposal_id = $1 AND direction = 'i_depend_on'
				 ORDER BY is_effective_blocker DESC, dependency_type, related_display_id`,
				[proposalId],
			);
			rows = result.rows;
		} catch {
			// View doesn't exist yet — fall back to raw query
			const result = await query(
				`SELECT p.display_id AS related_display_id, p.title AS related_title,
				        p.status AS related_status, p.maturity AS related_maturity,
				        d.dependency_type, d.resolved_at,
				        CASE WHEN d.dependency_type = 'blocks'
				              AND p.maturity NOT IN ('mature', 'obsolete')
				              AND d.resolved_at IS NULL
				         THEN true ELSE false END AS is_effective_blocker
				 FROM roadmap_proposal.proposal_dependencies d
				 JOIN roadmap_proposal.proposal p ON p.id = d.to_proposal_id
				 WHERE d.from_proposal_id = $1
				 ORDER BY is_effective_blocker DESC, d.dependency_type, p.display_id`,
				[proposalId],
			);
			rows = result.rows;
		}

		if (!rows.length) {
			return {
				content: [
					{ type: "text", text: `No dependencies for ${args.proposal_id}` },
				],
			};
		}

		const lines = rows.map((r) => {
			const statusIcon = r.is_effective_blocker ? "🔴" : "✅";
			const maturity = r.related_maturity ? ` [${r.related_maturity}]` : "";
			return `${statusIcon} → ${r.related_display_id} [${r.dependency_type}]${maturity}`;
		});

		const effectiveBlocks = rows.filter((r) => r.is_effective_blocker).length;
		const header = effectiveBlocks > 0
			? `### Dependencies for ${args.proposal_id} (${effectiveBlocks} blocking)`
			: `### Dependencies for ${args.proposal_id} (clear ✓)`;

		return {
			content: [
				{
					type: "text",
					text: `${header}\n${lines.join("\n")}`,
				},
			],
		};
	} catch (err) {
		return errorResult("Failed to get dependencies", err);
	}
}

export async function resolveDependency(args: {
	dep_id: number;
	resolved_by: string;
}): Promise<CallToolResult> {
	try {
		const { rows } = await query(
			`UPDATE roadmap_proposal.proposal_dependencies
			 SET resolved_at = NOW(), resolved_by = $1
			 WHERE id = $2 AND resolved_at IS NULL
			 RETURNING id, from_proposal_id, to_proposal_id, dependency_type`,
			[args.resolved_by, args.dep_id],
		);

		if (!rows.length) {
			return {
				content: [
					{
						type: "text",
						text: `Dependency ${args.dep_id} not found or already resolved.`,
					},
				],
			};
		}

		const dep = rows[0];
		return {
			content: [
				{
					type: "text",
					text: `✅ Dependency ${args.dep_id} resolved: ${dep.from_proposal_id} → ${dep.to_proposal_id} [${dep.dependency_type}] (by ${args.resolved_by})`,
				},
			],
		};
	} catch (err) {
		return errorResult("Failed to resolve dependency", err);
	}
}

// ─── Reviews ────────────────────────────────────────────────────────────────

export async function submitReview(args: {
	proposal_id: string;
	reviewer: string;
	verdict: string;
	findings?: Record<string, any>;
	notes?: string;
	is_blocking?: boolean;
	// Common aliases agents try when they don't recall the canonical name.
	// Treated as fallbacks for `notes` so a misnamed arg doesn't strand a gate run.
	review?: string;
	body?: string;
	content?: string;
	change_requirements?: string[];
	is_blocking?: boolean;
	comment?: string;
}): Promise<CallToolResult> {
	if (!args.notes) {
		args.notes = args.review ?? args.body ?? args.content;
	}
	try {
		const proposalId = await resolveProposalId(args.proposal_id);
		if (proposalId === null) {
			return {
				content: [
					{ type: "text", text: `Proposal ${args.proposal_id} not found.` },
				],
			};
		}

		// P521: Auto-register reviewer on first use to prevent opaque FK errors
		// from blocking specialist subagents who haven't been pre-registered.
		// Slug-format guard prevents arbitrary identifier injection.
		if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(args.reviewer)) {
			return errorResult(
				`Invalid reviewer identity '${args.reviewer}'. Must match ^[a-z][a-z0-9-]*[a-z0-9]$ (lowercase, hyphens, 2+ chars).`,
				"reviewer_format_invalid",
			);
		}
		await query(
			`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, role, skills, status)
			 VALUES ($1, 'llm', 'reviewer', '["review","specialist"]'::jsonb, 'active')
			 ON CONFLICT (agent_identity) DO NOTHING`,
			[args.reviewer],
		);

		// Check for existing review (prevent double-voting)
		const { rows: existing } = await query(
			"SELECT id FROM roadmap_proposal.proposal_reviews WHERE proposal_id = $1 AND reviewer_identity = $2",
			[proposalId, args.reviewer],
		);

		let reviewId: number;
		const isBlocking = args.is_blocking === true;
		if (existing.length) {
			reviewId = existing[0].id;
			await query(
				`UPDATE roadmap_proposal.proposal_reviews SET verdict = $1, notes = $2, findings = $3, is_blocking = $4, comment = $5, reviewed_at = NOW()
         WHERE proposal_id = $6 AND reviewer_identity = $7`,
				[
					args.verdict,
					args.notes || null,
					args.findings ? JSON.stringify(args.findings) : null,
					args.is_blocking ?? false,
					args.comment || null,
				[
					proposalId,
					args.reviewer,
					args.verdict,
					args.notes || null,
					args.findings ? JSON.stringify(args.findings) : null,
					args.is_blocking ?? false,
					args.comment || null,
			inputSchema: {
				type: "object",
				properties: {
					proposal_id: { type: "string" },
					reviewer: {
						type: "string",
						description: "Reviewer identity slug (e.g. 'claude-opus-4-7-on-mac'). Must be lowercase-hyphen format.",
					},
					verdict: {
						type: "string",
						enum: ["approve", "approve_with_changes", "request_changes", "send_back", "reject", "defer", "recuse"],
					},
					notes: { type: "string" },
					is_blocking: {
						type: "boolean",
						description: "When true, marks this review as a hard blocker. Stored on the row; defaults to false.",
					},
					change_requirements: {
						type: "array",
						items: { type: "string" },
						description: "Array of change requirements when verdict is approve_with_changes",
					},
					is_blocking: {
						type: "boolean",
						description: "When true, this review blocks gate advancement until the reviewer approves. Persisted to proposal_reviews.is_blocking.",
					},
					comment: {
						type: "string",
						description: "Optional supplementary comment stored in proposal_reviews.comment (separate from notes).",
					},
				},
				required: ["proposal_id", "reviewer", "verdict"],
			},
			handler: (args: any) => submitReview(args),
		});

		this.server.addTool({
			name: "list_reviews",
			description:
				"List reviews for a proposal. " +
				"Returns reviewer identity, verdict, notes, is_blocking status, and reviewed_at timestamp for each review. " +
				"Blocking reviews (is_blocking=true) are marked [BLOCKING] in the output.",
			inputSchema: {
				type: "object",
				properties: { proposal_id: { type: "string" } },
				required: ["proposal_id"],
			},
			handler: (args: any) => listReviews(args),
		});

		// Discussions
		this.server.addTool({
			name: "add_discussion",
			// Visibility: entries ARE rendered in ProposalDetailsModal (preview mode → Discussions section)
			// via GET /api/proposals/:id/notes. Distinct from submit_review (formal gate verdicts with
			// verdict enum + blocking flags). Use add_discussion for threaded commentary and
			// context-prefixed annotations; use submit_review for operator-visible gate outcomes.
			description:
				"Add a threaded discussion comment to a proposal. " +
				"Required params: proposal_id, author (no default — caller must supply), content (canonical name; do not use discussion/text/body/message aliases, they are stripped by MCP). " +
				"Optional: parent_id (thread reply), context_prefix (arch:|critical:|concern:|security:|general:|feedback:|poc:). " +
				"Entries are visible in the board UI via the Discussions section (/api/proposals/{id}/notes route). " +
				"For formal gate verdicts (ADVANCE/HOLD/REJECT) use `submit_review` instead — it carries a verdict enum and is_blocking flag.",
			inputSchema: {
				type: "object",
				properties: {
					proposal_id: { type: "string" },
					author: { type: "string" },
					content: { type: "string" },
					parent_id: { type: "number" },
					context_prefix: {
						type: "string",
						enum: [
							"arch:",
							"team:",
							"critical:",
							"security:",
							"general:",
							"feedback:",
							"concern:",
							"poc:",
						],
					},
				},
				required: ["proposal_id", "author", "content"],
			},
			handler: (args: any) => addDiscussion(args),
		});

		// Gate decision log
		this.server.addTool({
			name: "record_gate_decision",
			description:
				"Record a gate decision AND, when decision='advance', also flip the proposal status through the gate in one MCP call. " +
				"On 'advance': writes gate_decision_log row → releases any active lease → UPDATEs proposal.status to the inferred next state → resets maturity='new' → appends audit entry. " +
				"On non-advance ('hold'/'reject'/'waive'/'escalate'): only the gate_decision_log row is written; proposal stays put. " +
				"to_state is inferred from `gate` (D1→REVIEW, D2→DEVELOP, D3→MERGE, D4→COMPLETE); pass to_state explicitly to override. " +
				"Use this instead of stdout so the orchestrator/operator gets a single atomic gate advance with no follow-up calls needed.",
			inputSchema: {
				type: "object",
				properties: {
					proposal_id: { type: "string" },
					gate: { type: "string", description: "Gate level: D1, D2, D3, or D4. Auto-maps to next state on advance." },
					decision: {
						type: "string",
						enum: ["advance", "hold", "reject", "waive", "escalate"],
						description: "advance = also do the status transition; others only log the decision.",
					},
					rationale: { type: "string", description: "Why this decision — surfaced in audit + future reviews." },
					decided_by: { type: "string", description: "Agent identity making the decision" },
					authority_agent: { type: "string" },
					agent_run_id: { type: "string", description: "agent_runs.id — used for dedup (shadow-mode)" },
					ac_verification: {
						type: "object",
						description: "JSONB with per-criterion pass/fail map",
					},
					to_state: {
						type: "string",
						description: "OPTIONAL override of the inferred next state. Normally leave blank — D1/D2/D3/D4 → REVIEW/DEVELOP/MERGE/COMPLETE.",
					},
				},
				required: ["proposal_id", "gate", "decision"],
			},
			handler: (args: any) => recordGateDecision(args),
		});

		// eslint-disable-next-line no-console
		console.error(
			"[MCP] Registered 13 RFC workflow tools (state machine, AC, deps, reviews, discussions, gate_decision)",
		);
	}
}
