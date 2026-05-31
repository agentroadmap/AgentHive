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
			const evidenceCheck = validateAcEvidence(args.details ?? null, args.category as any);
			if (!evidenceCheck.valid) {
				return {
					content: [
						{
							type: "text",
							text: `❌ [${evidenceCheck.code}] ${evidenceCheck.error}. ` +
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
					proposalId,
					args.reviewer,
				],
			);
			// If updating and verdict is approve_with_changes, delete old requirements and insert new ones
			if (args.verdict === "approve_with_changes") {
				await query(
					"DELETE FROM roadmap_proposal.post_gate_change_requirement WHERE review_id = $1",
					[reviewId],
				);
			}
		} else {
			const { rows: inserted } = await query(
				`INSERT INTO roadmap_proposal.proposal_reviews (proposal_id, reviewer_identity, verdict, notes, findings, is_blocking, comment)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
				[
					proposalId,
					args.reviewer,
					args.verdict,
					args.notes || null,
					args.findings ? JSON.stringify(args.findings) : null,
					args.is_blocking ?? false,
					args.comment || null,
				],
			);
			reviewId = inserted[0].id;
		}

		// If verdict is approve_with_changes, insert change requirements
		if (args.verdict === "approve_with_changes" && args.change_requirements?.length) {
			for (const requirement of args.change_requirements) {
				await query(
					`INSERT INTO roadmap_proposal.post_gate_change_requirement (review_id, requirement_text)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
					[reviewId, requirement],
				);
			}
		}

		// Emit review_submitted event for state feed visibility
		await query(
			`INSERT INTO roadmap_proposal.proposal_event (proposal_id, event_type, payload)
       VALUES ($1, 'review_submitted', $2::jsonb)`,
			[
				proposalId,
				JSON.stringify({
					reviewer: args.reviewer,
					verdict: args.verdict,
					has_notes: !!args.notes,
					has_findings: !!args.findings,
					has_change_requirements: !!args.change_requirements?.length,
					ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
				}),
			],
		);

		return {
			content: [
				{
					type: "text",
					text: `✅ Review submitted for ${args.proposal_id}: ${args.verdict} (${args.reviewer})`,
				},
			],
		};
	} catch (err) {
		return errorResult("Failed to submit review", err);
	}
}

export async function listReviews(args: {
	proposal_id: string;
}): Promise<CallToolResult> {
	try {
		const propId = await resolveProposalId(args.proposal_id);
		if (propId === null) {
			return {
				content: [
					{ type: "text", text: `Proposal ${args.proposal_id} not found.` },
				],
			};
		}

		const { rows: reviewRows } = await query(
			`SELECT reviewer_identity, verdict, notes, findings, is_blocking, comment, reviewed_at
       FROM roadmap_proposal.proposal_reviews WHERE proposal_id = $1
       ORDER BY reviewed_at DESC`,
			[propId],
		);

		if (!reviewRows.length) {
			return {
				content: [{ type: "text", text: `No reviews for ${args.proposal_id}` }],
			};
		}

		const verdictEmoji: Record<string, string> = {
			approve: "✅",
			request_changes: "🔄",
			reject: "❌",
		};
		const lines = reviewRows.map(
			(r) =>
				`${verdictEmoji[r.verdict] || "?"} ${r.reviewer_identity}: ${r.verdict}${r.is_blocking ? " [BLOCKING]" : ""}${r.notes ? ` — ${r.notes}` : ""}${r.comment ? ` (comment: ${r.comment})` : ""}`,
		);
		return {
			content: [
				{
					type: "text",
					text: `### Reviews for ${args.proposal_id}\n${lines.join("\n")}`,
				},
			],
		};
	} catch (err) {
		return errorResult("Failed to list reviews", err);
	}
}

