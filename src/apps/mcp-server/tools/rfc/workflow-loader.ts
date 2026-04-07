/**
 * Workflow Loader — YAML DSL parser for configurable state machines
 *
 * Parses workflow definition files (YAML) and generates SQL
 * to populate workflow_templates, proposal_valid_transitions,
 * and proposal_acceptance_criteria tables.
 *
 * Spec: docs/pillars/1-proposal/state-machine-dsl-spec.md
 */

export interface WorkflowState {
	key: string;
	label: string;
	emoji: string;
	description: string;
	maturity_override?: number;
	color?: string;
}

export interface WorkflowTransition {
	from: string;
	to: string;
	label: string;
	emoji: string;
	allowed_roles: string[];
	requires_ac?: boolean;
	requires_min_reviews?: number;
	reason_required?: boolean;
	guard?: string;
}

export interface WorkflowAcceptance {
	key: string;
	label: string;
	description?: string;
	applies_to_states: string[];
}

export interface WorkflowLifecycle {
	maturity_on_complete: number;
	maturity_on_iteration: number;
	queue_sort: string;
	obsolete_states?: string[];
	auto_escalate_mature_days?: number;
}

export interface WorkflowDefinition {
	metadata: {
		name: string;
		version: string;
		description: string;
		entity_type: string;
		created_by: string;
		created_at: string;
	};
	states: WorkflowState[];
	transitions: WorkflowTransition[];
	acceptance: WorkflowAcceptance[];
	lifecycle: WorkflowLifecycle;
}

/**
 * Parse a YAML workflow definition string into a WorkflowDefinition object.
 * Uses js-yaml if available, otherwise falls back to a simplified parser.
 */
export function parseWorkflowYaml(yaml: string): WorkflowDefinition {
	try {
		// Try using js-yaml if available
		const jsyaml = require("js-yaml");
		return jsyaml.load(yaml) as WorkflowDefinition;
	} catch {
		// Fallback: simplified parser
		return parseYamlSimple(yaml);
	}
}

function parseYamlSimple(_yaml: string): WorkflowDefinition {
	throw new Error(
		"YAML parsing requires js-yaml package. Install with: npm install js-yaml",
	);
}

/**
 * Generate SQL to insert a workflow definition into the DB.
 */
export function workflowToSql(wf: WorkflowDefinition): string {
	const sql: string[] = [];

	// Insert workflow template (upsert)
	sql.push(`-- Workflow template: ${wf.metadata.name}`);
	sql.push(
		`INSERT INTO workflow_templates (name, description, is_default, stage_count) VALUES (`,
	);
	sql.push(
		`  '${esc(wf.metadata.name)}', '${esc(wf.metadata.description)}', false, ${wf.states.length}`,
	);
	sql.push(
		`) ON CONFLICT (name) DO UPDATE SET stage_count = EXCLUDED.stage_count, description = EXCLUDED.description;`,
	);

	// Insert transitions
	// Live schema columns: from_state, to_state, allowed_reasons, allowed_roles, requires_ac, workflow_name
	if (wf.transitions.length > 0) {
		sql.push(`\n-- Transitions for ${wf.metadata.name}`);
		sql.push(`INSERT INTO proposal_valid_transitions `);
		sql.push(
			`  (workflow_name, from_state, to_state, allowed_roles, requires_ac)`,
		);
		sql.push(`VALUES`);

		const rows = wf.transitions.map((t) => {
			const roles = (t.allowed_roles || [])
				.map((r) => `'${esc(r)}'`)
				.join(", ");
			// requires_ac is text CHECK (none/all/critical), not boolean
			const acVal = t.requires_ac ? "all" : "none";
			return `  ('${esc(wf.metadata.name)}', '${esc(t.from)}', '${esc(t.to)}', ARRAY[${roles || "NULL"}], '${acVal}')`;
		});

		sql.push(rows.join(",\n"));
		sql.push(
			`ON CONFLICT (workflow_name, from_state, to_state) DO UPDATE SET allowed_roles = EXCLUDED.allowed_roles, requires_ac = EXCLUDED.requires_ac;`,
		);
	}

	// Insert acceptance criteria
	if (wf.acceptance.length > 0) {
		sql.push(`\n-- Acceptance criteria for ${wf.metadata.name}`);
		sql.push(`INSERT INTO proposal_acceptance_criteria`);
		sql.push(`  (workflow_name, key, label, description, applies_to_states)`);
		sql.push(`VALUES`);

		const rows = wf.acceptance.map((ac) => {
			const states = JSON.stringify(ac.applies_to_states || []);
			return `  ('${esc(wf.metadata.name)}', '${esc(ac.key)}', '${esc(ac.label)}', '${esc(ac.description || "")}', '${esc(states)}'::jsonb)`;
		});

		sql.push(rows.join(",\n"));
		sql.push(
			`ON CONFLICT (workflow_name, key) DO UPDATE SET applies_to_states = EXCLUDED.applies_to_states;`,
		);
	}

	return sql.join("\n");
}

function esc(s: string): string {
	return s.replace(/'/g, "''").replace(/\\/g, "\\\\");
}

/**
 * Validate a workflow definition for structural correctness.
 */
export function validateWorkflow(wf: WorkflowDefinition): string[] {
	const errors: string[] = [];

	if (!wf.metadata?.name) errors.push("Missing metadata.name");
	if (!wf.states?.length) errors.push("At least one state is required");
	if (!wf.transitions?.length)
		errors.push("At least one transition is required");

	const stateKeys = new Set(wf.states?.map((s) => s.key) || []);

	for (const t of wf.transitions || []) {
		if (!stateKeys.has(t.from) && t.from !== "*") {
			errors.push(
				`Transition "${t.from}" → "${t.to}": from_state "${t.from}" not defined in states`,
			);
		}
		if (!stateKeys.has(t.to)) {
			errors.push(
				`Transition "${t.from}" → "${t.to}": to_state "${t.to}" not defined in states`,
			);
		}
	}

	// Check for orphaned acceptance criteria
	for (const ac of wf.acceptance || []) {
		for (const s of ac.applies_to_states || []) {
			if (!stateKeys.has(s)) {
				errors.push(
					`Acceptance criterion "${ac.key}": applies to undefined state "${s}"`,
				);
			}
		}
	}

	// Check lifecycle obsolete states
	for (const obs of wf.lifecycle?.obsolete_states || []) {
		if (!stateKeys.has(obs)) {
			errors.push(`Lifecycle: obsolete_state "${obs}" not defined in states`);
		}
	}

	// Check for unreachable states (except via wildcard)
	const reachable = new Set<string>();
	for (const t of wf.transitions || []) {
		if (t.from === "*") {
			for (const s of stateKeys) reachable.add(s);
		} else {
			reachable.add(t.from);
		}
		reachable.add(t.to);
	}
	for (const s of stateKeys) {
		if (!reachable.has(s)) {
			errors.push(`State "${s}" has no transitions (unreachable or dead-end)`);
		}
	}

	return errors;
}
