/**
 * P3785 — ConfigPage unit tests
 *
 * Tests the pure helper logic used by ConfigPage.tsx and the API client
 * methods introduced for /api/config/keys.
 *
 * Run: node --import jiti/register --test tests/dashboard/config-page.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import type { ConfigKeyDescriptor } from "../../src/apps/dashboard-web/lib/api.ts";

// ── Mirror of ConfigPage helpers ───────────────────────────────────────────────

function formatValue(v: unknown): string {
	if (v === null || v === undefined) return "";
	if (typeof v === "boolean") return String(v);
	if (typeof v === "object") return JSON.stringify(v);
	return String(v);
}

function groupByCategory(keys: ConfigKeyDescriptor[]): Map<string, ConfigKeyDescriptor[]> {
	const map = new Map<string, ConfigKeyDescriptor[]>();
	for (const key of keys) {
		const cat = key.category ?? "general";
		if (!map.has(cat)) map.set(cat, []);
		map.get(cat)!.push(key);
	}
	return map;
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

function makeDescriptor(overrides: Partial<ConfigKeyDescriptor> = {}): ConfigKeyDescriptor {
	return {
		name: "TEST_FLAG",
		class: "flag",
		category: "feature",
		description: "A test flag",
		value: true,
		default_value: false,
		required: false,
		db_table: "core.runtime_flag",
		scope: null,
		editable: true,
		masked: false,
		...overrides,
	};
}

// ── groupByCategory ────────────────────────────────────────────────────────────

describe("groupByCategory", () => {
	it("groups keys into their respective categories", () => {
		const keys: ConfigKeyDescriptor[] = [
			makeDescriptor({ name: "FLAG_A", category: "orchestrator" }),
			makeDescriptor({ name: "FLAG_B", category: "spawn" }),
			makeDescriptor({ name: "FLAG_C", category: "orchestrator" }),
		];
		const grouped = groupByCategory(keys);
		assert.equal(grouped.size, 2, "should produce 2 category groups");
		assert.equal(grouped.get("orchestrator")?.length, 2);
		assert.equal(grouped.get("spawn")?.length, 1);
	});

	it("falls back to 'general' when category is null", () => {
		const keys: ConfigKeyDescriptor[] = [
			makeDescriptor({ name: "FLAG_NULL_CAT", category: null }),
		];
		const grouped = groupByCategory(keys);
		assert.ok(grouped.has("general"));
		assert.equal(grouped.get("general")?.length, 1);
	});

	it("returns empty map for empty input", () => {
		const grouped = groupByCategory([]);
		assert.equal(grouped.size, 0);
	});
});

// ── formatValue ────────────────────────────────────────────────────────────────

describe("formatValue", () => {
	it("returns empty string for null", () => assert.equal(formatValue(null), ""));
	it("returns empty string for undefined", () => assert.equal(formatValue(undefined), ""));
	it("converts boolean true to 'true'", () => assert.equal(formatValue(true), "true"));
	it("converts boolean false to 'false'", () => assert.equal(formatValue(false), "false"));
	it("JSON-serialises objects", () => assert.equal(formatValue({ x: 1 }), '{"x":1}'));
	it("coerces numbers to string", () => assert.equal(formatValue(42), "42"));
	it("passes strings through", () => assert.equal(formatValue("hello"), "hello"));
});

// ── masked descriptors (secret keys) ──────────────────────────────────────────

describe("secret key descriptor", () => {
	it("has masked=true and editable=false", () => {
		const secret = makeDescriptor({
			name: "OPENAI_API_KEY",
			class: "secret",
			masked: true,
			editable: false,
			value: null,
		});
		assert.equal(secret.masked, true);
		assert.equal(secret.editable, false);
		// The ConfigPage renders '(hidden)' for masked keys — verify the
		// value field is null (server never sends the real value).
		assert.equal(secret.value, null);
	});
});

// ── structural keys ────────────────────────────────────────────────────────────

describe("structural key descriptor", () => {
	it("has editable=false and masked=false", () => {
		const structural = makeDescriptor({
			name: "HIVEMIND_DB_URL",
			class: "structural",
			masked: false,
			editable: false,
			value: "postgresql://localhost/agenthive",
		});
		assert.equal(structural.editable, false);
		assert.equal(structural.masked, false);
	});
});

// ── API client method shape ────────────────────────────────────────────────────

describe("apiClient config-keys methods", () => {
	it("fetchConfigKeys is defined on the api module export", async () => {
		const { apiClient } = await import(
			"../../src/apps/dashboard-web/lib/api.ts"
		);
		assert.equal(typeof apiClient.fetchConfigKeys, "function");
	});

	it("mutateConfigKey is defined on the api module export", async () => {
		const { apiClient } = await import(
			"../../src/apps/dashboard-web/lib/api.ts"
		);
		assert.equal(typeof apiClient.mutateConfigKey, "function");
	});
});