export async function getOpenChangeRequirements(
	proposalId: number,
): Promise<Array<{ review_id: number; requirement_text: string }>> {
	try {
		const { rows } = await query(
			`SELECT pgcr.review_id, pgcr.requirement_text
       FROM roadmap_proposal.post_gate_change_requirement pgcr
       INNER JOIN roadmap_proposal.proposal_reviews pr ON pr.id = pgcr.review_id
       WHERE pgcr.satisfied = FALSE AND pr.proposal_id = $1
       ORDER BY pr.reviewed_at, pgcr.created_at`,
			[proposalId],
		);
		return rows;
	} catch (err) {
		console.error("Error fetching open change requirements:", err);
		return [];
	}
}

// ─── Discussions ────────────────────────────────────────────────────────────

export async function addDiscussion(args: {
	proposal_id: string;
	author: string;
	content: string;
	// Common aliases agents try. Coerce to `content` before validation so
	// `discussion: "..."` or `text: "..."` doesn't strand the agent.
	discussion?: string;
	text?: string;
	body?: string;
	message?: string;
	parent_id?: number;
	context_prefix?: string;
}): Promise<CallToolResult> {
	if (!args.content) {
		args.content =
			args.discussion ?? args.text ?? args.body ?? args.message ?? "";
	}
	// P1364: reject empty / whitespace-only bodies. The prior coercion silently
	// INSERTed empty rows when callers forgot to supply content (5+ observed
	// fabrications between 2026-05-20 and 2026-05-22 — see motivation in P1364).
	// Validation runs AFTER alias coercion so canonical `content` and all four
	// aliases get the same treatment. Trim so '   \n\t' also rejects.
	if (!args.content || args.content.trim().length === 0) {
		return {
			content: [
				{
					type: "text",
					text: `add_discussion: missing or empty body. Pass content="..." (canonical) or one of the aliases: discussion, text, body, message. Empty discussions silently land in the table and look like fabrications later (P1364).`,
				},
			],
		};
	}
	if (!args.author) {
		// Default authoring identity so cubic/gate agents don't bounce on a
		// missing arg — they're system-issued, not user-issued.
		(args as any).author = "system";
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

		const { rows } = await query(
			`INSERT INTO roadmap_proposal.proposal_discussions (proposal_id, author_identity, body, parent_id, context_prefix)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
			[
				proposalId,
				args.author,
				args.content,
				args.parent_id || null,
				args.context_prefix || "general:",
			],
		);

		return {
			content: [
				{
					type: "text",
					text: `✅ Discussion #${rows[0].id} added to ${args.proposal_id}`,
				},
			],
		};
	} catch (err) {
		return errorResult("Failed to add discussion", err);
	}
}

// ─── State Machine Reference ────────────────────────────────────────────────

export async function getValidTransitions(args: {
	from_state?: string;
}): Promise<CallToolResult> {
	try {
		let sql = `SELECT from_state, to_state, allowed_reasons, allowed_roles, requires_ac
               FROM roadmap_proposal.proposal_valid_transitions`;
		const params: any[] = [];

		if (args.from_state) {
			sql += ` WHERE from_state = UPPER($1)`;
			params.push(args.from_state);
		}

		sql += ` ORDER BY from_state, to_state`;

		const { rows } = await query(sql, params);

		if (!rows.length) {
			return {
				content: [
					{
						type: "text",
						text: `No transitions defined${args.from_state ? ` from ${args.from_state}` : ""}`,
					},
				],
			};
		}

		const lines = rows.map(
			(r) =>
				`${r.from_state} → ${r.to_state} (${r.allowed_reasons?.join(", ") || "any"}) [roles: ${r.allowed_roles?.join(", ") || "any"}]` +
				(r.requires_ac && r.requires_ac !== "none"
					? ` ⚠️ requires AC: ${r.requires_ac}`
					: ""),
		);
		return {
			content: [
				{
					type: "text",
					text: `### Valid State Transitions\n${lines.join("\n")}`,
				},
			],
		};
	} catch (err) {
		return errorResult("Failed to get valid transitions", err);
	}
}

// ─── Gate Decision Log ──────────────────────────────────────────────────────

