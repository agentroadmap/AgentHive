import type { McpServer } from "../../server.ts";
import { mapUpsert, mapGet, mapQuery, mapSummary } from "./pg-handlers.ts";

export function registerMigrationMapTools(server: McpServer): void {
	server.addTool({
		name: "map_upsert",
		description:
			"P997: Insert or update a proposal_migration_map row. " +
			"Classifies a legacy proposal ID against the P995 vocabulary. " +
			"Required: legacy_proposal_id (text), classification (retained|delivered_evidence|duplicate|obsolete|reauthor_needed|superseded), rationale (non-empty string). " +
			"Optional: evidence_refs (array), canonical_proposal_id (text), superseded_by_proposal_id (text), reviewed_by (text), reviewed_at (ISO timestamp), created_by, notes.",
		inputSchema: {
			type: "object",
			properties: {
				legacy_proposal_id:       { type: "string", description: "Numeric or display ID of the legacy proposal (e.g. '821')" },
				classification:           { type: "string", enum: ["retained", "delivered_evidence", "duplicate", "obsolete", "reauthor_needed", "superseded"] },
				rationale:                { type: "string", description: "Non-empty reason for the classification" },
				evidence_refs:            { type: "array", description: "Structured evidence array: [{type:'commit',sha:'...'}, {type:'proposal',id:N}, ...]" },
				canonical_proposal_id:    { type: "string", description: "Text ID of the agentHive2 canonical proposal that owns/supersedes this row" },
				superseded_by_proposal_id:{ type: "string", description: "Required when classification is 'superseded' or 'duplicate'" },
				reviewed_by:              { type: "string", description: "Agent alias or email of reviewer" },
				reviewed_at:              { type: "string", description: "ISO timestamp of review (defaults to now() when reviewed_by is supplied)" },
				created_by:               { type: "string", description: "Agent alias that created this row (default: 'agent')" },
				notes:                    { type: "string", description: "Free-form notes, e.g. 'needs second opinion'" },
			},
			required: ["legacy_proposal_id", "classification", "rationale"],
		},
		handler: async (args) => mapUpsert(args as any),
	});

	server.addTool({
		name: "map_get",
		description:
			"P997: Fetch a single proposal_migration_map row by legacy_proposal_id.",
		inputSchema: {
			type: "object",
			properties: {
				legacy_proposal_id: { type: "string", description: "Legacy proposal ID to look up" },
			},
			required: ["legacy_proposal_id"],
		},
		handler: async (args) => mapGet(args as any),
	});

	server.addTool({
		name: "map_query",
		description:
			"P997: Query proposal_migration_map rows. " +
			"Supports filtering by classification, reviewed status, and needs_review flag (rows missing reviewer/canonical/superseded_by). " +
			"Default limit 100, max 500.",
		inputSchema: {
			type: "object",
			properties: {
				classification: { type: "string", enum: ["retained", "delivered_evidence", "duplicate", "obsolete", "reauthor_needed", "superseded"], description: "Filter by classification" },
				reviewed:       { type: "boolean", description: "true = only reviewed rows; false = only unreviewed rows; omit = both" },
				needs_review:   { type: "boolean", description: "true = rows missing reviewer, canonical target, or superseded_by pointer" },
				limit:          { type: "number", description: "Max rows to return (default 100, max 500)" },
			},
		},
		handler: async (args) => mapQuery(args as any),
	});

	server.addTool({
		name: "map_summary",
		description:
			"P997: Roll-up counts from v_migration_classification_summary — total, reviewed, unreviewed, with/without evidence per classification.",
		inputSchema: { type: "object", properties: {} },
		handler: async () => mapSummary(),
	});
}
