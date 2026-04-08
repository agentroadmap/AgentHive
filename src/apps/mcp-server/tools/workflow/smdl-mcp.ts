/**
 * SMDL (State Machine Definition Language) MCP Tool Registration
 *
 * Registers 3 workflow management tools:
 * - workflow_load: Parse YAML SMDL and materialize into Postgres
 * - workflow_load_builtin: Load the 3 preset workflows from SMDL spec
 * - workflow_list: List all registered workflow templates
 *
 * Based on SMDL spec at: docs/pillars/1-proposal/state-machine-definition-language.md
 */

import yaml from "js-yaml";
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

// ─── Load Builtin (3 preset workflows from SMDL spec) ────────────────────────

const BUILTIN_SMDLS: SMDLWorkflow[] = [
	{
		id: "rfc-5",
		name: "Standard RFC",
		description: "5-stage RFC pipeline for product development",
		version: "1.0.0",
		default_maturity_gate: 2,
		roles: [
			{ name: "any", description: "Any agent", clearance: 1, is_default: true },
			{ name: "PM", description: "Product Manager", clearance: 3 },
			{
				name: "Architect",
				description: "Technical design authority",
				clearance: 4,
			},
			{ name: "Skeptic", description: "QA & adversarial review", clearance: 2 },
		],
		stages: [
			{ name: "DRAFT", order: 1, description: "AI research and enhancement" },
			{
				name: "REVIEW",
				order: 2,
				description: "Formal review, define acceptance criteria",
				requires_ac: true,
			},
			{
				name: "DEVELOP",
				order: 3,
				description: "Design, build, test",
				requires_ac: true,
			},
			{
				name: "MERGE",
				order: 4,
				description: "Code review, regression, E2E testing",
				requires_ac: true,
			},
			{
				name: "COMPLETE",
				order: 5,
				description: "Released and dependencies resolved",
			},
			{
				name: "REJECTED",
				order: 97,
				description: "Declined after review or development",
			},
			{ name: "DISCARDED", order: 98, description: "Deprecated or abandoned" },
		],
		transitions: [
			{
				from: "DRAFT",
				to: "REVIEW",
				labels: ["mature", "submit"],
				allowed_roles: ["any"],
			},
			{
				from: "REVIEW",
				to: "DEVELOP",
				labels: ["mature", "decision"],
				allowed_roles: ["PM", "Architect"],
				requires_ac: true,
			},
			{
				from: "DEVELOP",
				to: "MERGE",
				labels: ["mature", "decision"],
				allowed_roles: ["PM", "Architect"],
				requires_ac: true,
			},
			{
				from: "MERGE",
				to: "COMPLETE",
				labels: ["mature", "decision"],
				allowed_roles: ["PM", "Architect"],
				requires_ac: true,
			},
			{
				from: "REVIEW",
				to: "REJECTED",
				labels: ["reject", "decision"],
				allowed_roles: ["PM", "Architect"],
			},
			{
				from: "DEVELOP",
				to: "REJECTED",
				labels: ["reject", "decision"],
				allowed_roles: ["PM", "Architect"],
			},
			{
				from: "MERGE",
				to: "REJECTED",
				labels: ["reject", "decision"],
				allowed_roles: ["PM", "Architect"],
			},
			{
				from: "DRAFT",
				to: "DISCARDED",
				labels: ["discard"],
				allowed_roles: ["any"],
			},
			{
				from: "REVIEW",
				to: "DISCARDED",
				labels: ["discard"],
				allowed_roles: ["PM"],
			},
			{
				from: "REVIEW",
				to: "DRAFT",
				labels: ["iterate", "revision"],
				allowed_roles: ["PM", "Architect"],
			},
			{
				from: "DEVELOP",
				to: "REVIEW",
				labels: ["iterate", "revision"],
				allowed_roles: ["Architect"],
			},
			{
				from: "MERGE",
				to: "DEVELOP",
				labels: ["iterate", "revision"],
				allowed_roles: ["Architect"],
			},
		],
	},
	{
		id: "quick-fix",
		name: "Quick Fix",
		description: "3-stage rapid fix pipeline for bugs and hotfixes",
		version: "1.0.0",
		default_maturity_gate: 1,
		roles: [
			{
				name: "any",
				description: "Any developer",
				clearance: 1,
				is_default: true,
			},
			{ name: "Lead", description: "Team lead approval", clearance: 3 },
		],
		stages: [
			{
				name: "TRIAGE",
				order: 1,
				description: "Assess and prioritize the fix",
			},
			{ name: "FIX", order: 2, description: "Implement and test the fix" },
			{ name: "DEPLOYED", order: 3, description: "Fix deployed and verified" },
			{
				name: "ESCALATE",
				order: 90,
				description: "Escalated — needs human attention",
			},
			{
				name: "WONT_FIX",
				order: 97,
				description: "Declined as not worth fixing",
			},
		],
		transitions: [
			{
				from: "TRIAGE",
				to: "FIX",
				labels: ["mature", "accepted"],
				allowed_roles: ["any"],
			},
			{
				from: "TRIAGE",
				to: "WONT_FIX",
				labels: ["reject", "discard"],
				allowed_roles: ["Lead"],
			},
			{
				from: "FIX",
				to: "DEPLOYED",
				labels: ["mature", "deploy"],
				allowed_roles: ["any"],
				requires_ac: true,
			},
			{
				from: "FIX",
				to: "TRIAGE",
				labels: ["iterate", "revision"],
				allowed_roles: ["Lead"],
			},
			{
				from: "FIX",
				to: "ESCALATE",
				labels: ["timeout", "escalate"],
				allowed_roles: ["any"],
			},
		],
	},
	{
		id: "code-review",
		name: "Code Review Pipeline",
		description: "4-stage code review with mandatory quorum",
		version: "1.0.0",
		default_maturity_gate: 2,
		roles: [
			{ name: "Author", description: "PR author", clearance: 1 },
			{ name: "Reviewer", description: "Assigned reviewer", clearance: 2 },
			{
				name: "Maintainer",
				description: "Repo maintainer with merge authority",
				clearance: 4,
			},
		],
		stages: [
			{
				name: "OPEN",
				order: 1,
				description: "PR opened, awaiting review assignment",
			},
			{ name: "REVIEWING", order: 2, description: "Under active review" },
			{ name: "APPROVED", order: 3, description: "Approved, awaiting merge" },
			{ name: "MERGED", order: 4, description: "Merged to main branch" },
			{ name: "CLOSED", order: 97, description: "Closed without merging" },
		],
		transitions: [
			{
				from: "OPEN",
				to: "REVIEWING",
				labels: ["mature", "assigned"],
				allowed_roles: ["Maintainer"],
			},
			{
				from: "REVIEWING",
				to: "APPROVED",
				labels: ["approve", "quorum_met"],
				allowed_roles: ["Reviewer"],
				gating: {
					type: "quorum",
					quorum_count: 2,
					min_approvals: 2,
					required_verdict: "approve",
				},
			},
			{
				from: "REVIEWING",
				to: "OPEN",
				labels: ["changes_requested", "iterate"],
				allowed_roles: ["Reviewer"],
			},
			{
				from: "REVIEWING",
				to: "CLOSED",
				labels: ["close", "discard"],
				allowed_roles: ["Author", "Maintainer"],
			},
			{
				from: "APPROVED",
				to: "MERGED",
				labels: ["merge", "mature"],
				allowed_roles: ["Maintainer"],
			},
			{
				from: "APPROVED",
				to: "CLOSED",
				labels: ["close", "stale"],
				allowed_roles: ["Maintainer"],
			},
		],
	},
];

