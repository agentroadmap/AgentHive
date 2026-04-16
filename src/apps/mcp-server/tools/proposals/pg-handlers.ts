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

type ProjectionFormat = "yaml_md" | "json";

type ProjectionField =
	| "id"
	| "display_id"
	| "title"
	| "type"
	| "status"
	| "maturity"
	| "priority"
	| "summary"
	| "motivation"
	| "design"
	| "drawbacks"
	| "alternatives"
	| "dependency"
	| "dependencies"
	| "acceptance_criteria"
	| "criteria"
	| "lease"
	| "workflow"
	| "latest_decision"
	| "tags";

type ProposalProjectionArgs = {
	id?: string;
	projection?: string;
	fields?: string[] | string;
	format?: ProjectionFormat;
};

type ProposalProjectionRow = QueryResultRow & {
	id: number;
	display_id: string | null;
	title: string;
	type: string;
	status: string;
	maturity: string;
	priority: string | null;
	summary: string | null;
	motivation: string | null;
	design: string | null;
	drawbacks: string | null;
	alternatives: string | null;
	dependency: string | null;
	dependencies: unknown;
	acceptance_criteria: unknown;
	latest_decision: string | null;
	decision_at: Date | string | null;
	leased_by: string | null;
	lease_expires: Date | string | null;
	workflow_name: string | null;
	current_stage: string | null;
	tags: unknown;
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

const PROJECTION_FIELD_ALIASES: Record<string, ProjectionField> = {
	acceptance: "acceptance_criteria",
	acceptance_criteria: "acceptance_criteria",
	criteria: "acceptance_criteria",
	dependency_link: "dependencies",
	id: "id",
	display_id: "display_id",
	title: "title",
	type: "type",
	status: "status",
	state: "status",
	maturity: "maturity",
	priority: "priority",
	summary: "summary",
	motivation: "motivation",
	design: "design",
	drawbacks: "drawbacks",
	alternatives: "alternatives",
	dependency: "dependency",
	dependencies: "dependencies",
	lease: "lease",
	workflow: "workflow",
	latest_decision: "latest_decision",
	decision: "latest_decision",
	tags: "tags",
};

const DEFAULT_PROJECTION_FIELDS: ProjectionField[] = [
	"id",
	"display_id",
	"title",
	"type",
	"status",
	"maturity",
	"priority",
	"lease",
	"motivation",
	"design",
	"acceptance_criteria",
];

function normalizeProjectionField(field: string): ProjectionField | null {
	const key = field.trim().toLowerCase();
	return PROJECTION_FIELD_ALIASES[key] ?? null;
}

function parseProjectionArgs(args: ProposalProjectionArgs): {
	id: string | null;
	fields: ProjectionField[];
} {
	let id = args.id?.trim() || null;
	const rawFields: string[] = [];

	if (args.projection?.trim()) {
		const projection = args.projection.trim();
		const match = projection.match(/\{\s*([^,}\s]+)\s*:\s*([^,}]+)(.*)\}/);
		if (match) {
			if (!id && match[1].trim() === "id") {
				id = match[2].trim().replace(/^['"]|['"]$/g, "");
			}
			rawFields.push(
				...match[3]
					.split(",")
					.map((part) => part.trim())
					.filter(Boolean),
			);
		} else {
			rawFields.push(...projection.split(","));
		}
	}

	if (Array.isArray(args.fields)) {
		rawFields.push(...args.fields);
	} else if (typeof args.fields === "string") {
		rawFields.push(...args.fields.split(","));
	}

	const fields = rawFields
		.map(normalizeProjectionField)
		.filter((field): field is ProjectionField => Boolean(field));

	return {
		id,
		fields: fields.length > 0 ? Array.from(new Set(fields)) : DEFAULT_PROJECTION_FIELDS,
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
				return `[${did}] ${p.title || "(no title)"} — status: ${p.status}, type: ${p.type}, maturity: ${p.maturity ?? "unknown"}`;
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

	async getProposalProjection(args: ProposalProjectionArgs): Promise<CallToolResult> {
		try {
			const projection = parseProjectionArgs(args);
			if (!projection.id) {
				return {
					content: [
						{
							type: "text",
							text: "Projection requires an id, either as { id } or inside projection, e.g. roadmap proposal detail {id:P190, title, maturity, design}.",
						},
					],
				};
			}

			const numericId = Number.parseInt(projection.id, 10);
			const { rows } = await query<ProposalProjectionRow>(
				`SELECT *
				 FROM roadmap_proposal.v_proposal_full
				 WHERE display_id = $1 OR id = $2
				 LIMIT 1`,
				[projection.id, Number.isNaN(numericId) ? null : numericId],
			);
			const row = rows[0];
			if (!row) {
				return {
					content: [
						{
							type: "text",
							text: `Proposal ${projection.id} not found.`,
						},
					],
				};
			}

			const object = this.buildProjectionObject(row, projection.fields);
			const text =
				args.format === "json"
					? JSON.stringify(object, null, 2)
					: this.formatProjectionYamlMarkdown(object, projection.fields);

			return { content: [{ type: "text", text }] };
		} catch (err) {
			return errorResult("Failed to get proposal projection", err);
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

			// Gate transitions require decision notes
			const gateTransitions: Record<string, string[]> = {
				Draft: ["Review"],
				Review: ["Develop"],
				Develop: ["Merge"],
				Merge: ["Complete"],
			};

			// Get current status to check if this is a gate transition
			const current = await pg.getProposal(id);
			if (current) {
				const allowedTargets = gateTransitions[current.status];
				if (allowedTargets?.includes(args.status)) {
					if (!args.notes || args.notes.trim().length === 0) {
						return {
							content: [
								{
									type: "text",
									text: `Gate transition ${current.status} → ${args.status} requires decision notes. Please provide notes with your reasoning.`,
								},
							],
						};
					}
				}
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
					content: [
						{
							type: "text",
							text: `Invalid maturity '${args.maturity}'. Must be one of: ${valid.join(", ")}`,
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

			const gateNote =
				args.maturity === "mature"
					? ` — gate-ready event fired (D${
							{ DRAFT: "1", REVIEW: "2", DEVELOP: "3", MERGE: "4" }[
								updated.status
							] ?? "?"
						} queue)`
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
				`INSERT INTO agent_registry (agent_identity, agent_type, role)
         VALUES ($1, $2, $3)
         ON CONFLICT ON CONSTRAINT agent_registry_agent_identity_key
         DO UPDATE SET role = EXCLUDED.role`,
				[args.agent, "llm", "developer"],
			);

			const activeLeases = await pg.getActiveLeases(id);
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

	private buildPreview(proposal: ProposalRow): string {
		const source =
			proposal.summary ?? proposal.motivation ?? proposal.design ?? "";
		return source ? source.substring(0, 150) : "";
	}

	private buildProjectionObject(
		row: ProposalProjectionRow,
		fields: ProjectionField[],
	): Record<string, unknown> {
		const object: Record<string, unknown> = {};
		for (const field of fields) {
			switch (field) {
				case "maturity":
					object.maturity = row.maturity;
					break;
				case "criteria":
				case "acceptance_criteria":
					object.acceptance_criteria = normalizeJsonArray(row.acceptance_criteria);
					break;
				case "lease":
					object.lease = row.leased_by
						? { agent: row.leased_by, expires: row.lease_expires }
						: null;
					break;
				case "workflow":
					object.workflow = {
						name: row.workflow_name,
						current_stage: row.current_stage,
					};
					break;
				case "dependencies":
					object.dependencies = normalizeJsonArray(row.dependencies);
					break;
				case "latest_decision":
					object.latest_decision = row.latest_decision
						? { decision: row.latest_decision, decided_at: row.decision_at }
						: null;
					break;
				default:
					object[field] = row[field];
					break;
			}
		}
		return object;
	}

	private formatProjectionYamlMarkdown(
		object: Record<string, unknown>,
		fields: ProjectionField[],
	): string {
		const metadataKeys = [
			"id",
			"display_id",
			"title",
			"type",
			"status",
			"maturity",
			"priority",
			"lease",
			"workflow",
			"latest_decision",
			"tags",
		];
		const metadata = metadataKeys
			.filter((key) => Object.hasOwn(object, key))
			.map((key) => {
				const value = object[key];
				if (value && typeof value === "object") {
					return `${key}: ${JSON.stringify(value)}`;
				}
				return `${key}: ${yamlValue(value)}`;
			})
			.join("\n");

		const sections: string[] = [];
		for (const field of fields) {
			switch (field) {
				case "summary":
				case "motivation":
				case "design":
				case "drawbacks":
				case "alternatives":
				case "dependency": {
					const value = object[field];
					if (value) {
						sections.push(`## ${field.replace(/_/g, " ")}\n${formatScalar(value)}`);
					}
					break;
				}
				case "dependencies": {
					if (Object.hasOwn(object, "dependencies")) {
						sections.push(
							`## Dependencies\n${markdownList(normalizeJsonArray(object.dependencies), "to_display_id")}`,
						);
					}
					break;
				}
				case "criteria":
				case "acceptance_criteria": {
					if (Object.hasOwn(object, "acceptance_criteria")) {
						sections.push(
							`## Acceptance Criteria\n${markdownList(
								normalizeJsonArray(object.acceptance_criteria),
								"criterion_text",
							)}`,
						);
					}
					break;
				}
			}
		}

		return `# --- METADATA (YAML) ---\n${metadata}\n# -----------------------\n\n# --- NARRATIVE (Markdown) ---\n${sections.join("\n\n") || "No narrative fields requested."}`;
	}
}
