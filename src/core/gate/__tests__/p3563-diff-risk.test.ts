import assert from "node:assert";
import { describe, test } from "node:test";
import {
	classifyChangedFiles,
	buildDiffRiskMetadata,
} from "../diff-risk.ts";

/**
 * P3565 AC-16/17 (unit): diff-risk classification + metadata builder.
 * Pure functions — no DB.
 */
describe("P3565: diff-risk classifier", () => {
	test("AC-16: migration / fn_ / auth / gate_advance / prop_claim paths are HIGH risk", () => {
		for (const f of [
			"scripts/migrations/293-x.sql",
			"src/db/fn_guard_gate_advance.sql",
			"src/apps/server/operator-auth.ts",
			"src/core/proposal/proposal-integrity.ts", // lease/prop_claim
		]) {
			const r = classifyChangedFiles([f]);
			assert.strictEqual(r.high, true, `expected HIGH for ${f}`);
			assert.ok(r.matched.includes(f));
		}
	});

	test("AC-16: ordinary paths are NOT high risk", () => {
		const r = classifyChangedFiles([
			"src/apps/tui/panels/board.ts",
			"README.md",
			"src/web/main.tsx",
		]);
		assert.strictEqual(r.high, false, "ordinary diff is low risk");
		assert.strictEqual(r.matched.length, 0);
		assert.strictEqual(r.touched.length, 3);
	});

	test("AC-17: metadata builder sets operator_authorized only from a real outcome", () => {
		const risk = classifyChangedFiles(["scripts/migrations/x.sql"]);
		const unauth = buildDiffRiskMetadata(risk, { authorized: false });
		assert.strictEqual((unauth.diff_risk as any).high, true);
		assert.strictEqual((unauth.diff_risk as any).operator_authorized, false);

		const auth = buildDiffRiskMetadata(risk, { authorized: true, tokenId: 9 });
		assert.strictEqual((auth.diff_risk as any).operator_authorized, true);
		assert.strictEqual((auth.diff_risk as any).token_id, 9);

		// null operator → not authorized (never inferred).
		const none = buildDiffRiskMetadata(risk, null);
		assert.strictEqual((none.diff_risk as any).operator_authorized, false);
	});
});