async function loadBuiltinWorkflows(): Promise<CallToolResult> {
	try {
		const results: string[] = [];
		for (const wf of BUILTIN_SMDLS) {
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
					JSON.stringify({ workflow: wf }),
					wf.version,
					wf.stages.length,
				],
			);
			const templateId = tplRows[0].id;

			// 2. Materialize stages
			let stagesCount = 0;
			for (const stage of wf.stages) {
				await query(
					`INSERT INTO workflow_stages (template_id, stage_name, stage_order, maturity_gate, requires_ac)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (template_id, stage_name) DO UPDATE SET
             stage_order = EXCLUDED.stage_order,
             maturity_gate = EXCLUDED.maturity_gate,
             requires_ac = EXCLUDED.requires_ac`,
					[
						templateId,
						stage.name,
						stage.order,
						stage.maturity_gate ?? wf.default_maturity_gate ?? 2,
						stage.requires_ac ?? false,
					],
				);
				stagesCount++;
			}

			// 3. Materialize transitions
			let tCount = 0;
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
				tCount++;
			}

			// 4. Materialize roles
			let rCount = 0;
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
				rCount++;
			}

			results.push(
				`- **${wf.name}** (\`${wf.id}\`) — ${stagesCount} stages, ${tCount} transitions, ${rCount} roles`,
			);
		}

		return {
			content: [
				{
					type: "text",
					text: `✅ Loaded ${BUILTIN_SMDLS.length} builtin SMDL workflows:\n\n${results.join("\n")}\n\nNo code changes needed — define new workflows via YAML.`,
				},
			],
		};
	} catch (err) {
		return errorResult("Failed to load builtin workflows", err);
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
			handler: (args: any) => workflowLoad(args),
		});

		this.server.addTool({
			name: "workflow_load_builtin",
			description:
				"Load 3 preset SMDL workflows (RFC-5, Quick-Fix, Code-Review) into Postgres",
			inputSchema: { type: "object", properties: {} },
			handler: () => loadBuiltinWorkflows(),
		});

		this.server.addTool({
			name: "workflow_list",
			description:
				"List all registered workflow templates with stages, transitions, and roles",
			inputSchema: { type: "object", properties: {} },
			handler: () => listWorkflows(),
		});

		// eslint-disable-next-line no-console
		console.log(
			"[MCP] Registered 3 SMDL workflow tools (load YAML, load builtins, list)",
		);
	}
}