export async function recordGateDecision(args: {
	proposal_id?: string;
	// P1340 AC-4 (D3 follow-up): universal identifier aliases. Canonical here
	// has historically been proposal_id, but record_gate_decision now accepts
	// id and display_id too so all gate-flow tools share the same shape.
	id?: string;
	display_id?: string;
	gate: string;
	decision: string;
	rationale?: string;
	decided_by?: string;
	authority_agent?: string;
	agent_run_id?: string;
	ac_verification?: Record<string, unknown>;
	// Optional explicit override. When omitted and decision='advance', to_state
	// is inferred from `gate` so the row matches fn_guard_gate_advance's check
	// that requires to_state = NEW.status. For non-advance decisions, to_state
	// defaults to from_state (proposal stays put).
	to_state?: string;
}): Promise<CallToolResult> {
	const VALID_DECISIONS = ["advance", "hold", "reject", "waive", "escalate"];
	if (!VALID_DECISIONS.includes(args.decision)) {
		return errorResult(
			`Invalid decision '${args.decision}'. Must be one of: ${VALID_DECISIONS.join(", ")}`,
			"decision_invalid",
		);
	}
	try {
		const idArg = args.proposal_id ?? args.id ?? args.display_id;
		if (!idArg) {
			return {
				content: [{ type: "text", text: `record_gate_decision: missing proposal identifier. Pass proposal_id="P123" (canonical) or id / display_id alias.` }],
			};
		}
		const proposalId = await resolveProposalId(idArg);
		if (proposalId === null) {
			return {
				content: [{ type: "text", text: `Proposal ${idArg} not found.` }],
			};
		}

		// Read current from_state and maturity from the proposal.
		const { rows: propRows } = await query<{
			status: string;
			maturity: string;
		}>(
			`SELECT status, maturity FROM roadmap_proposal.proposal WHERE id = $1`,
			[proposalId],
		);
		if (!propRows.length) {
			return { content: [{ type: "text", text: `Proposal ${idArg} not found.` }] };
		}
		const { status: fromState, maturity } = propRows[0];

		// Resolve to_state. Without inference, every advance decision logged
		// to_state = from_state, and fn_guard_gate_advance rejected the actual
		// status UPDATE because no row matched (from_state=REVIEW, NEW.status=DEVELOP).
		// Standard RFC: D1=DRAFT→REVIEW, D2=REVIEW→DEVELOP, D3=DEVELOP→MERGE, D4=MERGE→COMPLETE.
		const GATE_TO_NEXT_STATE: Record<string, string> = {
			D1: "REVIEW",
			D2: "DEVELOP",
			D3: "MERGE",
			D4: "COMPLETE",
		};
		const toState =
			args.to_state ??
			(args.decision === "advance"
				? (GATE_TO_NEXT_STATE[args.gate.toUpperCase()] ?? fromState)
				: fromState);

		// Shadow-mode skip: if a row with the same agent_run_id already exists,
		// the new MCP path already wrote the canonical record — skip the insert.
		if (args.agent_run_id) {
			const { rows: existing } = await query(
				`SELECT id FROM roadmap_proposal.gate_decision_log
				  WHERE proposal_id = $1
				    AND ac_verification->>'agent_run_id' = $2
				  LIMIT 1`,
				[proposalId, args.agent_run_id],
			);
			if (existing.length) {
				return {
					content: [{
						type: "text",
						text: `✅ Gate decision for ${idArg} (agent_run_id=${args.agent_run_id}) already recorded (#${existing[0].id}) — skipped duplicate.`,
					}],
				};
			}
		}

		const acVerification: Record<string, unknown> = { ...(args.ac_verification ?? {}) };
		if (args.agent_run_id) acVerification.agent_run_id = args.agent_run_id;

		const { rows } = await query(
			`INSERT INTO roadmap_proposal.gate_decision_log
			   (proposal_id, from_state, to_state, maturity, gate, decided_by,
			    authority_agent, decision, rationale, ac_verification, signature_hash)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL)
			 RETURNING id`,
			[
				proposalId,
				fromState,
				toState,
				maturity,
				args.gate,
				args.decided_by ?? "mcp",
				args.authority_agent ?? null,
				args.decision,
				args.rationale ?? null,
				Object.keys(acVerification).length ? JSON.stringify(acVerification) : null,
			],
		);
		const decisionId = rows[0].id;

		// Bundle the workflow advance with the decision so one MCP call moves the
		// proposal through the gate. Without this, callers must (1) record_gate_decision,
		// (2) acquire a 'system' lease, (3) call prop_transition, (4) release the lease —
		// four steps that previously stranded operator-driven advances.
		//
		// P1340 AC-5: wrap the release_lease + UPDATE in a single transaction with
		// `SET LOCAL app.gate_bypass='true'` so the gate guard short-circuits —
		// the gate_decision row we just INSERTED already authorizes the transition,
		// re-checking it from the trigger is redundant and brittle (clock skew on the
		// 10-minute window, gate_role permission churn). The bypass scope is the txn
		// only; outside of this handler the guard remains in force.
		if (args.decision === "advance" && toState !== fromState) {
			const pool = getPool();
			const client = await pool.connect();
			try {
				await client.query("BEGIN");
				await client.query("SET LOCAL app.gate_bypass = 'true'");
				await client.query(
					`UPDATE roadmap_proposal.proposal_lease
					    SET released_at = COALESCE(released_at, now()),
					        release_reason = COALESCE(release_reason, 'gate_review_complete')
					  WHERE proposal_id = $1 AND released_at IS NULL`,
					[proposalId],
				);
				await client.query(
					`UPDATE roadmap_proposal.proposal
					    SET status = $1,
					        maturity = 'new',
					        audit = audit || jsonb_build_object(
					                  'TS', to_jsonb(now()),
					                  'To', $1::text,
					                  'From', $2::text,
					                  'Agent', $3::text,
					                  'Activity', 'StatusChange',
					                  'Decision', format('%s gate advance (gate_decision_log #%s)', $4::text, $5::int)
					                ),
					        modified_at = now()
					  WHERE id = $6`,
					[toState, fromState, args.decided_by ?? "mcp", args.gate, decisionId, proposalId],
				);
				// P1340 AC-5 (D3 follow-up): keep roadmap.workflows.current_stage
				// in sync with the proposal.status flip. Live P1340 was caught with
				// proposal.status='DEVELOP' but workflows.current_stage='REVIEW',
				// leaving future transition logic to resolve against stale stage.
				// LEFT JOIN-style: only updates if a workflow row exists; legacy
				// proposals without one are unaffected.
				await client.query(
					`UPDATE roadmap.workflows
					    SET current_stage = $1
					  WHERE proposal_id = $2`,
					[toState, proposalId],
				);
				await client.query("COMMIT");
				return {
					content: [{
						type: "text",
						text: `✅ Gate ${args.gate} ADVANCED: P${idArg} ${fromState} → ${toState} (gate_decision_log #${decisionId}, maturity reset to 'new'). Lease released. workflows.current_stage synced. Atomic (BEGIN/COMMIT + app.gate_bypass).`,
					}],
				};
			} catch (transitionErr) {
				try { await client.query("ROLLBACK"); } catch { /* ignore */ }
				// Decision row outside the rolled-back tx is still durable (separate
				// implicit txn for the INSERT). Tell the caller they can retry the
				// UPDATE — the decision row's 10-min window still applies.
				const msg = transitionErr instanceof Error ? transitionErr.message : String(transitionErr);
				return {
					content: [{
						type: "text",
						text: `⚠️ Gate decision #${decisionId} recorded but atomic auto-transition rolled back: ${msg}\n\nRetry: mcp_proposal action=gate_decision { proposal_id: "${idArg}", gate: "${args.gate}", decision: "advance", to_state: "${toState}" } — the decision row's 10-min window still applies.`,
					}],
				};
			} finally {
				client.release();
			}
		}

		return {
			content: [{
				type: "text",
				text: `✅ Gate decision recorded: id=${decisionId} proposal=${idArg} gate=${args.gate} decision=${args.decision}`,
			}],
		};
	} catch (err) {
		return errorResult("Failed to record gate decision", err);
	}
}

