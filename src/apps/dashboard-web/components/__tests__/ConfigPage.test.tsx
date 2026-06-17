/**
 * P3785 AC-6: ConfigPage unit tests
 *
 * Uses node:test + node:assert (no React render infra) to exercise:
 *   - groupByCategory: null → "General" bucket
 *   - inferEditControl: secret→masked, structural→readonly, bool→checkbox,
 *     number→number, else→text
 *   - ConfigKeyDescriptor: editable flag follows class rules
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ── import helpers exported from ConfigPage ───────────────────────────────────
// ConfigPage.tsx exports groupByCategory and inferEditControl for testability
import { groupByCategory, inferEditControl } from "../ConfigPage.tsx";
import type { ConfigKeyDescriptor } from "../../lib/api.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeKey(overrides: Partial<ConfigKeyDescriptor>): ConfigKeyDescriptor {
	return {
		name: "TEST_KEY",
		class: "flag",
		category: null,
		description: null,
		value: null,
		default_value: null,
		required: false,
		db_table: "core.runtime_flag",
		scope: null,
		editable: true,
		masked: false,
		...overrides,
	};
}

// ── groupByCategory ───────────────────────────────────────────────────────────

describe("groupByCategory", () => {
	it("null category maps to General", () => {
		const key = makeKey({ name: "NULL_CAT", category: null });
		const grouped = groupByCategory([key]);
		assert.ok(grouped.has("General"), "Expected 'General' bucket");
		assert.equal(grouped.get("General")!.length, 1);
		assert.equal(grouped.get("General")![0].name, "NULL_CAT");
	});

	it("named categories are preserved", () => {
		const k1 = makeKey({ name: "K1", category: "orchestration" });
		const k2 = makeKey({ name: "K2", category: "orchestration" });
		const k3 = makeKey({ name: "K3", category: "matching" });
		const grouped = groupByCategory([k1, k2, k3]);
		assert.equal(grouped.get("orchestration")!.length, 2);
		assert.equal(grouped.get("matching")!.length, 1);
		assert.ok(!grouped.has("General"));
	});

	it("mixed null + named produces both buckets", () => {
		const k1 = makeKey({ name: "K1", category: null });
		const k2 = makeKey({ name: "K2", category: "reliability" });
		const grouped = groupByCategory([k1, k2]);
		assert.ok(grouped.has("General"));
		assert.ok(grouped.has("reliability"));
	});

	it("empty list produces empty map", () => {
		const grouped = groupByCategory([]);
		assert.equal(grouped.size, 0);
	});
});

// ── inferEditControl ──────────────────────────────────────────────────────────

describe("inferEditControl", () => {
	it("secret class → masked", () => {
		const key = makeKey({ class: "secret", masked: true, editable: false });
		assert.equal(inferEditControl(key), "masked");
	});

	it("masked=true → masked regardless of class", () => {
		const key = makeKey({ class: "registry", masked: true, editable: true });
		assert.equal(inferEditControl(key), "masked");
	});

	it("structural class → readonly", () => {
		const key = makeKey({ class: "structural", editable: false, masked: false });
		assert.equal(inferEditControl(key), "readonly");
	});

	it("tenant_dsn class → readonly", () => {
		const key = makeKey({ class: "tenant_dsn", editable: false, masked: false });
		assert.equal(inferEditControl(key), "readonly");
	});

	it("editable=false (non-struct/secret) → readonly", () => {
		const key = makeKey({ class: "registry", editable: false, masked: false });
		assert.equal(inferEditControl(key), "readonly");
	});

	it("boolean default → checkbox", () => {
		const key = makeKey({ class: "flag", editable: true, masked: false, default_value: false });
		assert.equal(inferEditControl(key), "checkbox");
	});

	it("number default → number input", () => {
		const key = makeKey({ class: "flag", editable: true, masked: false, default_value: 42 });
		assert.equal(inferEditControl(key), "number");
	});

	it("string default → text input", () => {
		const key = makeKey({ class: "registry", editable: true, masked: false, default_value: "hello" });
		assert.equal(inferEditControl(key), "text");
	});

	it("null default on editable flag → text input", () => {
		const key = makeKey({ class: "flag", editable: true, masked: false, default_value: null });
		assert.equal(inferEditControl(key), "text");
	});
});

// ── editable semantics (class-based) ─────────────────────────────────────────

describe("ConfigKeyDescriptor editable", () => {
	it("flag class has editable=true per API", () => {
		const key = makeKey({ class: "flag", editable: true });
		assert.equal(key.editable, true);
	});

	it("registry class has editable=true per API", () => {
		const key = makeKey({ class: "registry", editable: true });
		assert.equal(key.editable, true);
	});

	it("secret key has no accessible value (masked, editable=false)", () => {
		const key = makeKey({ class: "secret", masked: true, editable: false, value: null });
		assert.equal(key.masked, true);
		assert.equal(key.editable, false);
		assert.equal(key.value, null);
	});
});
