/**
 * State Machine Definition Language (SMDL) — YAML DSL parser for configurable workflows.
 *
 * Parses YAML workflow definitions and materializes them into the
 * `agenthive` Postgres database (workflow_templates, workflow_stages,
 * workflow_transitions, workflow_roles).
 *
 * Spec: docs/pillars/1-proposal/state-machine-definition-language.md
 *
 * @module workflow/smdl-loader
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { query } from "../../infra/postgres/pool.ts";
import type { CallToolResult } from "../../mcp/types.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SMDLRole {
	name: string;
	description?: string;
	clearance?: number;
	is_default?: boolean;
}

export interface SMDLGateConfig {
	[stageName: string]: {
		evaluator?: "auto" | "ai" | "user";
		escalate_to_user?: SMDLEscalateToUser;
	};
}

export interface SMDLProposalDependency {
	description?: string; // natural language (always kept)
	ref?: string; // hard reference e.g. 'RFC-042'
	stage?: string; // required stage of the referenced proposal
	maturity?: string; // required maturity (default: 'mature')
	type: "gates" | "informs"; // 'gates' = blocks decision gate; 'informs' = soft input
	readiness_signal?: string; // e.g. 'build_ready', 'design_ready'
	resolved?: boolean; // false = descriptive only, not yet hard-referenced
	resolved_by?: string; // agent identity that resolved it
	resolution_confidence?: number; // 0-1
}

export interface SMDLQuorum {
	required_count?: number;
	required_roles?: string[];
	veto_power?: boolean;
}

export interface SMDLAutoTransitions {
	on_mature?: string;
	on_timeout?: string;
}

export interface SMDLEscalateToUser {
	cost_usd: number; // estimated cost threshold in USD
	impact_score: number; // impact score threshold (1-100)
	operator: "AND" | "OR"; // AND = both must be true; OR = either triggers
}

export interface SMDLDecisionGate {
	evaluator: "auto" | "ai" | "user";
	trigger?: "on_request" | "on_threshold" | "on_schedule"; // default: 'on_request'
	priority?: "fifo" | "age" | "score"; // default: 'fifo'
	escalate_to_user?: SMDLEscalateToUser;
}

export interface SMDLWeightedCriterion {
	key: string;
	label?: string;
	weight: number;
	min_score?: number;
	max_score?: number;
	required?: boolean;
}

export interface SMDLWeightedScoring {
	mode: "weighted";
	passing_score: number;
	criteria: SMDLWeightedCriterion[];
}

export interface SMDLAgentDispatch {
	role: string;
	count?: number;
	capabilities?: string[];
	mode?: "parallel" | "sequential" | "quorum";
	join?: "all" | "any" | "weighted";
}

export interface SMDLCoordination {
	mode?: "single" | "parallel" | "squad";
	dispatch?: SMDLAgentDispatch[];
}

export interface SMDLStage {
	name: string;
	order: number;
	description?: string;
	maturity_gate?: number;
	requires_ac?: boolean;
	quorum?: SMDLQuorum;
	timeout?: string;
	auto_transitions?: SMDLAutoTransitions;
	decision_gate?: SMDLDecisionGate;
	weighted_scoring?: SMDLWeightedScoring;
	coordination?: SMDLCoordination;
}

export interface SMDLGating {
	type?: string;
	quorum_count?: number;
	min_approvals?: number;
	required_verdict?: string;
}

export interface SMDLTransition {
	from: string;
	to: string;
	labels: string[];
	allowed_roles: string[];
	requires_ac?: boolean;
	gating?: SMDLGating;
}

export interface SMDLWorkflow {
	id: string;
	name: string;
	description?: string;
	version?: string;
	start_stage?: string;
	terminal_stages?: string[];
	default_maturity_gate?: number;
	roles: SMDLRole[];
	stages: SMDLStage[];
	transitions: SMDLTransition[];
	autopilot?: boolean; // true = all gates default to 'auto'
	gates?: SMDLGateConfig; // per-stage overrides
	dependencies?: SMDLProposalDependency[]; // workflow-level dependency defaults
}

export interface SMDLRoot {
	workflow: SMDLWorkflow;
}

// ─── JSON Schema Config ─────────────────────────────────────────────────────

const SMDL_SCHEMA: Record<string, any> = {
	type: "object",
	required: ["workflow"],
	properties: {
		workflow: {
			type: "object",
			required: ["id", "name", "stages", "transitions", "roles"],
			properties: {
				id: { type: "string", pattern: "^[a-z0-9-]+$" },
				name: { type: "string", minLength: 1 },
				description: { type: "string" },
				version: { type: "string" },
				start_stage: { type: "string" },
				terminal_stages: { type: "array", items: { type: "string" } },
				default_maturity_gate: { type: "number", minimum: 0, maximum: 3 },
				roles: {
					type: "array",
					items: {
						type: "object",
						required: ["name"],
						properties: {
							name: { type: "string" },
							description: { type: "string" },
							clearance: { type: "number", minimum: 1, maximum: 10 },
							is_default: { type: "boolean" },
						},
					},
				},
				stages: {
					type: "array",
					items: {
						type: "object",
						required: ["name", "order"],
						properties: {
							name: { type: "string" },
							order: { type: "number", minimum: 1 },
							description: { type: "string" },
							maturity_gate: { type: "number" },
							requires_ac: { type: "boolean" },
							quorum: { type: "object" },
							timeout: { type: "string" },
							auto_transitions: { type: "object" },
							decision_gate: { type: "object" },
						},
					},
				},
				autopilot: { type: "boolean" },
				gates: { type: "object" },
				transitions: {
					type: "array",
					items: {
						type: "object",
						required: ["from", "to", "labels", "allowed_roles"],
						properties: {
							from: { type: "string" },
							to: { type: "string" },
							labels: { type: "array", items: { type: "string" } },
							allowed_roles: { type: "array", items: { type: "string" } },
							requires_ac: { type: "boolean" },
							gating: { type: "object" },
						},
					},
				},
			},
		},
	},
};

// ─── Minimal JSON Schema Validator ──────────────────────────────────────────

function validateProperty(
	path: string,
	value: any,
	schema: any,
	errors: string[],
): void {
	if (
		schema.type === "object" &&
		typeof value === "object" &&
		!Array.isArray(value)
	) {
		if (schema.required) {
			for (const key of schema.required) {
				if (!(key in value))
					errors.push(`Missing required field: ${path}.${key}`);
			}
		}
		if (schema.properties) {
			for (const [k, s] of Object.entries(schema.properties)) {
				if (k in value) validateProperty(`${path}.${k}`, value[k], s, errors);
			}
		}
	} else if (schema.type === "array" && Array.isArray(value)) {
		if (schema.items) {
			value.forEach((item: any, i: number) => {
				validateProperty(`${path}[${i}]`, item, schema.items, errors);
			});
		}
	} else if (schema.type === "string") {
		if (typeof value !== "string") errors.push(`${path} must be a string`);
		if (schema.minLength && value.length < schema.minLength)
			errors.push(`${path} too short`);
		if (schema.pattern && !new RegExp(schema.pattern).test(value))
			errors.push(`${path} doesn't match pattern ${schema.pattern}`);
	} else if (schema.type === "number") {
		if (typeof value !== "number") errors.push(`${path} must be a number`);
		if (schema.minimum !== undefined && value < schema.minimum)
			errors.push(`${path} < ${schema.minimum}`);
		if (schema.maximum !== undefined && value > schema.maximum)
			errors.push(`${path} > ${schema.maximum}`);
	} else if (schema.type === "boolean") {
		if (typeof value !== "boolean") errors.push(`${path} must be a boolean`);
	}
}

function validateSMDL(parsed: SMDLRoot): string[] {
	const errors: string[] = [];
	validateProperty("root", parsed, SMDL_SCHEMA, errors);

	// Semantic checks
	const wf = parsed.workflow;
	const stageNames = new Set(wf.stages.map((s) => s.name));

	// Verify all transitions reference valid stages
	for (const t of wf.transitions) {
		if (!stageNames.has(t.from))
			errors.push(`Transition references unknown stage: ${t.from}`);
		if (!stageNames.has(t.to))
			errors.push(`Transition references unknown stage: ${t.to}`);
	}

	// Verify start_stage exists
	if (wf.start_stage && !stageNames.has(wf.start_stage)) {
		errors.push(`start_stage "${wf.start_stage}" not found in stages`);
	}

	// Verify unique stage order
	const orders = wf.stages.map((s) => s.order);
	const dupOrder = orders.find((o, i) => orders.indexOf(o) !== i);
	if (dupOrder !== undefined) errors.push(`Duplicate stage order: ${dupOrder}`);

	// At least one role must exist
	if (!wf.roles.length) errors.push("At least one role required");

	return errors;
}

// ─── YAML Parser ────────────────────────────────────────────────────────────

export function parseSMDL(yamlString: string): SMDLRoot {
	const doc = yaml.load(yamlString);
	if (!doc || typeof doc !== "object") {
		throw new Error("Invalid YAML: parsed document is empty or not an object");
	}
	return doc as SMDLRoot;
}

export function loadSMDLFile(filePath: string): SMDLRoot {
	const resolved = resolve(filePath);
	if (!existsSync(resolved)) {
		throw new Error(`SMDL file not found: ${resolved}`);
	}
	const raw = readFileSync(resolved, "utf-8");
	return parseSMDL(raw);
}

// ─── DB Materialization ─────────────────────────────────────────────────────

/**
 * Load an SMDL definition into Postgres. Creates/updates:
 *  1. workflow_templates
 *  2. workflow_stages (materialized)
 *  3. workflow_transitions (materialized)
 *  4. workflow_roles (materialized)
 *  5. proposal_valid_transitions (compatibility: copies transitions)
 *
 * Returns template id for use in proposal.workflow_name or workflow_id FK.
 */
