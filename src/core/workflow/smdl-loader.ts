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

// ─── Preset Workflows (embedded SMDL) ───────────────────────────────────────

const BUILTIN_SMDLS: SMDLRoot[] = [
	// RFC-5
	{
		workflow: {
			id: "rfc-5",
			name: "Standard RFC",
			description: "5-stage RFC pipeline for product development",
			version: "1.0.0",
			start_stage: "PROPOSAL",
			terminal_stages: ["COMPLETE", "REJECTED", "DISCARDED"],
			default_maturity_gate: 2,
			roles: [
				{
					name: "any",
					description: "Any agent",
					clearance: 1,
					is_default: true,
				},
				{ name: "PM", description: "Product Manager", clearance: 3 },
				{
					name: "Architect",
					description: "Technical design authority",
					clearance: 4,
				},
				{
					name: "Skeptic",
					description: "QA & adversarial review",
					clearance: 2,
				},
			],
			stages: [
				{
					name: "PROPOSAL",
					order: 1,
					description: "Initial idea submitted",
					auto_transitions: { on_mature: "DRAFT" },
				},
				{
					name: "DRAFT",
					order: 2,
					description: "AI research and enhancement",
					auto_transitions: { on_mature: "REVIEW" },
					decision_gate: { evaluator: "auto" },
				},
				{
					name: "REVIEW",
					order: 3,
					description: "Formal review, define acceptance criteria",
					requires_ac: true,
					quorum: {
						required_count: 2,
						required_roles: ["PM", "Architect"],
						veto_power: true,
					},
					auto_transitions: { on_mature: "DEVELOP" },
					decision_gate: {
						evaluator: "auto",
						escalate_to_user: {
							cost_usd: 0.5,
							impact_score: 20,
							operator: "AND",
						},
					},
				},
				{
					name: "DEVELOP",
					order: 4,
					description: "Design, build, test",
					requires_ac: true,
					auto_transitions: { on_mature: "MERGE" },
				},
				{
					name: "MERGE",
					order: 5,
					description: "Code review, regression, E2E testing",
					requires_ac: true,
					auto_transitions: { on_mature: "COMPLETE" },
				},
				{
					name: "COMPLETE",
					order: 6,
					description: "Released and dependencies resolved",
				},
				{
					name: "REJECTED",
					order: 97,
					description: "Declined after review or development",
				},
				{
					name: "DISCARDED",
					order: 98,
					description: "Deprecated or abandoned",
				},
			],
			transitions: [
				{
					from: "PROPOSAL",
					to: "DRAFT",
					labels: ["mature", "submit", "research"],
					allowed_roles: ["any"],
				},
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
	},
	// Quick-Fix
	{
		workflow: {
			id: "quick-fix",
			name: "Quick Fix",
			description: "3-stage rapid fix pipeline for bugs and hotfixes",
			version: "1.0.0",
			start_stage: "TRIAGE",
			terminal_stages: ["DEPLOYED", "WONT_FIX"],
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
					auto_transitions: { on_mature: "FIX" },
				},
				{
					name: "FIX",
					order: 2,
					description: "Implement and test the fix",
					timeout: "4h",
					auto_transitions: { on_mature: "DEPLOYED", on_timeout: "ESCALATE" },
				},
				{
					name: "DEPLOYED",
					order: 3,
					description: "Fix deployed and verified",
				},
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
	},
	// Code-Review
	{
		workflow: {
			id: "code-review",
			name: "Code Review Pipeline",
			description: "4-stage code review with mandatory quorum",
			version: "1.0.0",
			start_stage: "OPEN",
			terminal_stages: ["MERGED", "CLOSED"],
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
					auto_transitions: { on_mature: "REVIEWING" },
				},
				{
					name: "REVIEWING",
					order: 2,
					description: "Under active review",
					quorum: {
						required_count: 2,
						required_roles: ["Reviewer"],
						veto_power: true,
					},
					auto_transitions: { on_mature: "APPROVED" },
				},
				{
					name: "APPROVED",
					order: 3,
					description: "Approved, awaiting merge",
					timeout: "48h",
				},
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
	},
];

/**
 * Load all 3 builtin workflows into Postgres.
 */
export async function loadAllBuiltins(): Promise<
	Array<{ name: string; templateId: number }>
> {
	const results: Array<{ name: string; templateId: number }> = [];
	for (const smdl of BUILTIN_SMDLS) {
		const r = await materializeWorkflow(smdl);
		results.push({ name: smdl.workflow.name, templateId: r.templateId });
	}
	return results;
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

export async function workflowLoadBuiltin(): Promise<CallToolResult> {
	try {
		const results = await loadAllBuiltins();
		const lines = results.map(
			(r) => `- **${r.name}**: template ID ${r.templateId}`,
		);
		return {
			content: [
				{
					type: "text",
					text: `✅ Loaded ${results.length} builtin workflows:\n\n${lines.join("\n")}`,
				},
			],
		};
	} catch (err) {
		return {
			content: [
				{
					type: "text",
					text: `⚠️ Failed to load builtins: ${err instanceof Error ? err.message : String(err)}`,
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
						text: "No workflow templates loaded. Run `workflow_load_builtin` to load 3 presets.",
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
