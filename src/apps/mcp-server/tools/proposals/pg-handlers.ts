/**
 * Postgres-backed Proposal MCP Tools
 *
 * Provides the AgentHive-specific `prop_*` tool surface using Postgres.
 * All errors are caught and returned as MCP text responses rather than thrown,
 * preventing tool call crashes.
 */

import type { QueryResultRow } from "pg";
import { query } from "../../../../postgres/pool.ts";
import type { ProposalRow } from "../../../../infra/postgres/proposal-storage-v2.ts";
import * as pg from "../../../../infra/postgres/proposal-storage-v2.ts";
import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";
import { RfcStates, Maturity } from "../../../../core/workflow/state-names.ts";
import { validateLease, formatValidationError } from "../../../../core/proposal/proposal-integrity.ts";
import {
	isRegisteredAgency,
	hasActiveLiaisonSession,
} from "../../../../infra/agency/liaison-service.ts";
import {
	detectConflicts,
	type ConflictEntry,
} from "../../../../core/proposal/directive-conflict-detector.ts";
import { calculateDispatchPriority } from "./directive-priority.ts";

type ProjectionFormat = "yaml_md" | "json";

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

function formatScalar(value: unknown): string {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	return String(value);
}

function yamlValue(value: unknown): string {
	if (value === null || value === undefined || value === "") return "null";
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	const text = formatScalar(value).replace(/"/g, '\\"');
	return `"${text}"`;
}

function normalizeJsonArray(value: unknown): unknown[] {
	if (!value) return [];
	if (Array.isArray(value)) return value;
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}
	return [];
}

function markdownList(items: unknown[], textKey: string): string {
	if (items.length === 0) return "None recorded.";
	return items
		.map((item, index) => {
			if (item && typeof item === "object" && textKey in item) {
				const record = item as Record<string, unknown>;
				const status = record.status ? ` [${formatScalar(record.status)}]` : "";
				return `${index + 1}. ${formatScalar(record[textKey])}${status}`;
			}
			return `${index + 1}. ${formatScalar(item)}`;
		})
		.join("\n");
}

export class PgProposalHandlers {
	constructor(
		private readonly core: McpServer,
		private readonly projectRoot: string,
	) {}

