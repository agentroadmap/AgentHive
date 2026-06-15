/**
 * P1067 AC-17 — operator principal resolution + main() exit-code contracts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveOperatorPrincipal } from "../../src/apps/tui/operator-context.ts";

describe("AC-17 resolveOperatorPrincipal", () => {
	it("returns null with no context (caller exits code 1)", () => {
		assert.equal(resolveOperatorPrincipal({} as NodeJS.ProcessEnv), null);
	});
	it("resolves an operator principal from AGENTHIVE_OPERATOR_IDENTITY", () => {
		const p = resolveOperatorPrincipal({
			AGENTHIVE_OPERATOR_IDENTITY: "operator:gary",
		} as NodeJS.ProcessEnv);
		assert.equal(p?.principal_id, "operator:gary");
		assert.equal(p?.principal_kind, "operator");
		assert.equal(p?.parent_principal_id, null);
	});
	it("trims and ignores blank identity", () => {
		assert.equal(
			resolveOperatorPrincipal({
				AGENTHIVE_OPERATOR_IDENTITY: "   ",
			} as NodeJS.ProcessEnv),
			null,
		);
		assert.equal(
			resolveOperatorPrincipal({
				AGENTHIVE_OPERATOR_IDENTITY: " op:x ",
			} as NodeJS.ProcessEnv)?.principal_id,
			"op:x",
		);
	});
});
