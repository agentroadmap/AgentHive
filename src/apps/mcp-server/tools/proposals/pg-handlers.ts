/**
 * Postgres-backed Proposal MCP Tools
 *
 * Provides the AgentHive-specific `prop_*` tool surface using Postgres.
 * All errors are caught and returned as MCP text responses rather than thrown,
 * preventing tool call crashes.
 */

import type { QueryResultRow } from "pg";
import { query } from "../../../../postgres/pool.ts";
import type { ProposalRow } from "../../../../postgres/proposal-storage-v2.ts";
import * as pg from "../../../../postgres/proposal-storage-v2.ts";
import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";
import { RfcStates, Maturity } from "../../../../core/workflow/state-names.ts";
import { validateLease, formatValidationError } from "../../../../core/proposal/proposal-integrity.ts";

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
		limit?: number;
		include_terminal?: boolean;
		include_metadata?: boolean;
	}): Promise<CallToolResult> {
		try {
			const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);
			const includeTerminal = args.include_terminal === true;
			const includeMetadata = args.include_metadata === true;

			let sql = `SELECT id, display_id, title, status, type, maturity, created_at${includeMetadata ? ", summary, design, motivation" : ""}
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

			if (args.type ?? args.proposal_type) {
				conditions.push(`type = $${params.length + 1}`);
				params.push(args.type ?? args.proposal_type);
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

			// AC-2: Require active lease before allowing transition (P224)
			const author = args.author ?? "system";
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
				const requestedStatus = args.status.toUpperCase();
				const allowedTargets = gateTransitions[currentStatus];
				if (allowedTargets?.includes(requestedStatus)) {
					if (!args.notes || args.notes.trim().length === 0) {
						return {
							content: [
								{
									type: "text",
									text: `Gate transition ${currentStatus} → ${requestedStatus} requires decision notes. Please provide notes with your reasoning.`,
								},
							],
						};
					}
				}
			}

			const updated = await pg.transitionProposal(
				id,
				args.status,
				author,
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

			const validMaturityValues = [Maturity.NEW, Maturity.ACTIVE, Maturity.MATURE, Maturity.OBSOLETE];
			if (!validMaturityValues.includes(args.maturity)) {
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
					content: [{ type: "text", text: `Proposal ${args.id} not found.` }],
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
		id: string;
		agent: string;
		durationMinutes?: number;
		force?: boolean;
	}): Promise<CallToolResult> {
		try {
			const id = await pg.resolveProposalId(args.id);
			if (id === null) {
				return {
					content: [{ type: "text", text: `Proposal ${args.id} not found.` }],
				};
			}

			await query(
				`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (agent_identity) DO UPDATE SET role = EXCLUDED.role`,
				[args.agent, "llm", "developer"],
			);

			const activeLeases = (await pg.getActiveLeases(id)).filter(
				(lease) => lease.lease_status === "active" || lease.lease_status === "open",
			);
			if (activeLeases.length > 0 && !args.force) {
				const lease = activeLeases[0];
				return {
					content: [
						{
							type: "text",
							text: `Proposal ${args.id} is already claimed by ${lease.agent_identity} until ${lease.expires_at ?? "no expiry"}. Pass force=true to replace the lease.`,
						},
					],
				};
			}

			if (args.force) {
				for (const lease of activeLeases) {
					await pg.releaseLease(id, lease.agent_identity, "force-reclaimed");
				}
			}

			const durationMinutes = args.durationMinutes ?? 120;
			const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000);
			const claimed = await pg.claimLease(id, args.agent, expiresAt);
			if (!claimed) {
				return {
					content: [
						{
							type: "text",
							text: `Proposal ${args.id} could not be claimed; another active lease exists.`,
						},
					],
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Claimed proposal ${args.id} for ${args.agent} until ${expiresAt.toISOString()}.`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to claim proposal", err);
		}
	}

	async releaseProposal(args: {
		id: string;
		agent: string;
		reason?: string;
	}): Promise<CallToolResult> {
		try {
			const id = await pg.resolveProposalId(args.id);
			if (id === null) {
				return {
					content: [{ type: "text", text: `Proposal ${args.id} not found.` }],
				};
			}

			const released = await pg.releaseLease(
				id,
				args.agent,
				args.reason ?? "released",
			);
			if (!released) {
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
						text: `Released proposal ${args.id} lease for ${args.agent}.`,
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

	async getProposalProjection(args: { id: string }): Promise<CallToolResult> {
		try {
			// 1. Fetch the proposal
			const proposal = await pg.getProposal(args.id);
			if (!proposal) {
				return {
					content: [{ type: "text", text: `Proposal ${args.id} not found.` }],
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

			// 6. Build YAML+MD projection
			const did = proposal.display_id ?? `#${proposal.id}`;
			const lease = leaseResult.rows[0] ?? null;
			const decision = decisionResult.rows[0] ?? null;
			const deps = depResult.rows;

			let md = `---\n`;
			md += `id: ${did}\n`;
			md += `title: "${proposal.title}"\n`;
			md += `type: ${proposal.type}\n`;
			md += `status: ${proposal.status}\n`;
			md += `maturity: ${proposal.maturity ?? "new"}\n`;
			if (proposal.priority) md += `priority: ${proposal.priority}\n`;
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
			if (proposal.workflow_name) md += `workflow: ${proposal.workflow_name}\n`;
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
			if (proposal.dependency) {
				md += `## Dependencies (Free Text)\n\n${proposal.dependency}\n\n`;
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

			return {
				content: [{ type: "text", text: md }],
			};
		} catch (err) {
			return errorResult("Failed to get proposal projection", err);
		}
	}

	private buildPreview(proposal: ProposalRow): string {
		const source =
			proposal.summary ?? proposal.motivation ?? proposal.design ?? "";
		return source ? source.substring(0, 150) : "";
	}
}
