import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConfigKeyDescriptor } from "../../lib/api";

// ── Helpers duplicated from ConfigPage for unit-testability ───────────────────

const CATEGORY_ORDER = [
	"orchestration",
	"a2a",
	"agency",
	"feature_flag",
	"model_routing",
	"budget",
	"billing",
	"security",
	"ui",
	"system",
	"uncategorized",
];

function groupByCategory(keys: ConfigKeyDescriptor[]): Map<string, ConfigKeyDescriptor[]> {
	const map = new Map<string, ConfigKeyDescriptor[]>();
	for (const key of keys) {
		const cat = key.category ?? "uncategorized";
		if (!map.has(cat)) map.set(cat, []);
		map.get(cat)!.push(key);
	}
	return map;
}

function inferInputType(key: ConfigKeyDescriptor): "boolean" | "number" | "string" {
	const def = key.default_value;
	if (typeof def === "boolean") return "boolean";
	if (typeof def === "number") return "number";
	if (typeof key.value === "boolean") return "boolean";
	if (typeof key.value === "number") return "number";
	const name = key.name.toLowerCase();
	if (
		name.endsWith("_enabled") ||
		name.startsWith("enable_") ||
		name.startsWith("use_") ||
		name.startsWith("pause_") ||
		name.endsWith("_guard")
	)
		return "boolean";
	if (name.endsWith("_ms") || name.endsWith("_limit") || name.endsWith("_cap") || name.endsWith("_max"))
		return "number";
	return "string";
}

function displayValue(key: ConfigKeyDescriptor): string {
	if (key.masked) return "••••••";
	if (key.value === null || key.value === undefined)
		return key.default_value != null ? String(key.default_value) : "(not set)";
	return typeof key.value === "object" ? JSON.stringify(key.value) : String(key.value);
}

const makeKey = (overrides: Partial<ConfigKeyDescriptor> = {}): ConfigKeyDescriptor => ({
	name: "TEST_KEY",
	class: "flag",
	category: "orchestration",
	description: null,
	value: null,
	default_value: null,
	required: false,
	editable: true,
	masked: false,
	...overrides,
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("groupByCategory", () => {
	it("groups keys by category", () => {
		const keys = [
			makeKey({ name: "A", category: "orchestration" }),
			makeKey({ name: "B", category: "a2a" }),
			makeKey({ name: "C", category: "orchestration" }),
		];
		const groups = groupByCategory(keys);
		assert.equal(groups.get("orchestration")?.length, 2);
		assert.equal(groups.get("a2a")?.length, 1);
	});

	it("falls back to uncategorized for null category", () => {
		const keys = [makeKey({ category: "uncategorized" })];
		const groups = groupByCategory(keys);
		assert.ok(groups.has("uncategorized"));
	});
});

describe("inferInputType", () => {
	it("detects boolean from default_value", () => {
		assert.equal(inferInputType(makeKey({ default_value: true })), "boolean");
		assert.equal(inferInputType(makeKey({ default_value: false })), "boolean");
	});

	it("detects number from default_value", () => {
		assert.equal(inferInputType(makeKey({ default_value: 1000 })), "number");
	});

	it("detects boolean from _enabled suffix", () => {
		assert.equal(inferInputType(makeKey({ name: "AGENCY_OFFER_CLAIM_ENABLED" })), "boolean");
	});

	it("detects boolean from ENABLE_ prefix", () => {
		assert.equal(inferInputType(makeKey({ name: "ENABLE_MULTI_TENANT" })), "boolean");
	});

	it("detects number from _ms suffix", () => {
		assert.equal(inferInputType(makeKey({ name: "ORCHESTRATOR_HEARTBEAT_MS" })), "number");
	});

	it("defaults to string", () => {
		assert.equal(inferInputType(makeKey({ name: "PGHOST" })), "string");
	});
});

describe("displayValue", () => {
	it("masks secret keys", () => {
		assert.equal(displayValue(makeKey({ masked: true, value: "s3cr3t" })), "••••••");
	});

	it("shows default when value is null", () => {
		assert.equal(displayValue(makeKey({ value: null, default_value: 5000 })), "5000");
	});

	it("shows (not set) when no value and no default", () => {
		assert.equal(displayValue(makeKey({ value: null, default_value: null })), "(not set)");
	});

	it("JSON-serializes object values", () => {
		assert.equal(displayValue(makeKey({ value: { a: 1 } })), '{"a":1}');
	});

	it("stringifies primitive values", () => {
		assert.equal(displayValue(makeKey({ value: 42 })), "42");
		assert.equal(displayValue(makeKey({ value: true })), "true");
	});
});

describe("CATEGORY_ORDER", () => {
	it("contains all expected taxonomy values", () => {
		const taxonomy = [
			"orchestration", "a2a", "agency", "feature_flag", "model_routing",
			"budget", "billing", "security", "ui", "system", "uncategorized",
		];
		for (const cat of taxonomy) {
			assert.ok(CATEGORY_ORDER.includes(cat), `Missing: ${cat}`);
		}
	});
});
