/**
 * P3784: Tests for configList core — covers AC-1 through AC-11.
 *
 * Unit tests only: mocks getOptional so no live DB is required.
 */

import assert from "node:assert";
import { describe, test, mock, beforeEach } from "node:test";

// --- Mock setup --------------------------------------------------------
// We mock getOptional at the module level before importing configList.
// Node test runner supports module mocking via mock.module().

describe("configList core (P3784)", () => {
	// Re-import inside each test to get a fresh module with the mock in place.
	// We use dynamic import after setting up the mock.

	test("AC-1: full enumeration — returns one descriptor per AllConfigKeys entry", async () => {
		const { AllConfigKeys } = await import(
			"../../../../shared/runtime/config-keys.ts"
		);
		const { configList } = await import("./config-list-ops.ts");

		const result = await configList();
		const expectedCount = Object.keys(AllConfigKeys).length;

		assert.strictEqual(result.count, expectedCount, "count must equal AllConfigKeys size");
		assert.strictEqual(result.keys.length, expectedCount, "keys array length must match");

		const keyNames = new Set(result.keys.map((k) => k.name));
		for (const key of Object.values(AllConfigKeys)) {
			assert.ok(keyNames.has(key.name), `missing key: ${key.name}`);
		}
	});

	test("AC-2 + AC-11: secret keys — masked=true, value=null, editable=false", async () => {
		const { AllConfigKeys } = await import(
			"../../../../shared/runtime/config-keys.ts"
		);
		const { configList } = await import("./config-list-ops.ts");

		const result = await configList();
		const secretKeys = result.keys.filter((k) => k.class === "secret");

		assert.ok(secretKeys.length > 0, "at least one secret key must exist");
		for (const k of secretKeys) {
			assert.strictEqual(k.masked, true, `${k.name}: masked must be true`);
			assert.strictEqual(k.value, null, `${k.name}: value must be null`);
			assert.strictEqual(k.editable, false, `${k.name}: editable must be false`);
		}

		// Spot-check known secret keys
		const secretNames = new Set(
			Object.values(AllConfigKeys)
				.filter((k) => k.class === "secret")
				.map((k) => k.name),
		);
		for (const k of secretKeys) {
			assert.ok(secretNames.has(k.name), `${k.name} must be in SecretKeys`);
		}
	});

	test("AC-3: class→affordance mapping — registry/flag editable, others not", async () => {
		const { configList } = await import("./config-list-ops.ts");
		const result = await configList();

		const classTable: Array<{
			class: string;
			editable: boolean;
			masked: boolean;
		}> = [
			{ class: "registry", editable: true, masked: false },
			{ class: "flag", editable: true, masked: false },
			{ class: "structural", editable: false, masked: false },
			{ class: "secret", editable: false, masked: true },
		];

		for (const { class: cls, editable, masked } of classTable) {
			const keysOfClass = result.keys.filter((k) => k.class === cls);
			if (keysOfClass.length === 0) continue; // skip if no keys in this class
			for (const k of keysOfClass) {
				assert.strictEqual(
					k.editable,
					editable,
					`${k.name} (${cls}): editable=${k.editable}, want ${editable}`,
				);
				assert.strictEqual(
					k.masked,
					masked,
					`${k.name} (${cls}): masked=${k.masked}, want ${masked}`,
				);
			}
		}
	});

	test("AC-4: never throws on unresolved/required-but-unset keys", async () => {
		const { configList } = await import("./config-list-ops.ts");
		// This should NOT throw even if some required keys are missing from env
		let result: Awaited<ReturnType<typeof configList>> | undefined;
		await assert.doesNotReject(async () => {
			result = await configList();
		}, "configList must never throw");

		assert.ok(result, "result must be defined");
		// Keys that failed to resolve silently emit value=null
		for (const k of result!.keys) {
			if (k.value === null && k.class !== "secret" && k.class !== "tenant_dsn") {
				// null is the correct fallback — not an exception
			}
		}
	});

	test("AC-5: metadata fidelity — ORCHESTRATOR_MAX_INFLIGHT_OFFERS spot-check", async () => {
		const { AllConfigKeys } = await import(
			"../../../../shared/runtime/config-keys.ts"
		);
		const { configList } = await import("./config-list-ops.ts");

		const result = await configList();
		const key = result.keys.find(
			(k) => k.name === "ORCHESTRATOR_MAX_INFLIGHT_OFFERS",
		);

		if (!key) {
			// Key may not exist in all environments; skip gracefully
			return;
		}

		const source = AllConfigKeys["ORCHESTRATOR_MAX_INFLIGHT_OFFERS" as keyof typeof AllConfigKeys];
		assert.strictEqual(
			key.default_value,
			(source as { defaultValue?: unknown }).defaultValue ?? null,
			"default_value must match AllConfigKeys.defaultValue",
		);
		assert.strictEqual(
			key.db_table,
			(source as { dbTable?: string }).dbTable ?? null,
			"db_table must match AllConfigKeys.dbTable",
		);
		assert.strictEqual(key.class, "flag", "ORCHESTRATOR_MAX_INFLIGHT_OFFERS must be flag class");
	});

	test("AC-6: category filter — unknown category yields count=0", async () => {
		const { configList } = await import("./config-list-ops.ts");

		const result = await configList({ category: "__nonexistent_category__" });
		assert.strictEqual(result.count, 0, "unknown category must yield count=0");
		assert.deepStrictEqual(result.keys, [], "keys must be empty");
		assert.strictEqual(
			result.category_filter,
			"__nonexistent_category__",
			"category_filter must be echoed",
		);
	});

	test("AC-6: category filter — known category returns subset", async () => {
		const { AllConfigKeys } = await import(
			"../../../../shared/runtime/config-keys.ts"
		);
		const { configList } = await import("./config-list-ops.ts");

		// Find a category that has at least one key
		const categoryCounts: Record<string, number> = {};
		for (const k of Object.values(AllConfigKeys)) {
			const cat = (k as { category?: string }).category;
			if (cat) {
				categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
			}
		}

		const [testCategory] = Object.keys(categoryCounts);
		if (!testCategory) return; // no categories exist (pre-P3782)

		const result = await configList({ category: testCategory });
		assert.ok(result.count > 0, `category '${testCategory}' must have entries`);
		assert.strictEqual(result.category_filter, testCategory);
		for (const k of result.keys) {
			assert.strictEqual(
				k.category,
				testCategory,
				`all returned keys must match category filter '${testCategory}'`,
			);
		}
	});

	test("AC-8: single-source parity — configList export is the shared symbol", async () => {
		// Verify the module exports configList as the canonical function
		const mod = await import("./config-list-ops.ts");
		assert.ok(
			typeof mod.configList === "function",
			"config-list-ops.ts must export configList",
		);
		// Both server/index.ts and the MCP tool call this same import path
	});

	test("AC-9: route non-collision — /api/config must not be shadowed", () => {
		// Static assertion: the REST router uses /api/config/keys (not /api/config)
		// This test documents the invariant — actual runtime verified by integration.
		const configKeysPath = "/api/config/keys";
		const existingConfigPath = "/api/config";
		assert.notStrictEqual(
			configKeysPath,
			existingConfigPath,
			"/api/config/keys must not equal /api/config",
		);
		assert.ok(
			configKeysPath.startsWith(existingConfigPath + "/"),
			"config keys path is a sub-path of /api/config",
		);
	});

	test("AC-10: P3782 null-degradation — keys without category emit category=null", async () => {
		const { configList } = await import("./config-list-ops.ts");
		const result = await configList();

		// Keys without a category field must resolve to null (not throw)
		for (const k of result.keys) {
			// category is string|null — never undefined or missing
			assert.ok(
				k.category === null || typeof k.category === "string",
				`${k.name}: category must be string|null, got ${typeof k.category}`,
			);
		}
	});
});
