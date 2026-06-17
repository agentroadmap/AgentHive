import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConfigKeyDescriptor } from "../lib/api";

// Inline the pure helpers so tests don't depend on React rendering.

function groupByCategory(keys: ConfigKeyDescriptor[]): Map<string, ConfigKeyDescriptor[]> {
	const map = new Map<string, ConfigKeyDescriptor[]>();
	for (const key of keys) {
		const cat = key.category ?? "General";
		const bucket = map.get(cat) ?? [];
		bucket.push(key);
		map.set(cat, bucket);
	}
	const sorted = new Map<string, ConfigKeyDescriptor[]>();
	const cats = [...map.keys()].sort((a, b) => {
		if (a === "General") return 1;
		if (b === "General") return -1;
		return a.localeCompare(b);
	});
	for (const cat of cats) sorted.set(cat, map.get(cat)!);
	return sorted;
}

function inferInputType(key: ConfigKeyDescriptor): "boolean" | "number" | "text" {
	if (key.class === "flag") return "boolean";
	if (typeof key.default_value === "number") return "number";
	return "text";
}

function displayValue(key: ConfigKeyDescriptor): string {
	if (key.masked) return "••••••••";
	if (key.value == null) return "";
	if (typeof key.value === "boolean") return key.value ? "true" : "false";
	return String(key.value);
}

const makeKey = (overrides: Partial<ConfigKeyDescriptor> = {}): ConfigKeyDescriptor => ({
	name: "TEST_KEY",
	class: "registry",
	category: null,
	description: "A test key",
	default_value: "default",
	required: false,
	db_table: null,
	scope: "global",
	editable: true,
	masked: false,
	value: "current",
	...overrides,
});

describe("groupByCategory", () => {
	it("places null-category keys under General", () => {
		const keys = [makeKey({ name: "A", category: null })];
		const grouped = groupByCategory(keys);
		assert.ok(grouped.has("General"));
		assert.equal(grouped.get("General")!.length, 1);
	});

	it("groups keys by category", () => {
		const keys = [
			makeKey({ name: "A", category: "alpha" }),
			makeKey({ name: "B", category: "beta" }),
			makeKey({ name: "C", category: "alpha" }),
		];
		const grouped = groupByCategory(keys);
		assert.equal(grouped.get("alpha")!.length, 2);
		assert.equal(grouped.get("beta")!.length, 1);
	});

	it("sorts General to the end", () => {
		const keys = [
			makeKey({ name: "A", category: null }),
			makeKey({ name: "B", category: "zebra" }),
		];
		const grouped = groupByCategory(keys);
		const cats = [...grouped.keys()];
		assert.equal(cats[cats.length - 1], "General");
	});
});

describe("inferInputType", () => {
	it("returns boolean for flag class", () => {
		assert.equal(inferInputType(makeKey({ class: "flag", default_value: true })), "boolean");
	});

	it("returns number when default_value is a number", () => {
		assert.equal(inferInputType(makeKey({ class: "registry", default_value: 42 })), "number");
	});

	it("returns text for string default_value", () => {
		assert.equal(inferInputType(makeKey({ class: "registry", default_value: "hello" })), "text");
	});

	it("returns text when default_value is null", () => {
		assert.equal(inferInputType(makeKey({ default_value: null })), "text");
	});
});

describe("displayValue", () => {
	it("masks secret keys", () => {
		assert.equal(displayValue(makeKey({ masked: true, value: "secret" })), "••••••••");
	});

	it("returns empty string for null value", () => {
		assert.equal(displayValue(makeKey({ value: null })), "");
	});

	it("converts boolean true to string", () => {
		assert.equal(displayValue(makeKey({ value: true })), "true");
	});

	it("converts boolean false to string", () => {
		assert.equal(displayValue(makeKey({ value: false })), "false");
	});

	it("returns string value as-is", () => {
		assert.equal(displayValue(makeKey({ value: "hello" })), "hello");
	});

	it("converts number to string", () => {
		assert.equal(displayValue(makeKey({ value: 42 })), "42");
	});
});