export async function materializeWorkflow(smdl: SMDLRoot): Promise<{
	templateId: number;
	stages: number;
	transitions: number;
	roles: number;
}> {
	const errors = validateSMDL(smdl);
	if (errors.length > 0) {
		throw new Error(`SMDL validation failed: ${errors.join("; ")}`);
	}

	const wf = smdl.workflow;
	const wfName = wf.name;

	// 1. Upsert workflow_templates
	const { rows: tplRows } = await query<{ id: number }>(
		`INSERT INTO workflow_templates (name, description, version, smdl_id, smdl_definition, is_system)
     VALUES ($1, $2, $3, $4, $5::jsonb, TRUE)
     ON CONFLICT (smdl_id) DO UPDATE SET
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       version = EXCLUDED.version,
       smdl_definition = EXCLUDED.smdl_definition,
       modified_at = NOW()
     RETURNING id`,
		[
			wfName,
			wf.description || null,
			wf.version || "1.0.0",
			wf.id,
			JSON.stringify(smdl),
		],
	);
	const templateId = tplRows[0].id;

	let stagesCount = 0;
	let transitionsCount = 0;
	let rolesCount = 0;

	// 2. Materialize workflow_stages
	for (const stage of wf.stages) {
		const gatingConfig: Record<string, any> = {
			...(stage.quorum ? { quorum: stage.quorum } : {}),
			...(stage.decision_gate ? { decision_gate: stage.decision_gate } : {}),
		};
		// Apply workflow-level gate overrides
		const workflowGateOverride = wf.gates?.[stage.name];
		if (workflowGateOverride) {
			gatingConfig.decision_gate = {
				...gatingConfig.decision_gate,
				...workflowGateOverride,
			};
		}
		const gatingConfigJson =
			Object.keys(gatingConfig).length > 0
				? JSON.stringify(gatingConfig)
				: null;

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
				gatingConfigJson,
			],
		);
		stagesCount++;
	}

	// 3. Materialize workflow_transitions + proposal_valid_transitions
	// proposal_valid_transitions is the table read by prop_transition validation
	// (case-insensitive match via LOWER()). We sync it here so that loading a
	// workflow template immediately unblocks transition calls.
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

		// Mirror into proposal_valid_transitions so transitionProposal() can
		// validate without joining workflow_transitions (which uses a different
		// column schema). requires_ac bool → 'all'|'none' text enum.
		await query(
			`INSERT INTO roadmap_proposal.proposal_valid_transitions
         (workflow_name, from_state, to_state, allowed_reasons, allowed_roles, requires_ac)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (workflow_name, from_state, to_state) DO UPDATE SET
         allowed_reasons = EXCLUDED.allowed_reasons,
         allowed_roles   = EXCLUDED.allowed_roles,
         requires_ac     = EXCLUDED.requires_ac`,
			[
				wfName,
				t.from,
				t.to,
				t.labels ?? [],
				t.allowed_roles ?? [],
				t.requires_ac ? "all" : "none",
			],
		);

		transitionsCount++;
	}

	// 4. Materialize workflow_roles
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
		templateId,
		stages: stagesCount,
		transitions: transitionsCount,
		roles: rolesCount,
	};
}

