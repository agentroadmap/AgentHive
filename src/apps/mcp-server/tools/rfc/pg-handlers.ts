import { query } from "../../../../infra/postgres/pool.ts";
import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";
import { validateAcEvidence } from "../../schema/ac-evidence.ts";

/**
 * RFC / Proposal Handlers — P297 / P611
 *
 * Handles tool requests for the roadmap_proposal schema.
 */

interface ProposalIdRow {
	id: number;
}

/**
 * Resolve a display ID (P###) or numeric ID string into a DB primary key.
 */
async function resolveProposalId(input: string | number): Promise<number | null> {
	if (typeof input === "number") return input;
	const idStr = String(input).trim();

	// Handle P### format
	if (/^[Pp]\d+$/.test(idStr)) {
		const displayId = idStr.toUpperCase();
		const { rows } = await query<ProposalIdRow>(
			`SELECT id FROM roadmap_proposal.proposal WHERE display_id = $1`,
			[displayId],
		);
		return rows[0]?.id ?? null;
	}

	// Handle raw numeric ID
	if (/^\d+$/.test(idStr)) {
		return parseInt(idStr, 10);
	}

	return null;
}

const errorResult = (message: string, err?: any): CallToolResult => ({
	content: [
		{
			type: "text",
			text: `❌ ${message}${err ? `: ${err.message || String(err)}` : ""}`,
		},
	],
	isError: true,
});

// ─── Acceptance Criteria ───────────────────────────────────────────────────

export async function addAcceptanceCriteria(args: {
	proposal_id: string;
	criteria: string[];
}): Promise<CallToolResult> {
	const proposalId = await resolveProposalId(args.proposal_id);
	if (proposalId === null) {
		return errorResult(`Proposal ${args.proposal_id} not found.`);
	}

	const criteriaList = Array.isArray(args.criteria)
		? args.criteria
		: [args.criteria];

	try {
		for (const criterion of criteriaList) {
			await query(
				`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
				 (proposal_id, statement, status)
				 VALUES ($1, $2, 'pending')`,
				[proposalId, criterion],
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
	status: "pass" | "fail" | "blocked" | "waived";
	verified_by: string;
	details?: any; // evidence
	verification_notes?: any; // alias for details
}): Promise<CallToolResult> {
	const proposalId = await resolveProposalId(args.proposal_id);
	if (proposalId === null) {
		return errorResult(`Proposal ${args.proposal_id} not found.`);
	}

	// Support both field names for evidence
	const evidence = args.details || args.verification_notes;

	try {
		// P707 Sequential Verification Guard:
		// Logic moved to the handler level in consolidated.ts or handled via DB timestamp check.
		// For now, let's proceed with the update.

		const { rows: acRows } = await query(
			`SELECT id, verified_at
			 FROM roadmap_proposal.proposal_acceptance_criteria
			 WHERE proposal_id = $1
			 ORDER BY id ASC
			 LIMIT 1 OFFSET $2`,
			[proposalId, args.item_number - 1],
		);

		if (acRows.length === 0) {
			return errorResult(
				`Acceptance criterion #${args.item_number} not found for proposal ${args.proposal_id}`,
			);
		}

		const ac = acRows[0];

		// P707 batch-advance guard: max 2 ACs verified per proposal within 5 seconds
		const { rows: recentRows } = await query<{ count: string }>(
			`SELECT COUNT(*) as count
			 FROM roadmap_proposal.proposal_acceptance_criteria
			 WHERE proposal_id = $1 AND verified_at > NOW() - INTERVAL '5 seconds'`,
			[proposalId],
		);
		const recentCount = parseInt(recentRows[0].count, 10);
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
			 SET status = $1, verified_by = $2, verified_at = NOW(), verification_notes = $3
			 WHERE id = $4`,
			[args.status, args.verified_by, JSON.stringify(evidence), ac.id],
		);

		return {
			content: [
				{
					type: "text",
					text: `✅ AC #${args.item_number}: status → ${args.status} (verified by ${args.verified_by})`,
				},
			],
		};
	} catch (err) {
		return errorResult("Failed to verify AC", err);
	}
}

// ─── Reviews ────────────────────────────────────────────────────────────────

