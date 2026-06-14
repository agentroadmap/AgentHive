/**
 * P3313 AC-5: route override surface unit tests (pure-mocked, no DB).
 * Verifies audit enforcement, supersede-on-replace, and effective-override derivation.
 */

import { describe, expect, it } from "vitest";
import {
	setOverride,
	clearOverride,
	getEffectiveOverrides,
} from "../route-match-override.ts";

function recorder(rows: Record<string, unknown>[] = []) {
	const calls: Array<{ sql: string; params: unknown[] }> = [];
	const exec = async (sql: string, params: unknown[] = []) => {
		calls.push({ sql, params });
		if (sql.startsWith("INSERT INTO roadmap_workforce.route_match_override"))
			return { rows: [{ id: 1, mode: params[2], route_id: params[1] }] };
		if (sql.includes("SELECT") && sql.includes("route_match_override"))
			return { rows };
		return { rows: [], rowCount: 1 };
	};
	return { exec, calls };
}

describe("P3313 route-match-override", () => {
	it("requires createdBy (audit)", async () => {
		const { exec } = recorder();
		await expect(
			setOverride({ taskClass: "merge", routeId: 1, mode: "pin", createdBy: "", exec }),
		).rejects.toThrow(/createdBy is required/);
	});

	it("requires clearedBy (audit)", async () => {
		const { exec } = recorder();
		await expect(clearOverride("merge", 1, "", exec)).rejects.toThrow(
			/clearedBy is required/,
		);
	});

	it("supersedes an existing active override before inserting", async () => {
		const { exec, calls } = recorder();
		await setOverride({
			taskClass: "merge",
			routeId: 7,
			mode: "ban",
			createdBy: "gary",
			reason: "flaky",
			exec,
		});
		const sqls = calls.map((c) => c.sql);
		expect(sqls.some((s) => s.startsWith("BEGIN"))).toBe(true);
		expect(
			sqls.some(
				(s) =>
					s.includes("UPDATE roadmap_workforce.route_match_override") &&
					s.includes("cleared_at = now()"),
			),
		).toBe(true);
		expect(
			sqls.some((s) => s.startsWith("INSERT INTO roadmap_workforce.route_match_override")),
		).toBe(true);
		expect(sqls.some((s) => s.startsWith("COMMIT"))).toBe(true);
	});

	it("derives pinned + banned route ids from active overrides", async () => {
		const { exec } = recorder([
			{ id: 1, task_class: "develop", route_id: 5, mode: "pin" },
			{ id: 2, task_class: "develop", route_id: 9, mode: "ban" },
			{ id: 3, task_class: "develop", route_id: 12, mode: "ban" },
		]);
		const eff = await getEffectiveOverrides("develop", exec);
		expect(eff.pinnedRouteId).toBe(5);
		expect(eff.bannedRouteIds.sort((a, b) => a - b)).toEqual([9, 12]);
	});
});