	async listProposals(args: {
		status?: string;
		type?: string;
		proposal_type?: string;
		parent_id?: string | number | null;
		limit?: number;
		include_terminal?: boolean;
		include_metadata?: boolean;
		search?: string;
		maturity?: string;
		maturity_min?: string;
	}): Promise<CallToolResult> {
		try {
			const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);
			const includeTerminal = args.include_terminal === true;
			const includeMetadata = args.include_metadata === true;

			let sql = `SELECT id, display_id, parent_id, title, status, type, maturity, created_at${includeMetadata ? ", summary, design, motivation" : ""}
			       FROM roadmap_proposal.proposal`;
			const params: (string | number)[] = [];
			const conditions: string[] = [];

			// Terminal statuses: Complete, Deployed, Recycled
			const terminalStatuses = ["Complete", "Deployed", "Recycled"];

			if (args.status) {
				conditions.push(`status = $${params.length + 1}`);
				params.push(args.status);
			} else if (!includeTerminal) {
				conditions.push(`status NOT IN (${terminalStatuses.map((_, i) => `$${params.length + i + 1}`).join(", ")})`);
				terminalStatuses.forEach((s) => params.push(s));
			}

			const proposalType = args.type ?? args.proposal_type;
			if (proposalType !== undefined) {
				conditions.push(`type = $${params.length + 1}`);
				params.push(proposalType);
			}

			if (args.parent_id !== undefined && args.parent_id !== null) {
				const raw = args.parent_id;
				const isDisplayId = typeof raw === 'string' && /^P\d+$/i.test(raw);
				if (isDisplayId) {
					conditions.push(`parent_id = (SELECT id FROM roadmap_proposal.proposal WHERE display_id = $${params.length + 1} LIMIT 1)`);
					params.push(String(raw));
				} else {
					const num = Number(raw);
					if (!Number.isNaN(num)) {
						conditions.push(`parent_id = $${params.length + 1}`);
						params.push(num);
					}
				}
			}

			if (args.search) {
				conditions.push(`title ILIKE $${params.length + 1}`);
				params.push(`%${args.search}%`);
			}

			if (args.maturity) {
				conditions.push(`maturity = $${params.length + 1}`);
				params.push(args.maturity);
			} else if (args.maturity_min) {
				const maturityOrder: Record<string, number> = { new: 0, active: 1, mature: 2, obsolete: 3 };
				const minLevel = maturityOrder[args.maturity_min];
				if (minLevel !== undefined) {
					const validLevels = Object.entries(maturityOrder)
						.filter(([, v]) => v >= minLevel)
						.map(([k]) => k);
					const placeholders = validLevels.map((_, i) => `$${params.length + i + 1}`).join(", ");
					conditions.push(`maturity IN (${placeholders})`);
					validLevels.forEach((v) => params.push(v));
				}
			}


			if (conditions.length) {
				sql += ` WHERE ${conditions.join(" AND ")}`;
			}
			sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
			params.push(limit);

			const [{ rows }, countResult] = await Promise.all([
				query(sql, params),
				query<{ total: string }>(
					`SELECT COUNT(*)::text AS total FROM roadmap_proposal.proposal${
						conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""
					}`,
					params.slice(0, -1),
				),
			]);

			const totalMatching = Number(countResult.rows[0]?.total ?? rows.length);
			const truncated = totalMatching > rows.length;

			if (!rows.length) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									total: 0,
									returned: 0,
									truncated: false,
									limit,
									filter: {
										status: args.status,
										type: args.type ?? args.proposal_type,
										parent_id: args.parent_id ?? null,
										maturity: args.maturity,
										maturity_min: args.maturity_min,
										search: args.search,
										includeTerminal,
									},
									note: includeTerminal
										? "No proposals match the filter."
										: "No active proposals. Pass include_terminal=true to see complete/deployed.",
								},
								null,
								2,
							),
						},
					],
				};
			}

			const items = rows.map((p: any) => ({
				id: p.id,
				display_id: p.display_id,
				parent_id: p.parent_id ?? null,
				title: p.title,
				status: p.status,
				type: p.type,
				maturity: p.maturity,
				created_at: p.created_at,
				...(includeMetadata && {
					summary: p.summary,
					design: p.design,
					motivation: p.motivation,
				}),
			}));

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								total: totalMatching,
								returned: rows.length,
								truncated,
								limit,
								filter: {
									status: args.status,
									type: args.type ?? args.proposal_type,
									parent_id: args.parent_id ?? null,
									includeTerminal,
								},
								items,
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to list proposals", err);
		}
	}

	async getProposal(args: {
		id?: string | number;
		proposal_id?: string | number;
		proposalId?: string | number;
		display_id?: string;
	}): Promise<CallToolResult> {
		try {
			// Many agents call with `proposal_id` (matching the consolidated
			// router schema) or `display_id`. Coerce to a single canonical
			// identifier so the call doesn't strand with "Proposal undefined
			// not found" — that error mode looks like a missing proposal but
			// is actually a missing arg.
			const identifier =
				args.id ?? args.proposal_id ?? args.proposalId ?? args.display_id;
			if (identifier === undefined || identifier === null || identifier === "") {
				return {
					content: [{ type: "text", text: "prop_get requires `id` (or `proposal_id`/`display_id`)." }],
				};
			}
			// display_id is text (e.g. 'P001'), db id is bigint.
			// Always pass as string — the storage layer uses separate queries
			// to avoid Postgres cross-type comparison errors.
			const proposal = await pg.getProposal(String(identifier));
			if (!proposal) {
				return {
					content: [{ type: "text", text: `Proposal ${identifier} not found.` }],
				};
			}
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(proposal, null, 2),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to get proposal", err);
		}
	}

	async createProposal(args: {
		title: string;
		type?: string;
		proposal_type?: string;
		display_id?: string;
		parent_id?: string;
		summary?: string;
		motivation?: string;
		design?: string;
		drawbacks?: string;
		alternatives?: string;
		dependency?: string;
		priority?: string;
		body_markdown?: string;
		status?: string;
		tags?: string;
		author?: string;
	}): Promise<CallToolResult> {
		try {
			const proposalType = args.type ?? args.proposal_type;
			if (!proposalType) {
				return {
					content: [{ type: "text", text: "Proposal type is required." }],
				};
			}

			const author = args.author ?? "system";
			const isDirective = proposalType === "directive";
			const summary = args.summary ?? args.body_markdown ?? null;

			// AC-3: Directives always start in Draft state
			// AC-4: Directives carry 1.5× dispatch priority
			const resolvedStatus = isDirective ? "Draft" : (args.status || null);
			const basePriority = args.priority ? parseFloat(args.priority) : null;
			const resolvedPriority = isDirective
				? String(calculateDispatchPriority(basePriority))
				: (args.priority || null);

			// AC-5 + AC-7: Conflict detection and escalation for directives
			let conflictNote = "";
			let detectedConflicts: ConflictEntry[] = [];
			if (isDirective) {
				const report = await detectConflicts("-1", args.title, summary);
				detectedConflicts = report.conflicts;
				if (detectedConflicts.length > 0) {
					conflictNote = `\n⚠️ Conflicts detected (${detectedConflicts.length}): ${detectedConflicts.map((c) => c.display_id ?? c.proposal_id).join(", ")}`;
				}
			}

			const created = await pg.createProposal(
				{
					display_id: args.display_id || null,
					type: proposalType,
					title: args.title,
					status: resolvedStatus,
					parent_id: args.parent_id ? parseInt(args.parent_id, 10) : null,
					summary,
					motivation: args.motivation || null,
					design: args.design || null,
					drawbacks: args.drawbacks || null,
					alternatives: args.alternatives || null,
					dependency_note: args.dependency || null,
					priority: resolvedPriority,
					tags: args.tags ? JSON.parse(args.tags) : null,
				},
				author,
			);

			const displayRef = created.display_id ?? String(created.id);

			if (isDirective) {
				// AC-8: Write audit trail entry for directive creation
				await query(
					`INSERT INTO roadmap.audit_log (entity_type, entity_id, action, changed_by, before_json, after_json)
					 VALUES ($1, $2, 'insert', $3, NULL, $4::jsonb)`,
					[
						"proposal",
						displayRef,
						author,
						JSON.stringify({
							type: "directive",
							title: args.title,
							issuer: author,
							rationale: summary,
							priority: resolvedPriority,
						}),
					],
				);

				// AC-7: Escalate to D2 gate if conflicts were detected
				if (detectedConflicts.length > 0) {
					await query(
						`INSERT INTO roadmap.escalation_log (obstacle_type, proposal_id, agent_identity, escalated_to, severity)
						 VALUES ('DEPENDENCY_UNRESOLVED', $1, $2, 'skeptic_d2', 'high')`,
						[displayRef, author],
					);
				}
			}
			return {
				content: [
					{
						type: "text",
						text: `Created proposal: [${displayRef}] ${created.title}${conflictNote}`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to create proposal", err);
		}
	}

	async updateProposal(args: {
		id: string;
		title?: string;
		status?: string;
		summary?: string;
		motivation?: string;
		design?: string;
		drawbacks?: string;
		alternatives?: string;
		dependency?: string;
		priority?: string;
		body_markdown?: string;
		tags?: string;
		author?: string;
		type?: string;
	}): Promise<CallToolResult> {
		try {
			// P461: Reject type changes — route to schema reconciliation (P436)
			if ((args as any).type !== undefined) {
				return {
					content: [
						{
							type: "text",
							text: "⚠️ prop_update: type changes are not permitted via this MCP surface. Use roadmap.fn_reconcile_proposal_type or migration P436. Affected key: 'type'.",
						},
					],
				};
			}

			// P150: Reject status changes in prop_update — all status transitions
			// require gate decision records. Route to prop_transition (which enforces
			// gate decisions) or mcp_proposal action=gate_decision (atomic decision + transition).
			if (args.status) {
				return {
					content: [
						{
							type: "text",
							text:
								"⚠️ prop_update: status changes are not permitted via this tool. " +
								"Proposal status transitions require gate decision records for audit compliance (P150).\n\n" +
								"Use one of:\n" +
								'  1. prop_transition with a prior gate_decision_log record (decision=advance within 10 min)\n' +
								'  2. mcp_proposal action=gate_decision { gate: "D1"|"D2"|"D3"|"D4", decision: "advance", rationale: "..." } ' +
								"     — this atomically records the decision AND transitions status in one call",
						},
					],
				};
			}

			const id = await pg.resolveProposalId(args.id);
			if (id === null) {
				return {
					content: [{ type: "text", text: `Proposal ${args.id} not found.` }],
				};
			}

			const updates: Record<string, any> = {};
			if (args.title) updates.title = args.title;
			if (args.summary) updates.summary = args.summary;
			if (args.motivation) updates.motivation = args.motivation;
			if (args.design) updates.design = args.design;
			if (args.drawbacks) updates.drawbacks = args.drawbacks;
			if (args.alternatives) updates.alternatives = args.alternatives;
			if (args.dependency) updates.dependency_note = args.dependency;
			if (args.priority) updates.priority = args.priority;
			if (args.body_markdown) updates.summary = args.body_markdown;
			if (args.tags) updates.tags = JSON.parse(args.tags);

			let updated =
				Object.keys(updates).length > 0
					? await pg.updateProposal(id, updates, args.author ?? "unknown")
					: await pg.getProposal(id);

			if (!updated) {
				return {
					content: [
						{
							type: "text",
							text: `No changes applied to proposal ${args.id}.`,
						},
					],
				};
			}
			return {
				content: [
					{
						type: "text",
						text: `Updated proposal: [${updated.display_id ?? updated.id}]`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to update proposal", err);
		}
	}

	async transitionProposal(args: {
		id?: string;
		// P1340 AC-4 (D3 follow-up): universal identifier aliases.
		proposal_id?: string;
		display_id?: string;
		status?: string;
		// Aliases accepted to absorb common param-shape confusion across callers.
		// Canonical is `status`; the rest are fallbacks so a misremembered call
		// doesn't strand a gate transition with `undefined.toUpperCase()`.
		to_state?: string;
		to_status?: string;
		to?: string;
		target_state?: string;
		author?: string;
		actor?: string;
		reason?: string;
		notes?: string;
	}): Promise<CallToolResult> {
		// Hoist idArg outside the try so the catch can reference it for the
		// gate-decision-shortcut hint (P1340 AC-7).
		const idArg = args.id ?? args.proposal_id ?? args.display_id;
		if (!idArg) {
			return {
				content: [{ type: "text", text: `prop_transition: missing proposal identifier. Pass id="P123" (canonical) or proposal_id / display_id alias.` }],
			};
		}
		try {
			const id = await pg.resolveProposalId(idArg);
			if (id === null) {
				return {
					content: [{ type: "text", text: `Proposal ${idArg} not found.` }],
				};
			}

			// Resolve target status from canonical `status` or any documented alias.
			const targetStatus =
				args.status ?? args.to_state ?? args.to_status ?? args.to ?? args.target_state;
			if (!targetStatus || typeof targetStatus !== "string") {
				return {
					content: [
						{
							type: "text",
							text: `prop_transition: missing target status. Pass status="DEVELOP" (canonical) or one of the aliases: to_state, to_status, to, target_state.`,
						},
					],
				};
			}

			// AC-2: Require active lease before allowing transition (P224)
			const author = args.author ?? args.actor ?? "system";
			const leaseResult = await validateLease(id, author);
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

			// Gate transitions require decision notes
			const gateTransitions: Record<string, string[]> = {
				[RfcStates.DRAFT]: [RfcStates.REVIEW],
				[RfcStates.REVIEW]: [RfcStates.DEVELOP],
				[RfcStates.DEVELOP]: [RfcStates.MERGE],
				[RfcStates.MERGE]: [RfcStates.COMPLETE],
			};

			// Get current status to check if this is a gate transition
			const current = await pg.getProposal(id);
			if (current) {
				const currentStatus = current.status.toUpperCase();
				const requestedStatus = targetStatus.toUpperCase();
				const allowedTargets = gateTransitions[currentStatus];
				if (allowedTargets?.includes(requestedStatus)) {
					if (!args.notes || args.notes.trim().length === 0) {
						// State ALL gate prerequisites at once instead of revealing them one
						// error at a time (notes → reason → actor), which forces agents into
						// a whack-a-mole retry loop and strands the decision.
						return {
							content: [
								{
									type: "text",
									text:
										`Gate transition ${currentStatus} → ${requestedStatus} is a gating decision and needs:\n` +
										`  • notes: the decision record — what was decided and why (required for D* auditability)\n` +
										`  • reason='decision': auto-applied for gate transitions when notes are present, so you do NOT need to pass it\n` +
										`  • an active lease held by the deciding actor (validated above)\n` +
										`Recommended flow: record the verdict with the 'gate_decision' action ` +
										`(decision=advance|hold|reject|waive|escalate) and notes, THEN call transition with notes.\n` +
										`If you are a single reviewer (not the gate), use 'submit_review' with verdict='approve' instead — ` +
										`advancing the stage is a gate role, not part of a review.`,
								},
							],
						};
					}
					// reason='decision' is the ONLY value the storage gate accepts for a
					// gated transition. Requiring the agent to echo this magic string adds
					// no information and is a frequent first-try failure — apply it
					// automatically once a decision record (notes) is present. Auditability
					// is preserved by the notes record itself.
					if (args.reason !== "decision") {
						args.reason = "decision";
					}
				}
			}

			const updated = await pg.transitionProposal(
				id,
				targetStatus,
				author,
				args.reason,
				args.notes,
			);
			if (!updated) {
				return {
					content: [{ type: "text", text: `Proposal ${idArg} not found.` }],
				};
			}
			return {
				content: [
					{
						type: "text",
						text: `Transitioned proposal ${idArg} → ${targetStatus}`,
					},
				],
			};
		} catch (err) {
			// P1340 AC-7: when the DB gate guard (fn_guard_gate_advance) rejects
			// the transition for missing decision log, suggest the one-call
			// mcp_proposal action=gate_decision shortcut that bundles decision +
			// transition + lease release into a single MCP call.
			// P1340 AC-6: schema-level missing-field errors (NOT NULL / CHECK
			// constraints from the proposal row) get reformatted with the
			// column name so the caller knows exactly what to provide.
			const errMsg = err instanceof Error ? err.message : String(err);
			if (errMsg.includes("requires a gate decision")) {
				const targetStatusForHint = (args.status ?? args.to_state ?? args.to_status ?? args.to ?? args.target_state ?? "").toUpperCase();
				const gateGuess = targetStatusForHint === "REVIEW" ? "D1"
					: targetStatusForHint === "DEVELOP" ? "D2"
					: targetStatusForHint === "MERGE" ? "D3"
					: targetStatusForHint === "COMPLETE" ? "D4"
					: "D?";
				return {
					content: [
						{
							type: "text",
							text: `🚪 ${errMsg}\n\n💡 Shortcut: use mcp_proposal action=gate_decision { proposal_id: "${idArg}", gate: "${gateGuess}", decision: "advance", rationale: "..." } — that single MCP call records the decision AND flips status atomically. You don't need prop_transition for gate advances.`,
						},
					],
				};
			}
			// AC-6: PG NOT NULL / CHECK / FK violations carry the column name
			// in the error. Surface it explicitly.
			const notNullMatch = errMsg.match(/null value in column "([^"]+)" of relation "([^"]+)"/);
			if (notNullMatch) {
				return {
					content: [
						{
							type: "text",
							text: `❌ Missing required field: \`${notNullMatch[1]}\` on table \`${notNullMatch[2]}\`. Set it before transition. (Underlying: ${errMsg})`,
						},
					],
				};
			}
			const checkMatch = errMsg.match(/violates check constraint "([^"]+)"/);
			if (checkMatch) {
				return {
					content: [
						{
							type: "text",
							text: `❌ Value rejected by constraint \`${checkMatch[1]}\`. Inspect the constraint definition for allowed values. (Underlying: ${errMsg})`,
						},
					],
				};
			}
			return errorResult("Failed to transition proposal", err);
		}
	}

	async setMaturity(args: {
		id?: string;
		// P1340 AC-4 (D3 follow-up): universal alias support — proposal_id and
		// display_id work alongside the canonical id.
		proposal_id?: string;
		display_id?: string;
		maturity: string;
		agent?: string;
		reason?: string;
	}): Promise<CallToolResult> {
		try {
			const idArg = args.id ?? args.proposal_id ?? args.display_id;
			if (!idArg) {
				return {
					content: [{ type: "text", text: `prop_set_maturity: missing proposal identifier. Pass id="P123" (canonical) or proposal_id / display_id alias.` }],
				};
			}
			const id = await pg.resolveProposalId(idArg);
			if (id === null) {
				return {
					content: [{ type: "text", text: `Proposal ${idArg} not found.` }],
				};
			}

			const validMaturityValues = [Maturity.NEW, Maturity.ACTIVE, Maturity.MATURE, Maturity.OBSOLETE];
			if (!validMaturityValues.includes(args.maturity as typeof validMaturityValues[number])) {
				return {
					content: [
						{
							type: "text",
							text: `Invalid maturity '${args.maturity}'. Must be one of: ${validMaturityValues.join(", ")}`,
						},
					],
				};
			}

			const updated = await pg.setMaturity(
				id,
				args.maturity as "new" | "active" | "mature" | "obsolete",
				args.agent ?? "system",
				args.reason,
			);
			if (!updated) {
				return {
					content: [{ type: "text", text: `Proposal ${idArg} not found.` }],
				};
			}

			const inferredGate =
				updated.status === RfcStates.DRAFT
					? "D1"
					: updated.status === RfcStates.REVIEW
						? "D2"
						: updated.status === RfcStates.DEVELOP
							? "D3"
							: updated.status === RfcStates.MERGE
								? "D4"
								: null;
			const gateNote =
				args.maturity === Maturity.MATURE && inferredGate
					? ` — entered ${inferredGate} gate-ready queue`
					: args.maturity === Maturity.MATURE && updated.status === RfcStates.COMPLETE
						? " — terminal state; no gate advance queued"
						: "";
			return {
				content: [
					{
						type: "text",
						text: `[${updated.display_id}] maturity set to '${args.maturity}'${gateNote}`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to set maturity", err);
		}
	}

	async claimProposal(args: {
		id?: string;
		// `proposal_id` accepted as alias — the consolidated dispatcher's
		// description docs `proposal_id` for claim/release while the underlying
		// schema requires `id`. Accept both so a misremembered call doesn't
		// 404 with "Proposal undefined not found".
		proposal_id?: string;
		agent?: string;
		// `agent_identity` accepted as alias for `agent` (same reason).
		agent_identity?: string;
		display_id?: string;
		durationMinutes?: number;
		force?: boolean;
	}): Promise<CallToolResult> {
		try {
			// P1340 AC-4: accept id|proposal_id|display_id as aliases for the
			// proposal identifier. resolveProposalId handles both numeric ids and
			// 'P123'-style display_id strings; the alias chain just opens the
			// param-name door.
			const idArg = args.id ?? args.proposal_id ?? args.display_id;
			const agentArg = args.agent ?? args.agent_identity;
			if (!idArg) {
				return {
					content: [{ type: "text", text: `prop_claim: missing proposal identifier. Pass id="P123" (canonical) or proposal_id / display_id alias.` }],
				};
			}
			if (!agentArg) {
				return {
					content: [{ type: "text", text: `prop_claim: missing agent identity. Pass agent="claude" (canonical) or agent_identity alias.` }],
				};
			}
			const id = await pg.resolveProposalId(idArg);
			if (id === null) {
				return {
					content: [{ type: "text", text: `Proposal ${idArg} not found.` }],
				};
			}

			await query(
				`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (agent_identity) DO UPDATE SET role = EXCLUDED.role`,
				[agentArg, "llm", "developer"],
			);

			// AC-7: liaison is the sole prop_claim gateway for registered agencies.
			// If the claiming agent identity matches a registered agency, it must have
			// an active liaison session — otherwise the claim is rejected.
			const agencyRegistered = await isRegisteredAgency(agentArg);
			if (agencyRegistered) {
				const hasSession = await hasActiveLiaisonSession(agentArg);
				if (!hasSession) {
					return {
						content: [
							{
								type: "text",
								text: `Agency '${agentArg}' is registered but has no active liaison session. Start the agency runtime (scripts/start-agency.ts — invoked via agenthive-${agentArg.split("/")[0] ?? "claude"}-agency.service or equivalent) before claiming proposals; the runtime opens a liaison session and starts the offer_dispatch hub via P912 selfRegisterAgency.`,
							},
						],
					};
				}
			}

			const activeLeases = (await pg.getActiveLeases(id)).filter(
				(lease) => lease.lease_status === "active" || lease.lease_status === "open",
			);
			if (activeLeases.length > 0 && !args.force) {
				const lease = activeLeases[0];
				return {
					content: [
						{
							type: "text",
							text: `Proposal ${idArg} is already claimed by ${lease.agent_identity} until ${lease.expires_at ?? "no expiry"}. To take over the lease: mcp_proposal action=claim { id: "${idArg}", agent: "${agentArg}", force: true } (or MCP CLI: prop_claim --id ${idArg} --agent ${agentArg} --force).`,
						},
					],
				};
			}

			if (args.force) {
				for (const lease of activeLeases) {
					// P934: legacy 'force-reclaimed' (hyphen) → 'force_reclaimed' canonical.
					await pg.releaseLease(id, lease.agent_identity, "force_reclaimed");
				}
			}

			const durationMinutes = args.durationMinutes ?? 120;
			const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000);
			const claimed = await pg.claimLease(id, agentArg, expiresAt);
			if (!claimed) {
				return {
					content: [
						{
							type: "text",
							text: `Proposal ${idArg} could not be claimed; another active lease exists.`,
						},
					],
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Claimed proposal ${idArg} for ${agentArg} until ${expiresAt.toISOString()}.`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to claim proposal", err);
		}
	}

	async releaseProposal(args: {
		id?: string;
		proposal_id?: string;
		display_id?: string;
		agent?: string;
		agent_identity?: string;
		release_reason?: string;
		// Legacy "reason" field name kept for backward-compat with internal callers
		// that haven't migrated yet. Prefer release_reason.
		reason?: string;
	}): Promise<CallToolResult> {
		try {
			// P1340 AC-4: id|proposal_id|display_id all accepted.
			const idArg = args.id ?? args.proposal_id ?? args.display_id;
			const agentArg = args.agent ?? args.agent_identity;
			if (!idArg) {
				return {
					content: [{ type: "text", text: `prop_release: missing proposal identifier. Pass id="P123" (canonical) or proposal_id / display_id alias.` }],
				};
			}
			if (!agentArg) {
				return {
					content: [{ type: "text", text: `prop_release: missing agent identity. Pass agent="claude" (canonical) or agent_identity alias.` }],
				};
			}
			const id = await pg.resolveProposalId(idArg);
			if (id === null) {
				return {
					content: [{ type: "text", text: `Proposal ${idArg} not found.` }],
				};
			}

			// P934: release_reason is REQUIRED. Validation throws InvalidReleaseReasonError
			// which surfaces as a structured error to the MCP caller; no silent default.
			const reason = args.release_reason ?? args.reason;
			const released = await pg.releaseLease(id, agentArg, reason as string);
			if (!released) {
				return {
					content: [
						{
							type: "text",
							text: `No active lease on ${idArg} for ${agentArg}.`,
						},
					],
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Released proposal ${idArg} lease for ${agentArg}.`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to release proposal", err);
		}
	}

	async renewProposal(args: {
		id: string;
		agent: string;
		durationMinutes?: number;
	}): Promise<CallToolResult> {
		try {
			const id = await pg.resolveProposalId(args.id);
			if (id === null) {
				return {
					content: [{ type: "text", text: `Proposal ${args.id} not found.` }],
				};
			}

			const durationMinutes = args.durationMinutes ?? 120;
			const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000);
			const renewed = await pg.renewLease(id, args.agent, expiresAt);
			if (!renewed) {
				return {
					content: [
						{
							type: "text",
							text: `No active lease on ${args.id} for ${args.agent}.`,
						},
					],
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Renewed proposal ${args.id} lease for ${args.agent} until ${expiresAt.toISOString()}.`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to renew proposal lease", err);
		}
	}

	async listLeases(args: { id?: string }): Promise<CallToolResult> {
		try {
			let proposalId: number | undefined;
			if (args.id) {
				const resolvedId = await pg.resolveProposalId(args.id);
				if (resolvedId === null) {
					return {
						content: [{ type: "text", text: `Proposal ${args.id} not found.` }],
					};
				}
				proposalId = resolvedId;
			}

			const leases = await pg.getActiveLeases(proposalId);
			if (!leases.length) {
				return { content: [{ type: "text", text: "No active leases." }] };
			}

			const lines = leases.map(
				(lease) =>
					`[${lease.display_id}] ${lease.agent_identity} — ${lease.lease_status}, claimed ${lease.claimed_at}, expires ${lease.expires_at ?? "never"}`,
			);
			return { content: [{ type: "text", text: lines.join("\n") }] };
		} catch (err) {
			return errorResult("Failed to list proposal leases", err);
		}
	}

	async deleteProposal(args: { id: string }): Promise<CallToolResult> {
		try {
			const ok = await pg.deleteProposal(args.id);
			if (!ok) {
				return {
					content: [{ type: "text", text: `Proposal ${args.id} not found.` }],
				};
			}
			return {
				content: [{ type: "text", text: `Deleted proposal ${args.id}.` }],
			};
		} catch (err) {
			return errorResult("Failed to delete proposal", err);
		}
	}

	async getVersions(args: { id: string; limit?: number }): Promise<CallToolResult> {
		try {
			const versions = await pg.getProposalVersions(args.id, args.limit ?? 50);
			if (!versions || versions.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No versions found for proposal ${args.id}.`,
						},
					],
				};
			}
			const lines = versions.map(
				(v: any) =>
					`v${v.version_number} — ${v.author_identity || "unknown"} at ${v.created_at}: ${v.change_summary || "(no summary)"}`,
			);
			return { content: [{ type: "text", text: lines.join("\n") }] };
		} catch (err) {
			return errorResult("Failed to get versions", err);
		}
	}

	async searchProposals(args: {
		query: string;
		limit?: number;
	}): Promise<CallToolResult> {
		try {
			const proposals = await pg.searchProposals(args.query, args.limit ?? 10);
			if (!proposals || proposals.length === 0) {
				return {
					content: [
						{ type: "text", text: `No proposals match "${args.query}".` },
					],
				};
			}
			const lines = proposals.map((p) => {
				const did = p.display_id ?? `#${p.id}`;
				const preview = this.buildPreview(p);
				return `[${did}] ${p.title || "(no title)"} — status: ${p.status}, type: ${p.type}, maturity: ${p.maturity ?? "unknown"}\n  ${preview}`;
			});
			return {
				content: [
					{
						type: "text",
						text: `### Search: "${args.query}"\n\n${lines.join("\n\n")}`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to search proposals", err);
		}
	}

	async summary(_args: Record<string, never>): Promise<CallToolResult> {
		try {
			const rows = await pg.proposalSummary();
			const total = rows.reduce((sum, row) => sum + row.count, 0);
			const lines = rows.map((r) => `- **${r.status}**: ${r.count}`);
			return {
				content: [
					{
						type: "text",
						text: `### Proposal Summary\n\n**Total**: ${total}\n\n${lines.join("\n")}`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to get proposal summary", err);
		}
	}

	async getProposalProjection(args: {
		id?: string | number;
		proposal_id?: string | number;
		proposalId?: string | number;
		display_id?: string;
		fields?: string[] | string;
		projection?: string;
		format?: "yaml_md" | "json";
	}): Promise<CallToolResult> {
		try {
			// Same identifier coercion as prop_get — accept proposal_id/display_id
			// aliases so an agent that mixes router-style args with raw-tool calls
			// doesn't bounce with "Proposal undefined not found".
			const identifier =
				args.id ?? args.proposal_id ?? args.proposalId ?? args.display_id;
			if (identifier === undefined || identifier === null || identifier === "") {
				return {
					content: [{ type: "text", text: "mcp_get_proposal_projection requires `id` (or `proposal_id`/`display_id`)." }],
				};
			}
			// 1. Fetch the proposal
			const proposal = await pg.getProposal(String(identifier));
			if (!proposal) {
				return {
					content: [{ type: "text", text: `Proposal ${identifier} not found.` }],
				};
			}

			// 2. Fetch acceptance criteria
			const acResult = await query(
				`SELECT item_number, criterion_text, status, verified_by, verified_at
				 FROM roadmap_proposal.proposal_acceptance_criteria
				 WHERE proposal_id = $1
				 ORDER BY item_number`,
				[proposal.id],
			);

			// 3. Fetch active lease
			const leaseResult = await query(
				`SELECT agent_identity, claimed_at, expires_at, released_at
				 FROM roadmap_proposal.proposal_lease
				 WHERE proposal_id = $1 AND released_at IS NULL
				 ORDER BY claimed_at DESC LIMIT 1`,
				[proposal.id],
			);

			// 4. Fetch latest decision
			const decisionResult = await query(
				`SELECT decision, authority, rationale, decided_at
				 FROM roadmap_proposal.proposal_decision
				 WHERE proposal_id = $1
				 ORDER BY decided_at DESC LIMIT 1`,
				[proposal.id],
			);

			// 5. Fetch dependencies
			const depResult = await query(
				`SELECT d.to_proposal_id, p.display_id, d.dependency_type, d.resolved
				 FROM roadmap_proposal.proposal_dependencies d
				 JOIN roadmap_proposal.proposal p ON p.id = d.to_proposal_id
				 WHERE d.from_proposal_id = $1
				 ORDER BY d.created_at`,
				[proposal.id],
			);

			// 6. Fetch direct children (shallow — no recursive descent)
			const childrenResult = await query(
				`SELECT id, display_id, title, type, status, maturity, summary
				 FROM roadmap_proposal.proposal
				 WHERE parent_id = $1
				 ORDER BY id`,
				[proposal.id],
			);

			// 7. Build YAML+MD projection
			const did = proposal.display_id ?? `#${proposal.id}`;
			const lease = leaseResult.rows[0] ?? null;
			const decision = decisionResult.rows[0] ?? null;
			const deps = depResult.rows;
			const children = childrenResult.rows;

			let md = `---\n`;
			md += `id: ${did}\n`;
			md += `title: "${proposal.title}"\n`;
			md += `type: ${proposal.type}\n`;
			md += `status: ${proposal.status}\n`;
			md += `maturity: ${proposal.maturity ?? "new"}\n`;
			if (proposal.priority) md += `priority: ${proposal.priority}\n`;
			if (proposal.parent_id) md += `parent_id: ${proposal.parent_id}\n`;
			if (lease) {
				md += `lease:\n`;
				md += `  agent: "${lease.agent_identity}"\n`;
				md += `  claimed_at: ${lease.claimed_at}\n`;
				if (lease.expires_at) md += `  expires_at: ${lease.expires_at}\n`;
			}
			if (decision) {
				md += `decision:\n`;
				md += `  verdict: "${decision.decision}"\n`;
				md += `  authority: "${decision.authority}"\n`;
				md += `  decided_at: ${decision.decided_at}\n`;
			}
			if ((proposal as Record<string, unknown>).workflow_name) md += `workflow: ${(proposal as Record<string, unknown>).workflow_name}\n`;
			md += `---\n\n`;

			// Narrative sections
			if (proposal.motivation) {
				md += `## Motivation\n\n${proposal.motivation}\n\n`;
			}
			if (proposal.summary) {
				md += `## Summary\n\n${proposal.summary}\n\n`;
			}
			if (proposal.design) {
				md += `## Design\n\n${proposal.design}\n\n`;
			}
			if (proposal.drawbacks) {
				md += `## Drawbacks\n\n${proposal.drawbacks}\n\n`;
			}
			if (proposal.alternatives) {
				md += `## Alternatives\n\n${proposal.alternatives}\n\n`;
			}
			if (proposal.dependency_note) {
				md += `## Dependencies (Free Text)\n\n${proposal.dependency_note}\n\n`;
			}
			if (decision?.rationale) {
				md += `## Decision Rationale\n\n${decision.rationale}\n\n`;
			}

			// Acceptance criteria
			if (acResult.rows.length > 0) {
				md += `## Acceptance Criteria\n\n`;
				for (const ac of acResult.rows) {
					const icon = ac.status === "pass" ? "✅" :
						ac.status === "fail" ? "❌" :
						ac.status === "blocked" ? "🚫" :
						ac.status === "waived" ? "⏭️" : "⏳";
					md += `${icon} **AC-${ac.item_number}**: ${ac.criterion_text}`;
					if (ac.verified_by) md += ` (verified by ${ac.verified_by})`;
					md += `\n`;
				}
				md += `\n`;
			}

			// DAG dependencies
			if (deps.length > 0) {
				md += `## DAG Dependencies\n\n`;
				for (const d of deps) {
					const status = d.resolved ? "resolved" : "active";
					md += `- ${d.display_id} (${d.dependency_type}) [${status}]\n`;
				}
				md += `\n`;
			}

			// Direct children (shallow — no recursive descent)
			if (children.length > 0) {
				md += `## Children\n\n`;
				for (const c of children) {
					const summary = c.summary
						? ` — ${c.summary.slice(0, 120)}${c.summary.length > 120 ? '…' : ''}`
						: '';
					md += `- **${c.display_id}** (${c.type}) [${c.status}/${c.maturity}] ${c.title}${summary}\n`;
				}
				md += `\n`;
			}

			if (args.format === "json") {
				const jsonPayload: Record<string, unknown> = {
					id: did,
					title: proposal.title,
					type: proposal.type,
					status: proposal.status,
					maturity: proposal.maturity ?? "new",
					priority: proposal.priority ?? null,
					parent_id: proposal.parent_id ?? null,
					motivation: proposal.motivation ?? null,
					summary: proposal.summary ?? null,
					design: proposal.design ?? null,
					drawbacks: proposal.drawbacks ?? null,
					alternatives: proposal.alternatives ?? null,
					dependency_note: proposal.dependency_note ?? null,
					lease: lease
						? {
							agent: lease.agent_identity,
							claimed_at: lease.claimed_at,
							expires_at: lease.expires_at ?? null,
						}
						: null,
					decision: decision
						? {
							verdict: decision.decision,
							authority: decision.authority,
							rationale: decision.rationale ?? null,
							decided_at: decision.decided_at,
						}
						: null,
					dependencies: deps.map((d: Record<string, unknown>) => ({
						display_id: d.display_id,
						dependency_type: d.dependency_type,
						resolved: d.resolved,
					})),
					acceptance_criteria: acResult.rows.map((ac: Record<string, unknown>) => ({
						item_number: ac.item_number,
						criterion_text: ac.criterion_text,
						status: ac.status,
						verified_by: ac.verified_by ?? null,
						verified_at: ac.verified_at ?? null,
					})),
					children: children.map((c: Record<string, unknown>) => ({
						display_id: c.display_id,
						title: c.title,
						type: c.type,
						status: c.status,
						maturity: c.maturity,
					})),
				};
				return {
					content: [{ type: "text", text: JSON.stringify(jsonPayload, null, 2) }],
				};
			}


			return {
				content: [{ type: "text", text: md }],
			};
		} catch (err) {
			return errorResult("Failed to get proposal projection", err);
		}
	}

	async mapUpsert(args: {
		legacy_proposal_id: string;
		classification: string;
		rationale: string;
		evidence_refs?: unknown[];
		canonical_proposal_id?: string;
		superseded_by_proposal_id?: string;
		reviewed_by?: string;
		notes?: string;
		created_by?: string;
	}): Promise<CallToolResult> {
		const validClassifications = [
			"retained", "delivered_evidence", "duplicate",
			"obsolete", "reauthor_needed", "superseded",
		];
		if (!validClassifications.includes(args.classification)) {
			return {
				content: [{ type: "text", text: `Invalid classification '${args.classification}'. Must be one of: ${validClassifications.join(", ")}` }],
			};
		}
		if (!args.rationale || args.rationale.trim().length === 0) {
			return { content: [{ type: "text", text: "rationale is required and must be non-empty." }] };
		}

		try {
			// Resolve row IDs for FK columns
			const [legacyRowId, canonicalRowId, supersededRowId] = await Promise.all([
				pg.resolveProposalId(args.legacy_proposal_id),
				args.canonical_proposal_id ? pg.resolveProposalId(args.canonical_proposal_id) : Promise.resolve(null),
				args.superseded_by_proposal_id ? pg.resolveProposalId(args.superseded_by_proposal_id) : Promise.resolve(null),
			]);

			const evidenceRefs = args.evidence_refs ?? [];
			const reviewedAt = args.reviewed_by ? new Date() : null;

			const result = await query(
				`INSERT INTO roadmap_proposal.proposal_migration_map
				 (legacy_proposal_id, legacy_proposal_row_id, classification, rationale,
				  evidence_refs, canonical_proposal_id, canonical_proposal_row_id,
				  superseded_by_proposal_id, superseded_by_row_id,
				  reviewed_by, reviewed_at, notes, created_by)
				 VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13)
				 ON CONFLICT (legacy_proposal_id) DO UPDATE SET
				   classification = EXCLUDED.classification,
				   rationale = EXCLUDED.rationale,
				   evidence_refs = EXCLUDED.evidence_refs,
				   canonical_proposal_id = EXCLUDED.canonical_proposal_id,
				   canonical_proposal_row_id = EXCLUDED.canonical_proposal_row_id,
				   superseded_by_proposal_id = EXCLUDED.superseded_by_proposal_id,
				   superseded_by_row_id = EXCLUDED.superseded_by_row_id,
				   reviewed_by = EXCLUDED.reviewed_by,
				   reviewed_at = CASE WHEN EXCLUDED.reviewed_by IS NOT NULL THEN EXCLUDED.reviewed_at ELSE roadmap_proposal.proposal_migration_map.reviewed_at END,
				   notes = EXCLUDED.notes,
				   legacy_proposal_row_id = EXCLUDED.legacy_proposal_row_id,
				   updated_at = now()
				 RETURNING *`,
				[
					args.legacy_proposal_id,
					legacyRowId,
					args.classification,
					args.rationale.trim(),
					JSON.stringify(evidenceRefs),
					args.canonical_proposal_id ?? null,
					canonicalRowId,
					args.superseded_by_proposal_id ?? null,
					supersededRowId,
					args.reviewed_by ?? null,
					reviewedAt,
					args.notes ?? null,
					args.created_by ?? "system",
				],
			);

			return {
				content: [{ type: "text", text: JSON.stringify(result.rows[0], null, 2) }],
			};
		} catch (err) {
			return errorResult("map_upsert failed", err);
		}
	}

	async mapGet(args: { legacy_proposal_id: string }): Promise<CallToolResult> {
		if (!args.legacy_proposal_id) {
			return { content: [{ type: "text", text: "legacy_proposal_id is required." }] };
		}
		try {
			const result = await query(
				`SELECT * FROM roadmap_proposal.proposal_migration_map WHERE legacy_proposal_id = $1`,
				[args.legacy_proposal_id],
			);
			if (!result.rows.length) {
				return { content: [{ type: "text", text: `No mapping found for ${args.legacy_proposal_id}.` }] };
			}
			return { content: [{ type: "text", text: JSON.stringify(result.rows[0], null, 2) }] };
		} catch (err) {
			return errorResult("map_get failed", err);
		}
	}

	async mapQuery(args: {
		classification?: string;
		reviewed?: boolean;
		needs_review?: boolean;
		limit?: number;
	}): Promise<CallToolResult> {
		try {
			const conditions: string[] = [];
			const params: unknown[] = [];

			if (args.classification) {
				conditions.push(`classification = $${params.length + 1}`);
				params.push(args.classification);
			}
			if (args.reviewed === true) {
				conditions.push(`reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL`);
			} else if (args.reviewed === false) {
				conditions.push(`(reviewed_by IS NULL OR reviewed_at IS NULL)`);
			}
			if (args.needs_review === true) {
				conditions.push(
					`(reviewed_by IS NULL OR reviewed_at IS NULL OR evidence_refs = '[]'::jsonb ` +
					`OR (canonical_proposal_id IS NULL AND classification NOT IN ('obsolete','duplicate')))`,
				);
			}

			const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
			const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
			params.push(limit);

			const result = await query(
				`SELECT * FROM roadmap_proposal.proposal_migration_map ${where} ORDER BY legacy_proposal_id LIMIT $${params.length}`,
				params,
			);
			return {
				content: [{ type: "text", text: JSON.stringify({ count: result.rows.length, rows: result.rows }, null, 2) }],
			};
		} catch (err) {
			return errorResult("map_query failed", err);
		}
	}

	async mapSummary(_args: Record<string, never>): Promise<CallToolResult> {
		try {
			const result = await query(
				`SELECT * FROM roadmap_proposal.v_migration_classification_summary ORDER BY classification`,
				[],
			);
			const total = result.rows.reduce((sum: number, r: any) => sum + Number(r.total), 0);
			return {
				content: [{
					type: "text",
					text: JSON.stringify({ grand_total: total, by_classification: result.rows }, null, 2),
				}],
			};
		} catch (err) {
			return errorResult("map_summary failed", err);
		}
	}

	private buildPreview(proposal: ProposalRow): string {
		const source =
			proposal.summary ?? proposal.motivation ?? proposal.design ?? "";
		return source ? source.substring(0, 150) : "";
	}

	// P1291: Resume a paused role
	async resumeRole(args: {
		proposal_id: string;
		role: string;
		reason: string;
	}): Promise<CallToolResult> {
		try {
			const id = await pg.resolveProposalId(args.proposal_id);
			if (id === null) {
				return {
					content: [{ type: "text", text: `Proposal ${args.proposal_id} not found.` }],
				};
			}

			// Delete the pause row and record in control_audit
			const { rows } = await query<{ deleted: boolean }>(
				`DELETE FROM roadmap_workforce.proposal_role_pause
				  WHERE proposal_id = $1 AND role = $2
				  RETURNING (xmax::text::int = 0) AS deleted`,
				[id, args.role],
			);

			if (!rows[0]?.deleted) {
				return {
					content: [{
						type: "text",
						text: `No pause found for proposal ${args.proposal_id} role=${args.role}.`,
					}],
				};
			}

			// Record in control_audit
			await query(
				`INSERT INTO roadmap.control_audit
				   (actor, action, target_type, target_id, metadata)
				 VALUES ($1, 'resume_role', 'proposal_role_pause', $2, $3::jsonb)`,
				[
					process.env.AGENTHIVE_OPERATOR_IDENTITY ?? "system",
					id,
					JSON.stringify({ role: args.role, reason: args.reason }),
				],
			);

			return {
				content: [{
					type: "text",
					text: `Resumed role=${args.role} for proposal ${args.proposal_id} (reason: ${args.reason})`,
				}],
			};
		} catch (err) {
			return errorResult("Failed to resume role", err);
		}
	}

	// P1291: List active role pauses
	async listRolePauses(args: {
		proposal_id?: string;
	}): Promise<CallToolResult> {
		try {
			let id: number | null = null;
			if (args.proposal_id) {
				id = await pg.resolveProposalId(args.proposal_id);
				if (id === null) {
					return {
						content: [{ type: "text", text: `Proposal ${args.proposal_id} not found.` }],
					};
				}
			}

			const query_sql = id
				? `SELECT proposal_id, role, pause_reason, failure_count, pause_cycle,
					      paused_at, expires_at,
					      greatest(expires_at - now(), interval '0') AS time_until_resume
					   FROM roadmap_workforce.proposal_role_pause
					  WHERE proposal_id = $1
					    AND expires_at > now()
					  ORDER BY paused_at DESC`
				: `SELECT proposal_id, role, pause_reason, failure_count, pause_cycle,
					      paused_at, expires_at,
					      greatest(expires_at - now(), interval '0') AS time_until_resume
					   FROM roadmap_workforce.proposal_role_pause
					  WHERE expires_at > now()
					  ORDER BY paused_at DESC`;

			const { rows } = await query<{
				proposal_id: number;
				role: string;
				pause_reason: string;
				failure_count: number;
				pause_cycle: number;
				paused_at: string;
				expires_at: string;
				time_until_resume: string;
			}>(query_sql, id ? [id] : []);

			if (rows.length === 0) {
				return {
					content: [{
						type: "text",
						text: id
							? `No active pauses for proposal ${args.proposal_id}.`
							: "No active role pauses.",
					}],
				};
			}

			const formatted = rows.map(r => ({
				proposal_id: r.proposal_id,
				role: r.role,
				reason: r.pause_reason,
				failure_count: r.failure_count,
				cycle: r.pause_cycle,
				paused_at: r.paused_at,
				expires_at: r.expires_at,
				time_until_resume: r.time_until_resume,
			}));

			return {
				content: [{
					type: "text",
					text: JSON.stringify(formatted, null, 2),
				}],
			};
		} catch (err) {
			return errorResult("Failed to list role pauses", err);
		}
	}
}
