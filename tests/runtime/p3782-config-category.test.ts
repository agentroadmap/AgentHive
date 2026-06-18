/**
 * P3782 AC-5/AC-9: Every FlagKey in AllConfigKeys must have a defined category.
 *
 * This is a pure unit test — no DB, no env, no imports beyond the key registry.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { AllConfigKeys, FlagKeys } from "../../src/shared/runtime/config-keys";
import type { ConfigKeyCategory } from "../../src/shared/runtime/config-keys";

const VALID_CATEGORIES = new Set<ConfigKeyCategory>([
  "orchestration",
  "a2a",
  "agency",
  "feature_flag",
  "budget",
  "billing",
  "ui",
  "security",
  "model_routing",
  "system",
  "uncategorized",
]);

describe("P3782 config category coverage", () => {
  it("every FlagKey has a defined category from the closed taxonomy", () => {
    const missing: string[] = [];
    const invalid: Array<{ name: string; category: unknown }> = [];

    for (const key of Object.values(FlagKeys)) {
      if (key.category === undefined || key.category === null) {
        missing.push(key.name);
      } else if (!VALID_CATEGORIES.has(key.category as ConfigKeyCategory)) {
        invalid.push({ name: key.name, category: key.category });
      }
    }

    assert.deepEqual(
      missing,
      [],
      `FlagKeys missing category: ${missing.join(", ")}`
    );
    assert.deepEqual(
      invalid,
      [],
      `FlagKeys with invalid category: ${JSON.stringify(invalid)}`
    );
  });

  it("non-flag keys (SecretKeys, StructuralKeys, etc.) are not required to have a category", () => {
    // This test documents that category is optional for non-flag classes.
    // AllConfigKeys merges all key groups — flag keys should all have category.
    const flagKeyNames = new Set(Object.values(FlagKeys).map((k) => k.name));

    for (const key of Object.values(AllConfigKeys)) {
      if (!flagKeyNames.has(key.name)) continue; // non-flag — skip
      const category = (key as { category?: unknown }).category;
      assert.ok(
        category !== undefined,
        `Flag key "${key.name}" found in AllConfigKeys without category`
      );
    }
  });
});
