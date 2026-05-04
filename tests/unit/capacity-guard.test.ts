import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isWithinCapacity } from "../../src/core/orchestration/resolvers/capacity-guard.ts";

function makeQuery(rows: Record<string, unknown>[]) {
	return async (_sql: string, _params?: unknown[]) => ({ rows });
}

describe("isWithinCapacity", () => {
	it("returns true when no config row (uncapped)", async () => {
		assert.equal(await isWithinCapacity(1, makeQuery([])), true);
	});

	it("returns true when active_count < max", async () => {
		assert.equal(
			await isWithinCapacity(
				1,
				makeQuery([{ max_concurrent_dispatches: 8, active_count: "5" }]),
			),
			true,
		);
	});

	it("returns false when active_count >= max", async () => {
		assert.equal(
			await isWithinCapacity(
				1,
				makeQuery([{ max_concurrent_dispatches: 8, active_count: "8" }]),
			),
			false,
		);
	});
});
