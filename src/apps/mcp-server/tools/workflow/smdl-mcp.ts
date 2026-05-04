/**
 * SMDL (State Machine Definition Language) MCP Tool Registration
 *
 * Registers workflow management tools:
 * - workflow_load: Parse YAML SMDL and materialize into Postgres
 * - workflow_list: List all registered workflow templates
 *
 * Based on SMDL spec at: docs/pillars/1-proposal/state-machine-definition-language.md
 */

import yaml from "js-yaml";
import { smdlToMermaid } from "../../../../core/workflow/smdl-to-mermaid.ts";
import { query } from "../../../../postgres/pool.ts";
import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SMDLStage {
	name: string;
	order: number;
	description?: string;
	maturity_gate?: number;
	requires_ac?: boolean;
	quorum?: object;
	timeout?: string;
}

interface SMDLTransition {
	from: string;
	to: string;
	labels: string[];
	allowed_roles: string[];
	requires_ac?: boolean;
	gating?: object;
}

interface SMDLRole {
	name: string;
	description?: string;
	clearance?: number;
	is_default?: boolean;
}

interface SMDLWorkflow {
	id: string;
	name: string;
	description?: string;
	version?: string;
	start_stage?: string;
	terminal_stages?: string[];
	default_maturity_gate?: number;
	stages: SMDLStage[];
	transitions: SMDLTransition[];
	roles: SMDLRole[];
}

