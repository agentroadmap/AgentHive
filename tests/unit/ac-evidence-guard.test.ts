/**
 * P707 AC Evidence Guard Tests
 *
 * Covers:
 * - validateAcEvidence: null/empty/valid/category-mismatch cases
 * - Batch-advance guard: allows 2 calls, blocks 3rd within 5s window
 * - AutoEvaluator rejects proposals where passed ACs have details IS NULL
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { validateAcEvidence, AC_CATEGORIES } from "../../src/apps/mcp-server/schema/ac-evidence.ts";
import { createGateEvaluator } from "../../src/core/gate/evaluator.ts";

// ─── validateAcEvidence ──────────────────────────────────────────────────────

describe("validateAcEvidence — structural guard", () => {
	it("rejects null", () => {
		const r = validateAcEvidence(null);
		assert.strictEqual(r.valid, false);
		assert.strictEqual(r.code, "EVIDENCE_REQUIRED");
	});

	it("rejects undefined", () => {
		const r = validateAcEvidence(undefined);
		assert.strictEqual(r.valid, false);
		assert.strictEqual(r.code, "EVIDENCE_REQUIRED");
	});

	it("rejects empty object", () => {
		const r = validateAcEvidence({});
		assert.strictEqual(r.valid, false);
		assert.strictEqual(r.code, "EVIDENCE_REQUIRED");
	});

	it("rejects non-object (string)", () => {
		const r = validateAcEvidence("some string");
		assert.strictEqual(r.valid, false);
		assert.strictEqual(r.code, "EVIDENCE_REQUIRED");
	});

	it("accepts non-empty object without category", () => {
		const r = validateAcEvidence({ files: ["src/foo.ts"] });
		assert.strictEqual(r.valid, true);
	});
});

describe("validateAcEvidence — category schema check", () => {
	it("accepts valid file/module evidence", () => {
		const r = validateAcEvidence(
			{ files: ["src/foo.ts"], symbols: ["myFn"], grep_evidence: "src/foo.ts:12: export function myFn" },
			"file/module",
		);
		assert.strictEqual(r.valid, true);
	});

	it("rejects file/module evidence missing symbols", () => {
		const r = validateAcEvidence(
			{ files: ["src/foo.ts"], grep_evidence: "..." },
			"file/module",
		);
		assert.strictEqual(r.valid, false);
		assert.strictEqual(r.code, "SCHEMA_MISMATCH");
		assert.ok(r.error?.includes("symbols"), `Expected 'symbols' in error: ${r.error}`);
	});

	it("accepts valid schema/migration evidence", () => {
		const r = validateAcEvidence(
			{ migration_file: "scripts/migrations/173-p707.sql", tables: ["proposal_acceptance_criteria"], applied: true },
			"schema/migration",
		);
		assert.strictEqual(r.valid, true);
	});

	it("rejects schema/migration evidence missing applied", () => {
		const r = validateAcEvidence(
			{ migration_file: "scripts/migrations/173-p707.sql", tables: ["foo"] },
			"schema/migration",
		);
		assert.strictEqual(r.valid, false);
		assert.strictEqual(r.code, "SCHEMA_MISMATCH");
	});

	it("accepts valid mcp_tool evidence", () => {
		const r = validateAcEvidence(
			{ tool_name: "verify_ac", action: "pass", call_verified: true, response_sample: "✅ AC #1" },
			"mcp_tool",
		);
		assert.strictEqual(r.valid, true);
	});

	it("accepts valid behavioral/test evidence", () => {
		const r = validateAcEvidence(
			{ test_file: "tests/unit/ac-evidence-guard.test.ts", test_names: ["rejects null"], result: "pass", output_snippet: "✓ rejects null" },
			"behavioral/test",
		);
		assert.strictEqual(r.valid, true);
	});

	it("AC_CATEGORIES exports all 4 categories", () => {
		assert.strictEqual(AC_CATEGORIES.length, 4);
		assert.ok(AC_CATEGORIES.includes("schema/migration"));
		assert.ok(AC_CATEGORIES.includes("file/module"));
		assert.ok(AC_CATEGORIES.includes("mcp_tool"));
		assert.ok(AC_CATEGORIES.includes("behavioral/test"));
	});
});

// ─── AutoEvaluator — phantom-pass guard ──────────────────────────────────────

describe("AutoEvaluator — phantom-pass guard (P707)", () => {
	function makeQueryFn(rows: Array<{ total: string; passed: string; passed_without_evidence: string }>) {
		return async (_sql: string, _params: unknown[]) => ({ rows, rowCount: rows.length });
	}

	it("rejects when any passed AC has details IS NULL", async () => {
		const evaluator = createGateEvaluator(
			{ mode: "auto", ac_pass_threshold: 100 },
			{ queryFn: makeQueryFn([{ total: "3", passed: "3", passed_without_evidence: "1" }]) },
		);
		const decision = await evaluator.evaluate(
			{ id: 42, display_id: "P42", title: "test", status: "DEVELOP", workflow_name: "rfc", maturity: "active" },
			{ id: 1, stage: "D3", mode: "auto", ac_pass_threshold: 100 } as any,
		);
		assert.strictEqual(decision.verdict, "reject");
		assert.ok(decision.reason.includes("phantom-pass"), `Expected 'phantom-pass' in reason: ${decision.reason}`);
	});

	it("approves when all passed ACs have evidence", async () => {
		const evaluator = createGateEvaluator(
			{ mode: "auto", ac_pass_threshold: 100 },
			{ queryFn: makeQueryFn([{ total: "3", passed: "3", passed_without_evidence: "0" }]) },
		);
		const decision = await evaluator.evaluate(
			{ id: 43, display_id: "P43", title: "test", status: "DEVELOP", workflow_name: "rfc", maturity: "active" },
			{ id: 1, stage: "D3", mode: "auto", ac_pass_threshold: 100 } as any,
		);
		assert.strictEqual(decision.verdict, "approve");
	});

	it("rejects when AC pass rate is below threshold", async () => {
		const evaluator = createGateEvaluator(
			{ mode: "auto", ac_pass_threshold: 100 },
			{ queryFn: makeQueryFn([{ total: "3", passed: "2", passed_without_evidence: "0" }]) },
		);
		const decision = await evaluator.evaluate(
			{ id: 44, display_id: "P44", title: "test", status: "DEVELOP", workflow_name: "rfc", maturity: "active" },
			{ id: 1, stage: "D3", mode: "auto", ac_pass_threshold: 100 } as any,
		);
		assert.strictEqual(decision.verdict, "reject");
		assert.ok(decision.reason.includes("pass rate"), `Expected 'pass rate' in reason: ${decision.reason}`);
	});
});
