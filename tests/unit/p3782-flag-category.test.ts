/**
 * P3782 Unit Tests — runtime flag category annotations
 *
 * AC-8 / AC-12: Every entry in FlagKeys must have a `category` field
 * that is a member of the canonical ConfigKeyCategory taxonomy.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FlagKeys } from "../../src/shared/runtime/config-keys.js";
import type { ConfigKeyCategory } from "../../src/shared/runtime/config-keys.js";

const VALID_CATEGORIES: ReadonlySet<ConfigKeyCategory> = new Set([
	"orchestrator",
	"a2a",
	"pause",
	"spawn",
	"matcher",
	"tui",
	"feature",
	"general",
]);

describe("P3782 FlagKeys category annotations", () => {
	it("every FlagKey has a non-empty category field", () => {
		const missing: string[] = [];
		for (const [key, def] of Object.entries(FlagKeys)) {
			if (!def.category) {
				missing.push(key);
			}
		}
		assert.deepEqual(
			missing,
			[],
			`FlagKeys missing category annotation: ${missing.join(", ")}`,
		);
	});

	it("every FlagKey category is in the canonical ConfigKeyCategory taxonomy", () => {
		const invalid: string[] = [];
		for (const [key, def] of Object.entries(FlagKeys)) {
			const cat = def.category as string | undefined;
			if (cat && !VALID_CATEGORIES.has(cat as ConfigKeyCategory)) {
				invalid.push(`${key}=${cat}`);
			}
		}
		assert.deepEqual(
			invalid,
			[],
			`FlagKeys with unrecognised category: ${invalid.join(", ")}`,
		);
	});
});
