import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";
import { describeTable, lintMigration } from "./pg-handlers.ts";

function textResult(text: string): CallToolResult {
	return { content: [{ type: "text", text }] };
}

function jsonResult(payload: unknown): CallToolResult {
	return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Register mcp_schema family tools.
 *
 * Lands the Tier-1 deliverable of P1109: build agents call this BEFORE
 * writing migration SQL so they don't fabricate column / schema / constraint
 * names. Replaces psql `\d <table>` with a tool any MCP client can invoke.
 */
export function registerSchemaTools(server: McpServer): void {
	server.addTool({
		name: "schema_describe",
		description:
			"Return the canonical structure of a table: columns (name, type, nullable, default), CHECK constraints, triggers (timing + event + fn), indexes. Accepts qualified ('roadmap_workforce.squad_dispatch') or bare name; bare names resolve via search_path order. Build agents calling this BEFORE writing SQL avoid the fabrication patterns that hit P1017 (assigned_agency, agency_id, host_id, agent_type='user', presence_state_enum).",
		inputSchema: {
			type: "object",
			properties: {
				table: {
					type: "string",
					description:
						"Table name. Qualified (schema.table) or bare. Bare resolves through roadmap, roadmap_workforce, roadmap_proposal, roadmap_efficiency, public.",
				},
			},
			required: ["table"],
		},
		handler: async (args: Record<string, unknown>) => {
			const table = args.table;
			if (typeof table !== "string" || table.length === 0) {
				return textResult(
					`schema_describe requires { table: string }. Got: ${JSON.stringify(args)}`,
				);
			}
			const result = await describeTable(table);
			return jsonResult(result);
		},
	});

	server.addTool({
		// P1114 AC-6: DDL / schema-mutation surface (the `apply_migration`-class
		// tool of this codebase — executes migration SQL, albeit in a rolled-back
		// SAVEPOINT) — HIGHEST tier, schema_write scope.
		clearance: { min_tier: "authority", scope: "schema_write" },
		name: "schema_lint_migration",
		description:
			"Validate SQL migration by executing it inside a SAVEPOINT and ROLLBACKing. Catches fabrication patterns: non-existent columns, invalid CHECK constraint values, forward-references, and JSDoc comment blocks. Returns {valid: bool, errors: string[], warnings: string[]}.",
		inputSchema: {
			type: "object",
			properties: {
				sql: {
					type: "string",
					description:
						"Raw SQL code to lint. The linter will execute it inside a transaction and roll back, catching schema violations without side effects.",
				},
			},
			required: ["sql"],
		},
		handler: async (args: Record<string, unknown>) => {
			const sql = args.sql;
			if (typeof sql !== "string" || sql.length === 0) {
				return textResult(
					`schema_lint_migration requires { sql: string }. Got: ${JSON.stringify(args)}`,
				);
			}
			const result = await lintMigration(sql);
			return jsonResult(result);
		},
	});
}
