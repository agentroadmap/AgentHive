import assert from "node:assert";
import { describe, test } from "node:test";
import {
	IMPORTABLE_DIVISIONS,
	reconcileDivisions,
} from "./import-agency-agents-catalog.ts";

/**
 * P1358 deterministic parser + reconciliation tests (no DB). The end-to-end
 * parse/insert is exercised by the live --dry-run and real import; these lock
 * the spec-critical invariants that regressed before (AC-15 strategy, AC-17).
 */

describe("import-agency-agents-catalog (P1358)", () => {
	test("AC-15: IMPORTABLE_DIVISIONS enumerates all 14 divisions incl. strategy", () => {
		const expected = [
			"academic",
			"design",
			"engineering",
			"game-development",
			"marketing",
			"paid-media",
			"product",
			"project-management",
			"sales",
			"spatial-computing",
			"specialized",
			"strategy",
			"support",
			"testing",
		];
		assert.equal(IMPORTABLE_DIVISIONS.length, 14);
		assert.deepEqual([...IMPORTABLE_DIVISIONS].sort(), [...expected].sort());
		assert.ok(
			IMPORTABLE_DIVISIONS.includes("strategy"),
			"strategy must be enumerated (AC-15) — its omission was the original bug",
		);
	});

	test("AC-17: reconcileDivisions flags neither importable+present nor excluded dirs", async () => {
		const { missingFromDisk, extraOnDisk } = await reconcileDivisions(
			"/data/code/agency-agents",
		);
		// All 14 declared divisions exist on disk.
		assert.deepEqual(missingFromDisk, [], "no declared division missing");
		// finance/ is on disk but explicitly EXCLUDED, so it must NOT appear here;
		// examples/scripts/integrations are excluded too. Dot-dirs are ignored.
		assert.deepEqual(
			extraOnDisk,
			[],
			`unreconciled dirs leaked: ${extraOnDisk.join(",")}`,
		);
	});
});
