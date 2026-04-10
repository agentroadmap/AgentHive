/**
 * Postgres-backed Proposal MCP Tools
 *
 * Provides the AgentHive-specific `prop_*` tool surface using Postgres.
 * All errors are caught and returned as MCP text responses rather than thrown,
 * preventing tool call crashes.
 */

import type { ProposalRow } from "../../../../postgres/proposal-storage-v2.ts";
import * as pg from "../../../../postgres/proposal-storage-v2.ts";
import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";

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

export class PgProposalHandlers {
	constructor(
		private readonly core: McpServer,
		private readonly projectRoot: string,
	) {}

	async listProposals(args: {
		status?: string;
		type?: string;
		proposal_type?: string;
	}): Promise<CallToolResult> {
		try {
			const proposals = await pg.listProposals({
				status: args.status,
				type: args.type ?? args.proposal_type,
			});
			if (!proposals || proposals.length === 0) {
				return { content: [{ type: "text", text: "No proposals found." }] };
			}
			const lines = proposals.map((p) => {
				const did = p.display_id ?? `#${p.id}`;
				return `[${did}] ${p.title || "(no title)"} — status: ${p.status}, type: ${p.type}, maturity: ${this.formatMaturity(p.maturity, p.status, p.maturity_state)}`;
			});
			return { content: [{ type: "text", text: lines.join("\n") }] };
		} catch (err) {
			return errorResult("Failed to list proposals", err);
		}
	}

	async getProposal(args: { id: string }): Promise<CallToolResult> {
		try {
			// display_id is text (e.g. 'P001'), db id is bigint.
			// Always pass as string — the storage layer uses separate queries
			// to avoid Postgres cross-type comparison errors.
			const proposal = await pg.getProposal(args.id);
			if (!proposal) {
				return {
					content: [{ type: "text", text: `Proposal ${args.id} not found.` }],
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
			const created = await pg.createProposal(
				{
					display_id: args.display_id || null,
					type: proposalType,
					title: args.title,
					status: args.status || null,
					parent_id: args.parent_id ? parseInt(args.parent_id, 10) : null,
					summary: args.summary ?? args.body_markdown ?? null,
					motivation: args.motivation || null,
					design: args.design || null,
					drawbacks: args.drawbacks || null,
					alternatives: args.alternatives || null,
					dependency: args.dependency || null,
					priority: args.priority || null,
					tags: args.tags ? JSON.parse(args.tags) : null,
				},
				author,
			);
			return {
				content: [
					{
						type: "text",
						text: `Created proposal: [${created.display_id ?? created.id}] ${created.title}`,
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
	}): Promise<CallToolResult> {
		try {
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
			if (args.dependency) updates.dependency = args.dependency;
			if (args.priority) updates.priority = args.priority;
			if (args.body_markdown) updates.summary = args.body_markdown;
			if (args.tags) updates.tags = JSON.parse(args.tags);

			let updated =
				Object.keys(updates).length > 0
					? await pg.updateProposal(id, updates)
					: await pg.getProposal(id);
			if (args.status) {
				updated = await pg.transitionProposal(
					id,
					args.status,
					args.author ?? "system",
					"Updated via prop_update",
				);
			}

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
		id: string;
		status: string;
		author?: string;
		reason?: string;
		notes?: string;
	}): Promise<CallToolResult> {
		try {
			const id = await pg.resolveProposalId(args.id);
			if (id === null) {
				return {
					content: [{ type: "text", text: `Proposal ${args.id} not found.` }],
				};
			}

			const updated = await pg.transitionProposal(
				id,
				args.status,
				args.author ?? "system",
				args.reason,
				args.notes,
			);
			if (!updated) {
				return {
					content: [{ type: "text", text: `Proposal ${args.id} not found.` }],
				};
			}
			return {
				content: [
					{
						type: "text",
						text: `Transitioned proposal ${args.id} → ${args.status}`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to transition proposal", err);
		}
	}

	async setMaturity(args: {
		id: string;
		maturity: string;
		agent?: string;
		reason?: string;
	}): Promise<CallToolResult> {
		try {
			const id = await pg.resolveProposalId(args.id);
			if (id === null) {
				return {
					content: [{ type: "text", text: `Proposal ${args.id} not found.` }],
				};
			}

			const valid = ["new", "active", "mature", "obsolete"];
			if (!valid.includes(args.maturity)) {
				return {
					content: [{
						type: "text",
						text: `Invalid maturity '${args.maturity}'. Must be one of: ${valid.join(", ")}`,
					}],
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
					content: [{ type: "text", text: `Proposal ${args.id} not found.` }],
				};
			}

			const gateNote = args.maturity === "mature"
				? ` — gate-ready event fired (D${
						{ DRAFT: "1", REVIEW: "2", DEVELOP: "3", MERGE: "4" }[updated.status] ?? "?"
					} queue)`
				: "";
			return {
				content: [{
					type: "text",
					text: `[${updated.display_id}] maturity set to '${args.maturity}'${gateNote}`,
				}],
			};
		} catch (err) {
			return errorResult("Failed to set maturity", err);
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

	async getVersions(args: { id: string }): Promise<CallToolResult> {
		try {
			const versions = await pg.getProposalVersions(args.id);
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
				return `[${did}] ${p.title || "(no title)"} — status: ${p.status}, type: ${p.type}, maturity: ${this.formatMaturity(p.maturity, p.status, p.maturity_state)}\n  ${preview}`;
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

	private buildPreview(proposal: ProposalRow): string {
		const source =
			proposal.summary ?? proposal.motivation ?? proposal.design ?? "";
		return source ? source.substring(0, 150) : "";
	}

	private formatMaturity(
		maturity: Record<string, string> | null | undefined,
		status: string,
		maturityState?: string,
	): string {
		// Prefer the new canonical maturity_state column when available
		if (maturityState) return maturityState;
		// Fall back to legacy JSONB map
		if (!maturity || typeof maturity !== "object") return "unknown";
		return maturity[status] ?? Object.values(maturity)[0] ?? "unknown";
	}
}
