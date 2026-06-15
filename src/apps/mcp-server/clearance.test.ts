import assert from "node:assert";
import { describe, test } from "node:test";
import { defaultTrustTierForKind } from "../../core/identity/principal-verifier.ts";
import { isClearanceAllowed, TRUST_TIER_RANK } from "./types.ts";

/**
 * P1114: trust-tier clearance decision logic (AC-1 defaults + AC-3 comparison).
 */
describe("P1114 clearance decision", () => {
	test("tiers are strictly ordered authority > trusted > known > restricted > blocked > external_proxy", () => {
		const order = [
			"external_proxy",
			"blocked",
			"restricted",
			"known",
			"trusted",
			"authority",
		] as const;
		for (let i = 1; i < order.length; i++) {
			assert.ok(
				TRUST_TIER_RANK[order[i]] > TRUST_TIER_RANK[order[i - 1]],
				`${order[i]} should outrank ${order[i - 1]}`,
			);
		}
	});

	test("isClearanceAllowed: caller meets or exceeds required tier", () => {
		assert.equal(isClearanceAllowed("authority", "known"), true);
		assert.equal(isClearanceAllowed("authority", "authority"), true); // exact match
		assert.equal(isClearanceAllowed("known", "known"), true);
		assert.equal(isClearanceAllowed("restricted", "known"), false); // too low
		assert.equal(isClearanceAllowed("external_proxy", "restricted"), false);
		assert.equal(isClearanceAllowed("trusted", "known"), true);
	});

	test("defaultTrustTierForKind: operator=authority, agency=known, agent=restricted", () => {
		assert.equal(defaultTrustTierForKind("operator"), "authority");
		assert.equal(defaultTrustTierForKind("agency"), "known");
		assert.equal(defaultTrustTierForKind("agent"), "restricted");
	});

	test("a default-tier agent cannot clear an authority tool (fail-closed default)", () => {
		const agentTier = defaultTrustTierForKind("agent"); // restricted
		assert.equal(
			isClearanceAllowed(agentTier as "restricted", "authority"),
			false,
		);
	});
});