interface SMDLRoot {
	workflow: SMDLWorkflow;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── Workflow Load (from YAML) ──────────────────────────────────────────────

async function workflowLoad(args: { yaml?: string }): Promise<CallToolResult> {
	try {
		if (!args.yaml) {
			return {
				content: [
					{
						type: "text",
						text: "⚠️ Provide `yaml` parameter with SMDL YAML content.",
					},
				],
			};
		}

		const parsed = yaml.load(args.yaml) as SMDLRoot;
		if (
			!parsed?.workflow?.stages?.length ||
			!parsed?.workflow?.transitions?.length
		) {
			return {
				content: [
					{
						type: "text",
						text: "⚠️ Invalid SMDL: missing required `workflow.stages` or `workflow.transitions`.",
					},
				],
			};
		}

		const wf = parsed.workflow;

		// 1. Upsert template
		const { rows: tplRows } = await query(
			`INSERT INTO workflow_templates (name, description, smdl_id, smdl_definition, version, stage_count, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, NOW())
       ON CONFLICT (name) DO UPDATE SET
         description = EXCLUDED.description,
         smdl_definition = EXCLUDED.smdl_definition,
         version = EXCLUDED.version,
         stage_count = EXCLUDED.stage_count,
         modified_at = NOW()
       RETURNING id`,
			[
				wf.name,
				wf.description || null,
				wf.id,
				JSON.stringify(parsed),
				wf.version || "1.0.0",
				wf.stages.length,
			],
		);
		const templateId = tplRows[0].id;

		// 2. Materialize stages
		let stagesCount = 0;
		for (const stage of wf.stages) {
			await query(
				`INSERT INTO workflow_stages (template_id, stage_name, stage_order, maturity_gate, requires_ac, gating_config)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (template_id, stage_name) DO UPDATE SET
           stage_order = EXCLUDED.stage_order,
           maturity_gate = EXCLUDED.maturity_gate,
           requires_ac = EXCLUDED.requires_ac,
           gating_config = EXCLUDED.gating_config`,
				[
					templateId,
					stage.name,
					stage.order,
					stage.maturity_gate ?? wf.default_maturity_gate ?? 2,
					stage.requires_ac ?? false,
					stage.quorum ? JSON.stringify(stage.quorum) : null,
				],
			);
			stagesCount++;
		}

		// 3. Materialize transitions
		let transitionsCount = 0;
		for (const t of wf.transitions) {
			await query(
				`INSERT INTO workflow_transitions (template_id, from_stage, to_stage, labels, allowed_roles, requires_ac, gating_rules)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (template_id, from_stage, to_stage) DO UPDATE SET
           labels = EXCLUDED.labels,
           allowed_roles = EXCLUDED.allowed_roles,
           requires_ac = EXCLUDED.requires_ac,
           gating_rules = EXCLUDED.gating_rules`,
				[
					templateId,
					t.from,
					t.to,
					t.labels,
					t.allowed_roles,
					t.requires_ac ?? false,
					t.gating ? JSON.stringify(t.gating) : null,
				],
			);
			transitionsCount++;
		}

		// 4. Materialize roles
		let rolesCount = 0;
		for (const role of wf.roles) {
			await query(
				`INSERT INTO workflow_roles (template_id, role_name, description, clearance, is_default)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (template_id, role_name) DO UPDATE SET
           description = EXCLUDED.description,
           clearance = EXCLUDED.clearance,
           is_default = EXCLUDED.is_default`,
				[
					templateId,
					role.name,
					role.description || null,
					role.clearance ?? 1,
					role.is_default ?? false,
				],
			);
			rolesCount++;
		}

		return {
			content: [
				{
					type: "text",
					text: `✅ Loaded workflow "${wf.name}" (${wf.id})\nTemplate ID: ${templateId}\nStages: ${stagesCount} | Transitions: ${transitionsCount} | Roles: ${rolesCount}`,
				},
			],
		};
	} catch (err) {
		return errorResult("Failed to load SMDL workflow", err);
	}
}

// ─── List Workflows ──────────────────────────────────────────────────────────

async function listWorkflows(): Promise<CallToolResult> {
	try {
		const { rows } = await query(
			`SELECT id, name, description, smdl_id, version, stage_count, is_default, created_at
       FROM workflow_templates ORDER BY id`,
		);
		if (!rows.length) {
			return {
				content: [{ type: "text", text: "No workflow templates loaded." }],
			};
		}
		const lines = rows.map(
			(r) =>
				`- **[${r.id}]** ${r.name} (\`${r.smdl_id || r.name}\`) — ${r.stage_count || "?"} stages, ${r.is_default ? "⭐ default" : ""} — v${r.version || "1.0.0"}`,
		);
		return {
			content: [
				{ type: "text", text: `### Workflow Templates\n\n${lines.join("\n")}` },
			],
		};
	} catch (err) {
		return errorResult("Failed to list workflows", err);
	}
}

async function workflowVisualize(args: {
	yaml?: string;
}): Promise<CallToolResult> {
	try {
		if (!args.yaml) {
			return {
				content: [
					{
						type: "text",
						text: "⚠️ Provide `yaml` parameter with SMDL YAML content.",
					},
				],
			};
		}

		const mermaid = smdlToMermaid(args.yaml);
		return {
			content: [
				{
					type: "text",
					text: `\`\`\`mermaid\n${mermaid}\`\`\``,
				},
			],
		};
	} catch (err) {
		return errorResult("Failed to visualize SMDL workflow", err);
	}
}

// ─── Register MCP Tools ─────────────────────────────────────────────────────

export class SMDLWorkflowHandlers {
	private server: McpServer;

	constructor(server: McpServer) {
		this.server = server;
	}

	register(): void {
		this.server.addTool({
			name: "workflow_load",
			description:
				"Load a workflow from SMDL YAML definition and materialize it into Postgres",
			inputSchema: {
				type: "object",
				properties: {
					yaml: {
						type: "string",
						description: "SMDL YAML workflow definition",
					},
				},
				required: ["yaml"],
			},
			handler: (args: unknown) => workflowLoad(args as { yaml?: string }),
		});

		this.server.addTool({
			name: "workflow_list",
			description:
				"List all registered workflow templates with stages, transitions, and roles",
			inputSchema: { type: "object", properties: {} },
			handler: () => listWorkflows(),
		});

		this.server.addTool({
			name: "workflow_visualize",
			description:
				"Convert an SMDL YAML workflow definition into Mermaid stateDiagram-v2",
			inputSchema: {
				type: "object",
				properties: {
					yaml: {
						type: "string",
						description: "SMDL YAML workflow definition",
					},
				},
				required: ["yaml"],
			},
			handler: (args: unknown) => workflowVisualize(args as { yaml?: string }),
		});

		// eslint-disable-next-line no-console
		console.error("[MCP] Registered SMDL workflow tools (load YAML, list, visualize)");
	}
}