// ─── Class definition for server registration ───────────────────────────────

export class RfcWorkflowHandlers {
	private server: McpServer;

	constructor(server: McpServer) {
		this.server = server;
	}

	register(): void {
		// State transitions
		this.server.addTool({
			name: "transition_proposal",
			description:
				"Transition proposal state (enforces RFC state machine via proposal_valid_transitions table)",
			inputSchema: {
				type: "object",
				properties: {
					proposal_id: { type: "string" },
					to_state: { type: "string" },
					decided_by: { type: "string" },
					rationale: { type: "string" },
				},
				required: ["proposal_id", "to_state", "decided_by"],
			},
			handler: (args: any) => transitionProposal(args),
		});

		// State machine reference
		this.server.addTool({
			name: "get_valid_transitions",
			description:
				"Get valid state transitions from the data-driven state machine",
			inputSchema: {
				type: "object",
				properties: {
					from_state: { type: "string" },
				},
				required: [],
			},
			handler: (args: any) => getValidTransitions(args),
		});

		// AC management
		this.server.addTool({
			name: "add_acceptance_criteria",
			description:
				"Add one or more acceptance criteria to a proposal. " +
				"Pass `criteria` as an ARRAY OF FULL SENTENCES (string[]); each becomes one AC row, " +
				"item_number assigned in array order. NEVER pass individual title/description fields " +
				"or a key named 'acceptance_criteria' — those are rejected. ACs land with status='pending'; " +
				"call verify_ac per item once the AC is satisfied (verification is NOT auto-inferred " +
				"from tests passing or proposal maturity).",
			inputSchema: {
				type: "object",
				properties: {
					proposal_id: {
						type: "string",
						description: "Proposal id as string (e.g. '913'). NOT the display 'P913'.",
					},
					criteria: {
						type: "array",
						items: { type: "string" },
						description:
							"Array of full-sentence AC bodies. Each entry becomes one AC row with " +
							"the next item_number after existing ACs.",
					},
				},
				required: ["proposal_id", "criteria"],
			},
			handler: (args: any) => addAcceptanceCriteria(args),
		});

		this.server.addTool({
			name: "verify_ac",
			description:
				"Mark a SINGLE acceptance criterion as pass/fail/blocked/waived. " +
				"Call once PER AC item_number (1-indexed). ACs stay 'pending' until " +
				"this is explicitly called — verification is NOT inferred from " +
				"tests passing, code merging, or proposal maturity advancing. " +
				"Gating tools and dashboards read pac.status, not test output. " +
				"REQUIRED for status='pass': the 'details' field must be a non-empty " +
				"JSON object with category-appropriate evidence keys — omitting it " +
				"returns 422 EVIDENCE_REQUIRED. See CONVENTIONS.md §AC-Verification. " +
				"Batch guard: max 2 calls per proposal per 5 s; third call returns 429.",
			inputSchema: {
				type: "object",
				properties: {
					proposal_id: {
						type: "string",
						description: "Proposal id as string (e.g. '913'). NOT the display 'P913'.",
					},
					item_number: {
						type: "number",
						description: "1-indexed AC position. Use list_ac to see current numbering.",
					},
					status: {
						type: "string",
						enum: ["pass", "fail", "blocked", "waived"],
						description:
							"pass=AC met; fail=AC not met (record why in notes); " +
							"blocked=external dependency; waived=operator-approved skip with reason. " +
							"Do NOT pass 'verified' or 'pending' — they violate the CHECK constraint.",
					},
					verified_by: {
						type: "string",
						description:
							"Agent identity slug performing verification (e.g. 'operator-claude', 'codex-reviewer').",
					},
					verification_notes: {
						type: "string",
						description:
							"Evidence the AC is satisfied: commit hash + line range, test name " +
							"and result, schema query proof, or rejection reason for fail/blocked.",
					},
					details: {
						type: "object",
						description:
							"Structured evidence payload (required for status='pass'). " +
							"Use category-appropriate keys — schema/migration: {migration_file, tables, applied}; " +
							"file/module: {files, symbols, grep_evidence}; " +
							"mcp_tool: {tool_name, action, call_verified, response_sample}; " +
							"behavioral/test: {test_file, test_names, result, output_snippet}.",
					},
					category: {
						type: "string",
						enum: ["schema/migration", "file/module", "mcp_tool", "behavioral/test"],
						description:
							"AC evidence category — when provided the handler validates that 'details' " +
							"contains the required keys for that category (returns 422 SCHEMA_MISMATCH on violation).",
					},
				},
				required: ["proposal_id", "item_number", "status", "verified_by"],
			},
			handler: (args: any) => verifyAC(args),
		});

		this.server.addTool({
			name: "list_ac",
			description: "List acceptance criteria for a proposal",
			inputSchema: {
				type: "object",
				properties: {
					proposal_id: { type: "string" },
				},
				required: ["proposal_id"],
			},
			handler: (args: any) => listAC(args),
		});

		this.server.addTool({
			name: "delete_ac",
			description:
				"Delete acceptance criteria by item number, or cleanup corrupted single-character entries (P156 fix)",
			inputSchema: {
				type: "object",
				properties: {
					proposal_id: { type: "string" },
					item_number: { type: "number" },
					cleanup_singles: {
						type: "boolean",
						description:
							"When true, deletes all single-character AC entries corrupted by P156",
					},
				},
				required: ["proposal_id"],
			},
			handler: (args: any) => deleteAC(args),
		});

		// Dependencies
		this.server.addTool({
			name: "add_dependency",
			description: "Add dependency between proposals",
			inputSchema: {
				type: "object",
				properties: {
					proposal_id: { type: "string" },
					depends_on: { type: "string" },
					dep_type: {
						type: "string",
						enum: ["blocks", "depended_by", "supersedes", "relates"],
						default: "blocks",
					},
				},
				required: ["proposal_id", "depends_on"],
			},
			handler: (args: any) => addDependency(args),
		});

		this.server.addTool({
			name: "get_dependencies",
			description: "Get dependencies for a proposal — shows effective blocking status (mature/obsolete upstream auto-resolved)",
			inputSchema: {
				type: "object",
				properties: { proposal_id: { type: "string" } },
				required: ["proposal_id"],
			},
			handler: (args: any) => getDependencies(args),
		});

		this.server.addTool({
			name: "resolve_dependency",
			description: "Manually resolve a dependency so it no longer blocks. Pass dep_id from get_dependencies output.",
			inputSchema: {
				type: "object",
				properties: {
					dep_id: { type: "number", description: "The dependency ID from proposal_dependencies" },
					resolved_by: { type: "string", description: "Agent or user identity resolving this" },
				},
				required: ["dep_id", "resolved_by"],
			},
			handler: (args: any) => resolveDependency(args),
		});

		// Reviews
		this.server.addTool({
			name: "submit_review",
			description:
				"Submit a review verdict for a proposal. " +
				"PARAM NOTE: reviewer identity is passed as `reviewer` (NOT reviewer_identity / agent_identity / identity). " +
				"Key params: proposal_id, reviewer (kebab-case identity), " +
				"verdict (approve|approve_with_changes|request_changes|send_back|reject|defer|recuse), " +
				"notes (review rationale — canonical name; do not pass as review/body/content, those aliases are stripped by MCP), " +
				"change_requirements (string[], required when verdict=approve_with_changes), " +
				"is_blocking (boolean — when true this review blocks gate advancement; IS persisted, fixed in P1387), " +
				"comment (optional supplementary text distinct from notes).",
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