export async function submitReview(args: {
	proposal_id: string;
	reviewer: string;
	verdict: string;
	findings?: Record<string, any>;
	notes?: string;
	// is_blocking=true marks the review as a hard blocker (P1387 / P1409).
	is_blocking?: boolean;
	// P1409: accept `blocking` as an alias.
	blocking?: boolean;
	comment?: string;
	// Common aliases agents try.
	review?: string;
	body?: string;
	content?: string;
	change_requirements?: string[];
}): Promise<CallToolResult> {
	if (!args.notes) {
		args.notes = args.review ?? args.body ?? args.content;
	}

	const proposalId = await resolveProposalId(args.proposal_id);
	if (proposalId === null) {
		return errorResult(`Proposal ${args.proposal_id} not found.`);
	}

	try {
		const isBlocking = args.is_blocking === true || args.blocking === true;

		const { rows: existing } = await query(
			"SELECT id FROM roadmap_proposal.proposal_reviews WHERE proposal_id = $1 AND reviewer_identity = $2",
			[proposalId, args.reviewer],
		);

		let reviewId: number;
		if (existing.length) {
			reviewId = existing[0].id;
			await query(
				`UPDATE roadmap_proposal.proposal_reviews
				 SET verdict = $1, notes = $2, findings = $3, is_blocking = $4, comment = $5, reviewed_at = NOW()
				 WHERE id = $6`,
				[
					args.verdict,
					args.notes || null,
					args.findings ? JSON.stringify(args.findings) : null,
					isBlocking,
					args.comment || null,
					reviewId,
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
				`INSERT INTO roadmap_proposal.proposal_reviews
				 (proposal_id, reviewer_identity, verdict, notes, findings, is_blocking, comment)
				 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
				[
					proposalId,
					args.reviewer,
					args.verdict,
					args.notes || null,
					args.findings ? JSON.stringify(args.findings) : null,
					isBlocking,
					args.comment || null,
				],
			);
			reviewId = inserted[0].id;
		}

		// Handle change requirements if verdict is approve_with_changes
		if (args.verdict === "approve_with_changes" && args.change_requirements?.length) {
			for (const requirement of args.change_requirements) {
				await query(
					`INSERT INTO roadmap_proposal.post_gate_change_requirement (review_id, requirement_text)
					 VALUES ($1, $2)`,
					[reviewId, requirement],
				);
			}
		}

		return {
			content: [
				{
					type: "text",
					text: `✅ Review submitted for ${args.proposal_id}: ${args.verdict}${isBlocking ? " [blocking]" : ""} (${args.reviewer})`,
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
	const propId = await resolveProposalId(args.proposal_id);
	if (propId === null) {
		return errorResult(`Proposal ${args.proposal_id} not found.`);
	}

	try {
		const { rows: reviewRows } = await query(
			`SELECT reviewer_identity, verdict, notes, findings, is_blocking, comment, reviewed_at
			 FROM roadmap_proposal.proposal_reviews
			 WHERE proposal_id = $1
			 ORDER BY reviewed_at DESC`,
			[propId],
		);

		if (!reviewRows.length) {
			return {
				content: [
					{
						type: "text",
						text: `No reviews found for proposal ${args.proposal_id}`,
					},
				],
			};
		}

		const verdictEmoji: Record<string, string> = {
			approve: "✅",
			approve_with_changes: "✅",
			request_changes: "🔄",
			reject: "❌",
			send_back: "⬅️",
			defer: "⏳",
			recuse: "😶",
		};

		const lines = reviewRows.map((r) => {
			const emoji = verdictEmoji[r.verdict] || "?";
			const blocking = r.is_blocking ? " [blocking]" : "";
			const notes = r.notes ? ` — ${r.notes}` : "";
			const comment = r.comment ? ` (comment: ${r.comment})` : "";
			return `${emoji} ${r.reviewer_identity}: ${r.verdict}${blocking}${notes}${comment}`;
		});

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

// ─── Tool Class ─────────────────────────────────────────────────────────────

export class RfcTools {
	constructor(private server: McpServer) {}

	register() {
		// Acceptance Criteria
		this.server.addTool({
			name: "add_acceptance_criteria",
			description: "Add one or more acceptance criteria to a proposal.",
			inputSchema: {
				type: "object",
				properties: {
					proposal_id: { type: "string", description: "P### or numeric ID" },
					criteria: {
						type: "array",
						items: { type: "string" },
						description: "Array of full sentences",
					},
				},
				required: ["proposal_id", "criteria"],
			},
			handler: (args: any) => addAcceptanceCriteria(args),
		});

		this.server.addTool({
			name: "verify_ac",
			description: "Mark an acceptance criterion as passed/failed with evidence.",
			inputSchema: {
				type: "object",
				properties: {
					proposal_id: { type: "string" },
					item_number: { type: "number", description: "1-based index" },
					status: {
						type: "string",
						enum: ["pass", "fail", "blocked", "waived"],
					},
					verified_by: { type: "string", description: "Agent identity" },
					details: {
						type: "object",
						description: "Structured evidence (files, symbols, etc.)",
					},
					verification_notes: { type: "object", description: "Alias for details" },
				},
				required: ["proposal_id", "item_number", "status", "verified_by"],
			},
			handler: (args: any) => verifyAC(args),
		});

		// Reviews
		this.server.addTool({
			name: "submit_review",
			description:
				"Submit a review verdict for a proposal. Pass is_blocking=true for hard blockers.",
			inputSchema: {
				type: "object",
				properties: {
					proposal_id: { type: "string" },
					reviewer: {
						type: "string",
						description: "Reviewer identity slug (lowercase-hyphen).",
					},
					verdict: {
						type: "string",
						enum: [
							"approve",
							"approve_with_changes",
							"request_changes",
							"send_back",
							"reject",
							"defer",
							"recuse",
						],
					},
					notes: { type: "string", description: "Review rationale" },
					is_blocking: {
						type: "boolean",
						description: "Mark this review as a hard blocker. Default false.",
					},
					blocking: { type: "boolean", description: "Alias for is_blocking" },
					comment: { type: "string", description: "Supplementary notes" },
					change_requirements: {
						type: "array",
						items: { type: "string" },
						description: "Required when verdict=approve_with_changes",
					},
				},
				required: ["proposal_id", "reviewer", "verdict"],
			},
			handler: (args: any) => submitReview(args),
		});

		this.server.addTool({
			name: "list_reviews",
			description: "List all reviews for a proposal.",
			inputSchema: {
				type: "object",
				properties: {
					proposal_id: { type: "string" },
				},
				required: ["proposal_id"],
			},
			handler: (args: any) => listReviews(args),
		});
	}
}
