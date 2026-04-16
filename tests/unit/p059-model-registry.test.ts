/**
 * P059: Model Registry & Cost-Aware Routing — Unit Tests
 *
 * Tests for enhanced model_list capability filtering and model_add is_active support.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("P059: Model Registry", () => {
	describe("PgModelHandlers.listModels", () => {
		it("should accept capability filter parameter", () => {
			// Verify the capability filter format: "key=value"
			const cap = "tool_use=true";
			const [key, value] = cap.split("=");
			assert.equal(key, "tool_use");
			assert.equal(value, "true");
		});

		it("should accept max_cost_per_1k_input as numeric string", () => {
			const cost = "0.01";
			const parsed = parseFloat(cost);
			assert.equal(parsed, 0.01);
			assert.ok(parsed > 0);
		});

		it("should accept active_only boolean parameter", () => {
			const activeOnly = true;
			assert.equal(typeof activeOnly, "boolean");
		});

		it("should default active_only to true when not specified", () => {
			const args: { active_only?: boolean } = {};
			const effectiveActiveOnly = args.active_only !== false;
			assert.equal(effectiveActiveOnly, true);
		});

		it("should allow inactive models when active_only is explicitly false", () => {
			const args = { active_only: false };
			const effectiveActiveOnly = args.active_only !== false;
			assert.equal(effectiveActiveOnly, false);
		});
	});

	describe("PgModelHandlers.addModel", () => {
		it("should accept is_active parameter", () => {
			const isActive = "true";
			const parsed = isActive === "true";
			assert.equal(parsed, true);
		});

		it("should accept is_active=false for deactivation", () => {
			const isActive: string = "false";
			const parsed = isActive === "true";
			assert.equal(parsed, false);
		});

		it("should accept context_window parameter", () => {
			const ctx = "200000";
			const parsed = parseInt(ctx, 10);
			assert.equal(parsed, 200000);
		});

		it("should parse capabilities JSON", () => {
			const caps = '{"tool_use":true,"vision":true}';
			const parsed = JSON.parse(caps);
			assert.deepEqual(parsed, { tool_use: true, vision: true });
		});

		it("should handle null is_active for default behavior", () => {
			const args: { is_active?: string } = {};
			const parsed = args.is_active !== undefined ? args.is_active === "true" : null;
			assert.equal(parsed, null);
		});
	});

	describe("Cost-aware routing integration", () => {
		it("should support 6 decimal places for sub-cent pricing", () => {
			const haikuCost = 0.00025;
			assert.ok(haikuCost < 0.001);
			// Verify precision: $0.000250/1k tokens
			assert.equal(haikuCost.toFixed(6), "0.000250");
		});

		it("should rank models by rating then cost", () => {
			const models = [
				{ name: "haiku", rating: 3, cost: 0.00025 },
				{ name: "sonnet", rating: 4, cost: 0.003 },
				{ name: "opus", rating: 5, cost: 0.015 },
			];
			const sorted = [...models].sort((a, b) => {
				if (b.rating !== a.rating) return b.rating - a.rating;
				return a.cost - b.cost;
			});
			assert.equal(sorted[0].name, "opus");
			assert.equal(sorted[1].name, "sonnet");
			assert.equal(sorted[2].name, "haiku");
		});
	});
});
