import { describe, expect, it } from "bun:test";
import { liaisonRegister } from "../../src/infra/agency/liaison-service.ts";
import type { PoolClient } from "pg";

/**
 * P1142 follow-up: crash-restart session heal.
 *
 * A fail-fast exit(1) restart re-registers while the dead instance's
 * heartbeat is still <60s fresh; the freshness-guarded orphan heal skips and
 * the unique active-session index then blocks re-registration (observed live
 * 2026-06-10: reborn a2a-host booted "0 of 2 agencies online").
 * supersede_stale_session=true must bypass the freshness guard ($3 = true in
 * the heal UPDATE) so a singleton host always supersedes its own sessions.
 */

function makeClient() {
	const calls: Array<{ sql: string; params: unknown[] }> = [];
	const client = {
		query: async (sql: string, params: unknown[] = []) => {
			calls.push({ sql, params });
			if (sql.includes("SELECT agency_id FROM roadmap.agency")) {
				return { rows: [{ agency_id: params[0] }] };
			}
			if (sql.includes("insert_session")) {
				return {
					rows: [
						{ session_id: "s-1", agency_id: params[0], status: "active" },
					],
				};
			}
			return { rows: [] };
		},
	} as unknown as PoolClient;
	return { client, calls };
}

const BASE = {
	agency_id: "test.a",
	display_name: "test.a",
	provider: "claude",
	host_id: "bot",
};

describe("liaisonRegister stale-session heal (P1142 follow-up)", () => {
	it("default keeps the heartbeat-freshness guard active ($3=false)", async () => {
		const { client, calls } = makeClient();
		await liaisonRegister(BASE, client);
		const heal = calls.find((c) =>
			c.sql.includes("UPDATE roadmap.agency_liaison_session"),
		);
		expect(heal).toBeDefined();
		expect(heal?.sql).toContain("NOT EXISTS");
		expect(heal?.params?.[1]).toBe("orphan-heal-on-register");
		expect(heal?.params?.[2]).toBe(false);
	});

	it("supersede_stale_session=true bypasses the guard ($3=true)", async () => {
		const { client, calls } = makeClient();
		await liaisonRegister({ ...BASE, supersede_stale_session: true }, client);
		const heal = calls.find((c) =>
			c.sql.includes("UPDATE roadmap.agency_liaison_session"),
		);
		expect(heal).toBeDefined();
		expect(heal?.params?.[1]).toBe("superseded-on-host-restart");
		expect(heal?.params?.[2]).toBe(true);
	});
});
