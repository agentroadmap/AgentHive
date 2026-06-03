import yaml from "js-yaml";
import type { SMDLRoot, SMDLTransition, SMDLWorkflow } from "./smdl-loader.ts";

export type SMDLMermaidInput = SMDLRoot | SMDLWorkflow | string;

type NormalizedWorkflow = SMDLWorkflow;

export interface SMDLVisualizationStage {
	name: string;
	anchor: string;
	tags: string[];
	details: string[];
}

export interface SMDLVisualizationTransition {
	from: string;
	to: string;
	label: string;
}

export interface SMDLVisualization {
	mermaid: string;
	stages: SMDLVisualizationStage[];
	transitions: SMDLVisualizationTransition[];
}

function normalizeWorkflow(input: SMDLMermaidInput): NormalizedWorkflow {
	const parsed =
		typeof input === "string" ? (yaml.load(input) as SMDLRoot) : input;
	const workflow = "workflow" in parsed ? parsed.workflow : parsed;
	if (!workflow?.stages?.length) {
		throw new Error("Invalid SMDL: workflow.stages is required");
	}
	if (!workflow?.transitions?.length) {
		throw new Error("Invalid SMDL: workflow.transitions is required");
	}
	return workflow;
}

function stateId(name: string): string {
	return name.replace(/[^A-Za-z0-9_]/g, "_").replace(/^([0-9])/, "_$1");
}