// ─── MCP Tool Handlers ──────────────────────────────────────────────────────

export async function workflowLoad(args: {
	yaml?: string;
	filepath?: string;
}): Promise<CallToolResult> {
	try {
		let smdl: SMDLRoot;
		if (args.filepath) {
			smdl = loadSMDLFile(args.filepath);
		} else if (args.yaml) {
			smdl = parseSMDL(args.yaml);
		} else {
			return {
				content: [
					{
						type: "text",
						text: "⚠️ Provide either `yaml` (string) or `filepath` parameter.",
					},
				],
			};
		}

		const errors = validateSMDL(smdl);
		if (errors.length > 0) {
			return {
				content: [
					{
						type: "text",
						text: `❌ SMDL validation failed:\n- ${errors.join("\n- ")}`,
					},
				],
			};
		}

		const r = await materializeWorkflow(smdl);
		return {
			content: [
				{
					type: "text",
					text: `✅ Loaded workflow "${smdl.workflow.name}" (${smdl.workflow.id})\nTemplate ID: ${r.templateId}\nStages: ${r.stages} | Transitions: ${r.transitions} | Roles: ${r.roles}`,
				},
			],
		};
	} catch (err) {
		return {
			content: [
				{
					type: "text",
					text: `⚠️ Failed to load workflow: ${err instanceof Error ? err.message : String(err)}`,
				},
			],
		};
	}
}

export async function workflowList(): Promise<CallToolResult> {
	try {
		const { rows } = await query<{
			id: number;
			smdl_id: string;
			name: string;
			version: string;
			is_system: boolean;
		}>(
			`SELECT id, smdl_id, name, version, is_system FROM workflow_templates ORDER BY id`,
		);
		if (!rows.length) {
			return {
				content: [
					{
						type: "text",
						text: "No workflow templates loaded. Apply deploy/project-init/seed/proposal-types.sql to seed workflows.",
					},
				],
			};
		}
		const lines = rows.map(
			(r) =>
				`- **[${r.id}]** ${r.name} (\`${r.smdl_id}\`) v${r.version}${r.is_system ? " 📦 builtin" : ""}`,
		);
		return {
			content: [
				{ type: "text", text: `### Workflow Templates\n\n${lines.join("\n")}` },
			],
		};
	} catch (err) {
		return {
			content: [
				{
					type: "text",
					text: `⚠️ Failed to list workflows: ${err instanceof Error ? err.message : String(err)}`,
				},
			],
		};
	}
}
