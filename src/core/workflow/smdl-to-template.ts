/**
 * SMDL → template.workflow_template transformation.
 *
 * Converts a parsed SMDLRoot into the split states/gates JSONB format
 * used by template.workflow_template.
 *
 * @module workflow/smdl-to-template
 */

import type { SMDLRoot, SMDLStage, SMDLTransition } from "./smdl-loader.ts";

// ─── Output types ────────────────────────────────────────────────────────────

export interface TemplateState {
	name: string;
	order: number;
	description?: string;
	timeout?: string;
	auto_transitions?: Record<string, string>;
}

export interface TemplateGate {
	from: string;
	to: string;
	labels: string[];
	allowed_roles: string[];
	requires_ac?: boolean;
	maturity_required?: string;
}

export interface TemplatePayload {
	states: TemplateState[];
	gates: TemplateGate[];
}

// ─── Transformation ──────────────────────────────────────────────────────────

export function smdlToTemplate(root: SMDLRoot): TemplatePayload {
	const wf = root.workflow;

	const states: TemplateState[] = wf.stages.map((s: SMDLStage) => {
		const state: TemplateState = { name: s.name, order: s.order };
		if (s.description) state.description = s.description;
		if (s.timeout) state.timeout = s.timeout;
		if (s.auto_transitions) state.auto_transitions = s.auto_transitions as Record<string, string>;
		return state;
	});

	const gates: TemplateGate[] = wf.transitions.map((t: SMDLTransition) => {
		const gate: TemplateGate = {
			from: t.from,
			to: t.to,
			labels: t.labels ?? [],
			allowed_roles: t.allowed_roles ?? [],
		};
		if (t.requires_ac) gate.requires_ac = true;
		// Infer maturity_required from labels: "mature" label means mature required
		if (t.labels?.includes("mature")) {
			gate.maturity_required = "mature";
		}
		return gate;
	});

	return { states, gates };
}

/**
 * Returns the template_id string for a given SMDL workflow id and version.
 * Converts e.g. "rfc-5" + 1 → "rfc-5-stage@v1"
 *
 * The mapping uses the canonical family names registered in the DB seeds.
 * Falls back to `${id}@v${version}` for unknown ids.
 */
const FAMILY_MAP: Record<string, string> = {
	"rfc-5": "rfc-5-stage",
	"hotfix": "hotfix",
	"quick-fix": "quick-fix",
	"code-review": "code-review",
};

export function smdlIdToTemplateId(smdlId: string, version = 1): string {
	const family = FAMILY_MAP[smdlId] ?? smdlId;
	return `${family}@v${version}`;
}
