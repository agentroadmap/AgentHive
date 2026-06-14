import assert from "node:assert";
import { describe, test } from "node:test";
import { defaultTrustTierForKind } from "../../core/identity/principal-verifier.ts";
import { collectToolDescriptors } from "./tool-registry-introspect.ts";
import { isClearanceAllowed, type ToolClearance, type TrustTier } from "./types.ts";

/**
 * P1114 AC-6: the four representative tools DECLARE clearance, with tiers that
 * respect the read < message < transition < migration ordering, and the
 * enforcement decision (deny below min_tier, allow at/above) behaves correctly
 * in both log-only and enforce modes for the highest (schema_lint_migration,
 * the apply_migration-class tool) and lowest (prop_list) cases.
 */

function clearanceOf(name: string): ToolClearance {
	const descriptors = collectToolDescriptors(process.cwd());
	const d = descriptors.find((x) => x.name === name);
	assert.ok(d, `tool '${name}' must be registered`);
	assert.ok(
		d.clearance,
		`tool '${name}' must DECLARE a clearance (P1114 AC-6)`,
	);
	return d.clearance;
}

/**
 * Mirrors the enforcement middleware decision (server.ts callTool, P1114
 * block): below min_tier => denied (logged always; blocked only when enforce);
 * at/above => allowed.
 */
function decide(
	callerTier: TrustTier,
	required: ToolClearance,
	enforce: boolean,
): { logged: boolean; blocked: boolean; allowed: boolean } {
	const allowed = isClearanceAllowed(callerTier, required.min_tier);
	if (allowed) return { logged: false, blocked: false, allowed: true };
	// Denied: always logged; blocked (returns isError) only when enforcing.
	return { logged: true, blocked: enforce, allowed: false };
}

describe("P1114 AC-6 — representative tool clearance declarations", () => {
	test("prop_list declares LOW read clearance", () => {
		const c = clearanceOf("prop_list");
		assert.equal(c.scope, "read");
		assert.equal(c.min_tier, "restricted");
	});

	test("msg_send declares MEDIUM messaging-write clearance", () => {
		const c = clearanceOf("msg_send");
		assert.equal(c.scope, "peer_write");
		assert.equal(c.min_tier, "known");
	});

	test("prop_transition declares HIGH gate-action clearance", () => {
		const c = clearanceOf("prop_transition");
		assert.equal(c.scope, "gate_action");
		assert.equal(c.min_tier, "trusted");
	});

	test("schema_lint_migration (apply_migration-class) declares HIGHEST schema-write clearance", () => {
		const c = clearanceOf("schema_lint_migration");
		assert.equal(c.scope, "schema_write");
		assert.equal(c.min_tier, "authority");
	});

	test("the four declarations respect read < message < transition < migration ordering", () => {
		const order: TrustTier[] = [
			clearanceOf("prop_list").min_tier, // read
			clearanceOf("msg_send").min_tier, // message
			clearanceOf("prop_transition").min_tier, // transition
			clearanceOf("schema_lint_migration").min_tier, // migration
		];
		for (let i = 1; i < order.length; i++) {
			assert.ok(
				isClearanceAllowed(order[i], order[i - 1]) &&
					!isClearanceAllowed(order[i - 1], order[i]),
				`tier ${order[i]} must strictly outrank ${order[i - 1]}`,
			);
		}
	});

	// ── Highest case: apply_migration-class (schema_lint_migration) ──────────
	describe("apply_migration-class (schema_lint_migration) — highest tier", () => {
		const required = clearanceOf("schema_lint_migration"); // authority

		test("a below-min agent is denied (blocked when enforcing, logged-only when off)", () => {
			const agentTier = defaultTrustTierForKind("agent") as TrustTier; // restricted
			const enforced = decide(agentTier, required, true);
			assert.deepEqual(enforced, {
				logged: true,
				blocked: true,
				allowed: false,
			});
			const logOnly = decide(agentTier, required, false);
			assert.deepEqual(logOnly, {
				logged: true,
				blocked: false,
				allowed: false,
			});
		});

		test("an at/above operator is allowed (no block, no deny-log) in both modes", () => {
			const operatorTier = defaultTrustTierForKind("operator") as TrustTier; // authority
			for (const enforce of [true, false]) {
				assert.deepEqual(decide(operatorTier, required, enforce), {
					logged: false,
					blocked: false,
					allowed: true,
				});
			}
		});
	});

	// ── Lowest case: prop_list ───────────────────────────────────────────────
	describe("prop_list — lowest tier", () => {
		const required = clearanceOf("prop_list"); // restricted

		test("a below-min external_proxy caller is denied (blocked when enforcing)", () => {
			const enforced = decide("external_proxy", required, true);
			assert.deepEqual(enforced, {
				logged: true,
				blocked: true,
				allowed: false,
			});
			const logOnly = decide("external_proxy", required, false);
			assert.equal(logOnly.allowed, false);
			assert.equal(logOnly.blocked, false);
		});

		test("an at-min agent and above-min operator are both allowed", () => {
			const agentTier = defaultTrustTierForKind("agent") as TrustTier; // restricted == min
			assert.equal(decide(agentTier, required, true).allowed, true);
			const operatorTier = defaultTrustTierForKind("operator") as TrustTier; // authority > min
			assert.equal(decide(operatorTier, required, true).allowed, true);
		});
	});
});