function quoteLabel(label: string): string {
	return label.replace(/"/g, '\\"').replace(/\s+/g, " ").trim();
}

function anchorSlug(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function transitionLabel(transition: SMDLTransition): string {
	const parts: string[] = [];
	if (transition.labels.length) {
		parts.push(transition.labels.join(", "));
	}
	if (transition.allowed_roles.length) {
		parts.push(`roles: ${transition.allowed_roles.join(", ")}`);
	}
	if (transition.requires_ac) {
		parts.push("requires AC");
	}
	if (transition.gating?.type) {
		parts.push(`gate: ${transition.gating.type}`);
	}
	return quoteLabel(parts.join(" | "));
}

function summarizeStage(stage: NormalizedWorkflow["stages"][number]): {
	tags: string[];
	details: string[];
	classes: string[];
} {
	const tags: string[] = [];
	const details: string[] = [];
	const classes: string[] = [];

	if (stage.description) {
		details.push(stage.description);
	}
	if (stage.requires_ac) {
		tags.push("ac");
		details.push("requires AC");
		classes.push("requiresAc");
	}
	if (stage.maturity_gate !== undefined) {
		details.push(`maturity gate ${stage.maturity_gate}`);
	}
	if (stage.quorum?.required_count) {
		tags.push("quorum");
		details.push(`quorum ${stage.quorum.required_count}`);
		if (stage.quorum.required_roles?.length) {
			details.push(`roles ${stage.quorum.required_roles.join(", ")}`);
		}
		if (stage.quorum.veto_power) {
			details.push("veto enabled");
		}
		classes.push("quorum");
	}
	if (stage.timeout) {
		tags.push("timeout");
		details.push(`timeout ${stage.timeout}`);
	}
	if (stage.auto_transitions?.on_mature) {
		details.push(`on mature -> ${stage.auto_transitions.on_mature}`);
	}
	if (stage.auto_transitions?.on_timeout) {
		details.push(`on timeout -> ${stage.auto_transitions.on_timeout}`);
	}
	if (stage.decision_gate?.evaluator) {
		tags.push(stage.decision_gate.evaluator);
		details.push(`gate ${stage.decision_gate.evaluator}`);
		if (stage.decision_gate.trigger) {
			details.push(`trigger ${stage.decision_gate.trigger}`);
		}
		if (stage.decision_gate.priority) {
			details.push(`priority ${stage.decision_gate.priority}`);
		}
		classes.push("decisionGate");
	}
	if (stage.weighted_scoring) {
		tags.push("weighted");
		details.push(`weighted pass ${stage.weighted_scoring.passing_score}`);
		details.push(
			`${stage.weighted_scoring.criteria.length} weighted criteria`,
		);
		classes.push("weighted");
	}
	if (stage.coordination?.dispatch?.length) {
		tags.push("coordination");
		details.push(
			`${stage.coordination.dispatch.length} dispatch role${
				stage.coordination.dispatch.length === 1 ? "" : "s"
			}`,
		);
		if (stage.coordination.mode) {
			details.push(`coordination ${stage.coordination.mode}`);
		}
		classes.push("coordination");
	}

	return { tags, details, classes };
}

export function smdlToVisualization(input: SMDLMermaidInput): SMDLVisualization {
	const workflow = normalizeWorkflow(input);
	const stages = [...workflow.stages].sort((a, b) => a.order - b.order);
	const stageIds = new Map(
		stages.map((stage) => [stage.name, stateId(stage.name)]),
	);
	const lines = [
		"stateDiagram-v2",
		`  title ${quoteLabel(workflow.name)}`,
		"  direction LR",
	];
	const stageClasses = new Map<string, Set<string>>();
	const stageSummaries: SMDLVisualizationStage[] = [];
	const transitionSummaries: SMDLVisualizationTransition[] = [];

	for (const stage of stages) {
		const id = stageIds.get(stage.name) ?? stateId(stage.name);
		const summary = summarizeStage(stage);
		stageSummaries.push({
			name: stage.name,
			anchor: `#stage-${anchorSlug(stage.name)}`,
			tags: summary.tags,
			details: summary.details,
		});
		lines.push(`  state "${quoteLabel(stage.name)}" as ${id}`);
		if (summary.details.length) {
			lines.push(
				`  note right of ${id}: ${quoteLabel(summary.details.join(" | "))}`,
			);
		}
		lines.push(
			`  click ${id} href "${stageSummaries.at(-1)?.anchor ?? "#"}" "${quoteLabel(
				summary.details.join(" | ") || stage.name,
			)}"`,
		);
		if (summary.classes.length) {
			stageClasses.set(id, new Set(summary.classes));
		}
	}

	const start = workflow.start_stage ?? stages[0]?.name;
	if (start && stageIds.has(start)) {
		lines.push(`  [*] --> ${stageIds.get(start)}`);
	}

	for (const transition of workflow.transitions) {
		const from = stageIds.get(transition.from) ?? stateId(transition.from);
		const to = stageIds.get(transition.to) ?? stateId(transition.to);
		const label = transitionLabel(transition);
		transitionSummaries.push({
			from: transition.from,
			to: transition.to,
			label,
		});
		lines.push(label ? `  ${from} --> ${to}: ${label}` : `  ${from} --> ${to}`);
	}

	for (const terminal of workflow.terminal_stages ?? []) {
		const id = stageIds.get(terminal);
		if (id) {
			lines.push(`  ${id} --> [*]`);
			const existing = stageClasses.get(id) ?? new Set<string>();
			existing.add("terminal");
			stageClasses.set(id, existing);
		}
	}

	lines.push("  classDef terminal fill:#d7f0d1,stroke:#2f6b35,stroke-width:2px;");
	lines.push("  classDef quorum fill:#fff1cc,stroke:#8a6d1f,stroke-width:2px;");
	lines.push(
		"  classDef requiresAc fill:#ffe5d9,stroke:#a3511f,stroke-dasharray: 4 2;",
	);
	lines.push(
		"  classDef decisionGate fill:#dbeafe,stroke:#1d4ed8,stroke-width:2px;",
	);
	lines.push(
		"  classDef weighted fill:#fce7f3,stroke:#be185d,stroke-width:2px;",
	);
	lines.push(
		"  classDef coordination fill:#e0f2fe,stroke:#0369a1,stroke-width:2px;",
	);

	for (const [id, classes] of stageClasses.entries()) {
		lines.push(`  class ${id} ${Array.from(classes).join(",")};`);
	}

	return {
		mermaid: `${lines.join("\n")}\n`,
		stages: stageSummaries,
		transitions: transitionSummaries,
	};
}

export function smdlToMermaid(input: SMDLMermaidInput): string {
	return smdlToVisualization(input).mermaid;
}
