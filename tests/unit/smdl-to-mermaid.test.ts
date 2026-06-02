import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SMDLRoot } from "../../src/core/workflow/smdl-loader.ts";
import { smdlToMermaid } from "../../src/core/workflow/smdl-to-mermaid.ts";

const sampleWorkflow: SMDLRoot = {
	workflow: {
		id: "rfc-5",
		name: "Standard RFC",
		version: "1.0.0",
		start_stage: "DRAFT",
		terminal_stages: ["COMPLETE"],
		roles: [{ name: "developer" }, { name: "reviewer" }],
		stages: [
			{ name: "DRAFT", order: 1, description: "Shape the proposal" },
			{
				name: "REVIEW",
				order: 2,
				requires_ac: true,
				quorum: {
					required_count: 2,
					required_roles: ["architect", "pm"],
					veto_power: true,
				},
				decision_gate: {
					evaluator: "ai",
					trigger: "on_request",
					priority: "score",
				},
				timeout: "24h",
			},
			{
				name: "DEVELOP",
				order: 3,
				maturity_gate: 2,
				weighted_scoring: {
					mode: "weighted",
					passing_score: 0.8,
					criteria: [
						{ key: "tests", weight: 0.5 },
						{ key: "docs", weight: 0.3 },
					],
				},
				coordination: {
					mode: "parallel",
					dispatch: [
						{ role: "developer", count: 2, mode: "parallel" },
						{ role: "reviewer", count: 1, join: "all" },
					],
				},
			},
			{ name: "COMPLETE", order: 4 },
		],
		transitions: [
			{
				from: "DRAFT",
				to: "REVIEW",
				labels: ["mature"],
				allowed_roles: ["reviewer"],
			},
			{
				from: "REVIEW",
				to: "DEVELOP",
				labels: ["advance"],
				allowed_roles: ["architect"],
				requires_ac: true,
				gating: { type: "quorum" },
			},
		],
	},
};

describe("smdlToMermaid", () => {
	it("renders SMDL as Mermaid stateDiagram-v2", () => {
		const out = smdlToMermaid(sampleWorkflow);

		assert.match(out, /^stateDiagram-v2/m);
		assert.match(out, /title Standard RFC/);
		assert.match(out, /\[\*\] --> DRAFT/);
		assert.match(out, /click REVIEW href "#stage-review"/);
		assert.match(out, /DRAFT --> REVIEW: mature \| roles: reviewer/);
		assert.match(
			out,
			/REVIEW --> DEVELOP: advance \| roles: architect \| requires AC \| gate: quorum/,
		);
		assert.match(
			out,
			/note right of REVIEW: requires AC \| quorum 2 \| roles architect, pm \| veto enabled \| timeout 24h \| gate ai \| trigger on_request \| priority score/,
		);
		assert.match(out, /class REVIEW requiresAc,quorum,decisionGate;/);
		assert.match(out, /class DEVELOP weighted,coordination;/);
		assert.match(out, /COMPLETE --> \[\*\]/);
		assert.match(out, /class COMPLETE terminal;/);
	});

	it("accepts YAML input", () => {
		const out = smdlToMermaid(`
workflow:
  id: code-review
  name: Code Review
  roles:
    - name: reviewer
  stages:
    - name: OPEN
      order: 1
    - name: CLOSED
      order: 2
  transitions:
    - from: OPEN
      to: CLOSED
      labels: [approve]
      allowed_roles: [reviewer]
`);

		assert.match(out, /state "OPEN" as OPEN/);
		assert.match(out, /OPEN --> CLOSED: approve \| roles: reviewer/);
	});

	it("sanitizes state ids while preserving labels", () => {
		const out = smdlToMermaid(`
workflow:
  id: incident
  name: Incident Response
  roles:
    - name: sre
  stages:
    - name: 1. Triage
      order: 1
    - name: Fix/Verify
      order: 2
  transitions:
    - from: 1. Triage
      to: Fix/Verify
      labels: [mitigate]
      allowed_roles: [sre]
`);

		assert.match(out, /state "1. Triage" as _1__Triage/);
		assert.match(out, /state "Fix\/Verify" as Fix_Verify/);
		assert.match(out, /_1__Triage --> Fix_Verify/);
	});
});
