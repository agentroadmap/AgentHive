/**
 * P707 / P378 AC-6 — AC evidence guard tests.
 *
 * Covers:
 *   - validateAcEvidence null/empty rejection
 *   - validateAcEvidence schema validation per category
 *   - AutoEvaluator phantom-pass detection
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { validateAcEvidence } from "../../src/apps/mcp-server/schema/ac-evidence.ts";
import { createGateEvaluator } from "../../src/core/gate/evaluator.ts";

// ─── validateAcEvidence ──────────────────────────────────────────────────────

describe("validateAcEvidence — null / empty rejection", () => {
	it("rejects null", () => {
		assert.ok(validateAcEvidence(null) !== null);
	});

	it("rejects undefined", () => {
		assert.ok(validateAcEvidence(undefined) !== null);
	});

	it("rejects empty string", () => {
		assert.ok(validateAcEvidence("") !== null);
	});

	it("rejects whitespace-only string", () => {
		assert.ok(validateAcEvidence("   ") !== null);
	});

	it("rejects non-JSON string", () => {
		assert.ok(validateAcEvidence("the design says so") !== null);
	});

	it("rejects JSON array", () => {
		assert.ok(validateAcEvidence("[1,2,3]") !== null);
	});

	it("rejects JSON object missing category", () => {
		assert.ok(validateAcEvidence('{"migration_file": "123.sql"}') !== null);
	});

	it("rejects unknown category", () => {
		assert.ok(validateAcEvidence('{"category": "made-up"}') !== null);
	});
});

describe("validateAcEvidence — schema/migration", () => {
	const base = { category: "schema/migration", migration_file: "100-foo.sql", tables: ["foo"], applied: true };

	it("accepts valid evidence", () => {
		assert.strictEqual(validateAcEvidence(JSON.stringify(base)), null);
	});

	it("rejects missing migration_file", () => {
		const { migration_file: _, ...rest } = base;
		assert.ok(validateAcEvidence(JSON.stringify(rest)) !== null);
	});

	it("rejects non-array tables", () => {
		assert.ok(validateAcEvidence(JSON.stringify({ ...base, tables: "foo" })) !== null);
	});

	it("rejects non-boolean applied", () => {
		assert.ok(validateAcEvidence(JSON.stringify({ ...base, applied: "yes" })) !== null);
	});
});

describe("validateAcEvidence — file/module", () => {
	const base = {
		category: "file/module",
		files: ["src/foo.ts"],
		symbols: ["validateAcEvidence"],
		grep_evidence: "export function validateAcEvidence",
	};

	it("accepts valid evidence", () => {
		assert.strictEqual(validateAcEvidence(JSON.stringify(base)), null);
	});

	it("rejects empty files array", () => {
		assert.ok(validateAcEvidence(JSON.stringify({ ...base, files: [] })) !== null);
	});

	it("rejects missing grep_evidence", () => {
		const { grep_evidence: _, ...rest } = base;
		assert.ok(validateAcEvidence(JSON.stringify(rest)) !== null);
	});
});

describe("validateAcEvidence — mcp_tool", () => {
	const base = {
		category: "mcp_tool",
		tool_name: "mcp_proposal",
		action: "verify_ac",
		call_verified: true,
		response_sample: '{"status":"pass"}',
	};

	it("accepts valid evidence", () => {
		assert.strictEqual(validateAcEvidence(JSON.stringify(base)), null);
	});

	it("rejects non-boolean call_verified", () => {
		assert.ok(validateAcEvidence(JSON.stringify({ ...base, call_verified: "yes" })) !== null);
	});

	it("rejects missing response_sample", () => {
		const { response_sample: _, ...rest } = base;
		assert.ok(validateAcEvidence(JSON.stringify(rest)) !== null);
	});
});

describe("validateAcEvidence — behavioral/test", () => {
	const base = {
		category: "behavioral/test",
		test_file: "tests/unit/ac-evidence-guard.test.ts",
		test_names: ["rejects null"],
		result: "pass" as const,
		output_snippet: "✓ rejects null",
	};

	it("accepts valid evidence", () => {
		assert.strictEqual(validateAcEvidence(JSON.stringify(base)), null);
	});

	it("rejects invalid result value", () => {
		assert.ok(validateAcEvidence(JSON.stringify({ ...base, result: "ok" })) !== null);
	});

	it("rejects non-array test_names", () => {
		assert.ok(validateAcEvidence(JSON.stringify({ ...base, test_names: "rejects null" })) !== null);
	});
});

// ─── AutoEvaluator phantom-pass guard ────────────────────────────────────────

describe("AutoEvaluator — phantom-pass guard", () => {
	function makeQueryFn(options: {
		unresolvedDeps?: number;
		total?: number;
		passed?: number;
		phantomCount?: number;
	}) {
		const { unresolvedDeps = 0, total = 3, passed = 3, phantomCount = 0 } = options;
		return async <T>(sql: string, _params: unknown[]): Promise<{ rows: T[] }> => {
			if (sql.includes("proposal_dependencies")) {
				return { rows: [{ count: String(unresolvedDeps) }] as T[] };
			}
			if (sql.includes("phantom_count")) {
				return { rows: [{ phantom_count: String(phantomCount) }] as T[] };
			}
			if (sql.includes("proposal_acceptance_criteria")) {
				return { rows: [{ total: String(total), passed: String(passed) }] as T[] };
			}
			return { rows: [] as T[] };
		};
	}

	const proposal = { id: 1, display_id: "P999", title: "Test", status: "develop", workflow_name: "feature" };
	const gate = { name: "develop→merge", from_state: "develop", to_state: "merge", requires_ac: true };

	it("approves when all ACs pass with evidence", async () => {
		const evaluator = createGateEvaluator(
			{ mode: "auto", ac_pass_threshold: 100 },
			{ queryFn: makeQueryFn({ phantomCount: 0, total: 3, passed: 3 }) as any },
		);
		const decision = await evaluator.evaluate(proposal, gate);
		assert.strictEqual(decision.verdict, "approve");
	});

	it("rejects when phantom passes exist (no verification_notes)", async () => {
		const evaluator = createGateEvaluator(
			{ mode: "auto", ac_pass_threshold: 100 },
			{ queryFn: makeQueryFn({ phantomCount: 2 }) as any },
		);
		const decision = await evaluator.evaluate(proposal, gate);
		assert.strictEqual(decision.verdict, "reject");
		assert.ok(decision.reason.includes("Phantom pass"));
		assert.strictEqual((decision.metadata as any)?.phantom_count, 2);
	});

	it("rejects when AC pass rate is below threshold", async () => {
		const evaluator = createGateEvaluator(
			{ mode: "auto", ac_pass_threshold: 100 },
			{ queryFn: makeQueryFn({ phantomCount: 0, total: 3, passed: 2 }) as any },
		);
		const decision = await evaluator.evaluate(proposal, gate);
		assert.strictEqual(decision.verdict, "reject");
		assert.ok(decision.reason.includes("2/3"));
	});

	it("rejects when there are unresolved dependencies", async () => {
		const evaluator = createGateEvaluator(
			{ mode: "auto" },
			{ queryFn: makeQueryFn({ unresolvedDeps: 1 }) as any },
		);
		const decision = await evaluator.evaluate(proposal, gate);
		assert.strictEqual(decision.verdict, "reject");
		assert.ok(decision.reason.includes("unresolved"));
	});
});
