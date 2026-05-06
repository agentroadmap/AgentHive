/**
 * P749 (A2): Unit tests for resolve_workflow_context.
 *
 * Uses an injectable queryFn — no DB required. Test data mirrors what the
 * actual SQL would return for canonical RFC and Hotfix paths so we exercise
 * AC-4: RFC DRAFT→REVIEW, REVIEW→DEVELOP, DEVELOP→MERGE, MERGE→COMPLETE
 * and Hotfix DRAFT→DEVELOP, DEVELOP→COMPLETE.
 */

import { describe, expect, test } from "bun:test";
import {
	resolve_workflow_context,
	type WorkflowContext,
} from "./workflow-resolver.ts";

type Row = Record<string, unknown>;

// Build the row shape the SQL produces. Mirrors the SELECT projection in
// SQL_RESOLVE: template_id, current_stage, next_from_stage, next_to_stage,
// gate_label, requires_ac.
function row(args: {
	template_id: number | null;
	current_stage: string;
	next_from_stage?: string | null;
	next_to_stage?: string | null;
	gate_label?: string | null;
	requires_ac?: boolean;
}): Row {
	return {
		template_id: args.template_id,
		current_stage: args.current_stage,
		next_from_stage: args.next_from_stage ?? null,
		next_to_stage: args.next_to_stage ?? null,
		gate_label: args.gate_label ?? null,
		requires_ac: args.requires_ac ?? false,
	};
}

function mockQuery(rows: Row[]) {
	return async () => ({ rows });
}

describe("resolve_workflow_context", () => {
	test("RFC: DRAFT → REVIEW (gate=submit, requires_ac=false)", async () => {
		const ctx = await resolve_workflow_context(
			1,
			mockQuery([
				row({
					template_id: 14,
					current_stage: "DRAFT",
					next_from_stage: "DRAFT",
					next_to_stage: "REVIEW",
					gate_label: "submit",
					requires_ac: false,
				}),
			]),
		);
		expect(ctx).toEqual<WorkflowContext>({
			template_id: 14,
			current_stage: "DRAFT",
			next_transition: { from_stage: "DRAFT", to_stage: "REVIEW" },
			gate_label: "submit",
			requires_ac: false,
		});
	});

	test("RFC: REVIEW → DEVELOP (gate=decision, requires_ac=true)", async () => {
		const ctx = await resolve_workflow_context(
			2,
			mockQuery([
				row({
					template_id: 14,
					current_stage: "REVIEW",
					next_from_stage: "REVIEW",
					next_to_stage: "DEVELOP",
					gate_label: "decision",
					requires_ac: true,
				}),
			]),
		);
		expect(ctx?.next_transition).toEqual({
			from_stage: "REVIEW",
			to_stage: "DEVELOP",
		});
		expect(ctx?.gate_label).toBe("decision");
		expect(ctx?.requires_ac).toBe(true);
	});

	test("RFC: DEVELOP → MERGE (gate=decision, requires_ac=true)", async () => {
		const ctx = await resolve_workflow_context(
			3,
			mockQuery([
				row({
					template_id: 14,
					current_stage: "DEVELOP",
					next_from_stage: "DEVELOP",
					next_to_stage: "MERGE",
					gate_label: "decision",
					requires_ac: true,
				}),
			]),
		);
		expect(ctx?.next_transition?.to_stage).toBe("MERGE");
		expect(ctx?.requires_ac).toBe(true);
	});

	test("RFC: MERGE → COMPLETE (gate=decision, requires_ac=true)", async () => {
		const ctx = await resolve_workflow_context(
			4,
			mockQuery([
				row({
					template_id: 14,
					current_stage: "MERGE",
					next_from_stage: "MERGE",
					next_to_stage: "COMPLETE",
					gate_label: "decision",
					requires_ac: true,
				}),
			]),
		);
		expect(ctx?.next_transition?.to_stage).toBe("COMPLETE");
	});

	test("Hotfix: DRAFT → DEVELOP (gate=accepted, requires_ac=false)", async () => {
		const ctx = await resolve_workflow_context(
			5,
			mockQuery([
				row({
					template_id: 37,
					current_stage: "DRAFT",
					next_from_stage: "DRAFT",
					next_to_stage: "DEVELOP",
					gate_label: "accepted",
					requires_ac: false,
				}),
			]),
		);
		expect(ctx?.template_id).toBe(37);
		expect(ctx?.next_transition?.to_stage).toBe("DEVELOP");
		expect(ctx?.gate_label).toBe("accepted");
		expect(ctx?.requires_ac).toBe(false);
	});

	test("Hotfix: DEVELOP → COMPLETE (gate=deploy, requires_ac=true)", async () => {
		const ctx = await resolve_workflow_context(
			6,
			mockQuery([
				row({
					template_id: 37,
					current_stage: "DEVELOP",
					next_from_stage: "DEVELOP",
					next_to_stage: "COMPLETE",
					gate_label: "deploy",
					requires_ac: true,
				}),
			]),
		);
		expect(ctx?.gate_label).toBe("deploy");
		expect(ctx?.requires_ac).toBe(true);
	});

	test("terminal stage: returns context with next_transition=null (not whole-function null)", async () => {
		// COMPLETE has no outgoing 'mature' transition — SQL returns the row
		// from the LEFT JOIN with nxt fields all null.
		const ctx = await resolve_workflow_context(
			7,
			mockQuery([
				row({
					template_id: 14,
					current_stage: "COMPLETE",
					next_from_stage: null,
					next_to_stage: null,
					gate_label: null,
					requires_ac: false,
				}),
			]),
		);
		expect(ctx).not.toBeNull();
		expect(ctx?.template_id).toBe(14);
		expect(ctx?.current_stage).toBe("COMPLETE");
		expect(ctx?.next_transition).toBeNull();
		expect(ctx?.gate_label).toBeNull();
		expect(ctx?.requires_ac).toBe(false);
	});

	test("missing proposal: returns null", async () => {
		const ctx = await resolve_workflow_context(999_999, mockQuery([]));
		expect(ctx).toBeNull();
	});

	test("proposal exists but workflow_name does not match any template: returns null", async () => {
		// SQL produces a row with template_id=null when LEFT JOIN finds no match.
		const ctx = await resolve_workflow_context(
			8,
			mockQuery([
				row({
					template_id: null,
					current_stage: "DRAFT",
				}),
			]),
		);
		expect(ctx).toBeNull();
	});
});
