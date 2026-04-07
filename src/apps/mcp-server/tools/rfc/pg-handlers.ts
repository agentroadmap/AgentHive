/**
 * Postgres-backed RFC Workflow MCP Tools for AgentHive.
 *
 * Implements the RFC state machine: Proposal → Draft → Review → Develop → Merge → Complete
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

import { query } from "../../../../postgres/pool.ts";
import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";

type ResolvedProposal = {
	id: number;
	display_id: string;
	type: string;
	title: string;
	status: string;
	maturity: Record<string, string> | null;
	summary: string | null;
	motivation: string | null;
	design: string | null;
	drawbacks: string | null;
	alternatives: string | null;
	dependency: string | null;
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
	if (to === "REJECTED") return "rejected";
	if (to === "DISCARDED" || to === "DEFERRED") return "discard";
	if (to === "COMPLETE") return "decision";
	// Going backward in state sequence
	const order = ["PROPOSAL", "DRAFT", "REVIEW", "DEVELOP", "MERGE", "COMPLETE"];
	const fromIdx = order.indexOf(from.toUpperCase());
	const toIdx = order.indexOf(to.toUpperCase());
	if (toIdx < fromIdx) return "iteration";
	if (toIdx === fromIdx) return "depend";
	return "mature";
}

function parseNumericIdentifier(identifier: string): number | null {
	const trimmed = identifier.trim();
	if (!/^\d+$/.test(trimmed)) {
		return null;
	}
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

async function resolveProposalRecord(
	identifier: string,
): Promise<ResolvedProposal | null> {
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
       p.dependency,
       w.id AS workflow_id,
       w.current_stage,
       wt.name AS workflow_name
     FROM proposal p
     LEFT JOIN workflows w ON w.proposal_id = p.id
     LEFT JOIN workflow_templates wt ON wt.id = w.template_id
     WHERE p.display_id = $1 OR p.id = $2
     LIMIT 1`,
		[identifier, numericId],
	);
	return rows[0] ?? null;
}

async function resolveProposalId(identifier: string): Promise<number | null> {
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
       FROM proposal_valid_transitions pvt
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
     FROM proposal_type_config
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
		dependency: proposal.dependency,
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
     FROM proposal_acceptance_criteria
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
	proposal: ResolvedProposal,
	fromState: string,
	toState: string,
): string {
	return (
		proposal.maturity?.[toState] ??
		proposal.maturity?.[fromState] ??
		Object.values(proposal.maturity ?? {})[0] ??
		(toState.toLowerCase() === "complete" ? "Mature" : "Active")
	);
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

		const toState = transition.to_state;
		const reason = deriveTransitionReason(transition, fromState, toState);
		const maturityLabel = deriveMaturityLabel(proposal, fromState, toState);

		await query(
			`WITH _actor AS (
         SELECT set_config('app.agent_identity', $1, true) AS agent_identity
       )
       UPDATE proposal
       SET status = $2,
           maturity = jsonb_set(COALESCE(maturity, '{}'::jsonb), ARRAY[$2], to_jsonb($3::text), true),
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
			`UPDATE proposal_state_transitions
       SET transition_reason = $1,
           transitioned_by = $2,
           notes = $3
       WHERE id = (
         SELECT id
         FROM proposal_state_transitions
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
				`INSERT INTO proposal_state_transitions
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
	criteria: string[];
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

		const { rows: maxRow } = await query(
			"SELECT COALESCE(MAX(item_number), 0) as max_idx FROM proposal_acceptance_criteria WHERE proposal_id = $1",
			[proposalId],
		);
		let idx = maxRow[0].max_idx + 1;

		for (const criterion of args.criteria) {
			await query(
				`INSERT INTO proposal_acceptance_criteria (proposal_id, criterion_text, item_number)
         VALUES ($1, $2, $3)`,
				[proposalId, criterion, idx++],
			);
		}

		return {
			content: [
				{
					type: "text",
					text: `✅ Added ${args.criteria.length} AC items to ${args.proposal_id}`,
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

		await query(
			`UPDATE proposal_acceptance_criteria SET status = $1, verified_by = $2,
               verification_notes = $3, verified_at = NOW()
       WHERE proposal_id = $4 AND item_number = $5`,
			[
				args.status,
				args.verified_by,
				args.verification_notes || null,
				proposalId,
				args.item_number,
			],
		);
		return {
			content: [
				{
					type: "text",
					text: `✅ AC #${args.item_number}: ${args.status} (verified by ${args.verified_by})`,
				},
			],
		};
	} catch (err) {
		return errorResult("Failed to verify AC", err);
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
       FROM proposal_acceptance_criteria WHERE proposal_id = $1
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
			`INSERT INTO proposal_dependencies (from_proposal_id, to_proposal_id, dependency_type)
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

		const { rows } = await query(
			`SELECT p.display_id, d.dependency_type as dep_type, d.id as dep_id
       FROM proposal_dependencies d
       JOIN proposal p ON p.id = d.to_proposal_id
       WHERE d.from_proposal_id = $1
       ORDER BY d.dependency_type, p.display_id`,
			[proposalId],
		);

		if (!rows.length) {
			return {
				content: [
					{ type: "text", text: `No dependencies for ${args.proposal_id}` },
				],
			};
		}

		const lines = rows.map((r) => `→ ${r.display_id} [${r.dep_type}]`);
		return {
			content: [
				{
					type: "text",
					text: `### Dependencies for ${args.proposal_id}\n${lines.join("\n")}`,
				},
			],
		};
	} catch (err) {
		return errorResult("Failed to get dependencies", err);
	}
}

// ─── Reviews ────────────────────────────────────────────────────────────────

export async function submitReview(args: {
	proposal_id: string;
	reviewer: string;
	verdict: string;
	findings?: Record<string, any>;
	notes?: string;
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

		// Check for existing review (prevent double-voting)
		const { rows: existing } = await query(
			"SELECT verdict FROM proposal_reviews WHERE proposal_id = $1 AND reviewer_identity = $2",
			[proposalId, args.reviewer],
		);
		if (existing.length) {
			await query(
				`UPDATE proposal_reviews SET verdict = $1, notes = $2, findings = $3, reviewed_at = NOW()
         WHERE proposal_id = $4 AND reviewer_identity = $5`,
				[
					args.verdict,
					args.notes || null,
					args.findings ? JSON.stringify(args.findings) : null,
					proposalId,
					args.reviewer,
				],
			);
		} else {
			await query(
				`INSERT INTO proposal_reviews (proposal_id, reviewer_identity, verdict, notes, findings)
         VALUES ($1, $2, $3, $4, $5)`,
				[
					proposalId,
					args.reviewer,
					args.verdict,
					args.notes || null,
					args.findings ? JSON.stringify(args.findings) : null,
				],
			);
		}

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
			`SELECT reviewer_identity, verdict, notes, findings, reviewed_at
       FROM proposal_reviews WHERE proposal_id = $1
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
				`${verdictEmoji[r.verdict] || "?"} ${r.reviewer_identity}: ${r.verdict}${r.notes ? ` — ${r.notes}` : ""}`,
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

// ─── Discussions ────────────────────────────────────────────────────────────

export async function addDiscussion(args: {
	proposal_id: string;
	author: string;
	content: string;
	parent_id?: number;
	context_prefix?: string;
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
			`INSERT INTO proposal_discussions (proposal_id, author_identity, body, parent_id, context_prefix)
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
               FROM proposal_valid_transitions`;
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
			description: "Add acceptance criteria to a proposal",
			inputSchema: {
				type: "object",
				properties: {
					proposal_id: { type: "string" },
					criteria: { type: "array", items: { type: "string" } },
				},
				required: ["proposal_id", "criteria"],
			},
			handler: (args: any) => addAcceptanceCriteria(args),
		});

		this.server.addTool({
			name: "verify_ac",
			description: "Mark an acceptance criterion as pass/fail/blocked/waived",
			inputSchema: {
				type: "object",
				properties: {
					proposal_id: { type: "string" },
					item_number: { type: "number" },
					status: {
						type: "string",
						enum: ["pass", "fail", "blocked", "waived"],
					},
					verified_by: { type: "string" },
					verification_notes: { type: "string" },
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
			description: "Get dependencies for a proposal",
			inputSchema: {
				type: "object",
				properties: { proposal_id: { type: "string" } },
				required: ["proposal_id"],
			},
			handler: (args: any) => getDependencies(args),
		});

		// Reviews
		this.server.addTool({
			name: "submit_review",
			description: "Submit a review for a proposal",
			inputSchema: {
				type: "object",
				properties: {
					proposal_id: { type: "string" },
					reviewer: { type: "string" },
					verdict: {
						type: "string",
						enum: ["approve", "request_changes", "reject"],
					},
					notes: { type: "string" },
				},
				required: ["proposal_id", "reviewer", "verdict"],
			},
			handler: (args: any) => submitReview(args),
		});

		this.server.addTool({
			name: "list_reviews",
			description: "List reviews for a proposal",
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
			description: "Add a discussion comment to a proposal",
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

		// eslint-disable-next-line no-console
		console.log(
			"[MCP] Registered 11 RFC workflow tools (state machine, AC, deps, reviews, discussions)",
		);
	}
}
