import { describe, expect, it } from "bun:test";
import { setProviderAuthDown } from "./provider-auth.ts";

describe("setProviderAuthDown", () => {
	it("marks routes down by agent_provider (CLI credential boundary), not route_provider", async () => {
		const calls: Array<{ sql: string; params: unknown[] }> = [];
		const queryFn = async (sql: string, params: unknown[] = []) => {
			calls.push({ sql, params });
			return { rows: [] };
		};

		await setProviderAuthDown(
			"codex-bot-andy.a",
			"codex",
			401,
			"401 Unauthorized: Missing bearer or basic authentication in header",
			queryFn,
		);

		const update = calls.find((c) =>
			c.sql.includes("UPDATE roadmap.model_routes"),
		);
		expect(update).toBeDefined();
		// codex routes live as agent_provider='codex' / route_provider='openai';
		// matching route_provider here was a silent no-op for every liaison call.
		expect(update!.sql).toContain("agent_provider = $1");
		expect(update!.sql).not.toContain("route_provider = $1");
		expect(update!.params).toEqual(["codex"]);

		const escalation = calls.find((c) =>
			c.sql.includes("INSERT INTO roadmap.escalation_log"),
		);
		expect(escalation).toBeDefined();
		expect(escalation!.params?.[0]).toBe("PROVIDER_AUTH_DOWN");
		expect(escalation!.params?.[1]).toBe("codex-bot-andy.a");

		expect(calls.some((c) => c.sql === "COMMIT")).toBe(true);
	});

	it("rolls back when a write fails", async () => {
		const calls: string[] = [];
		const queryFn = async (sql: string) => {
			calls.push(sql);
			if (sql.includes("INSERT INTO roadmap.escalation_log")) {
				throw new Error("boom");
			}
			return { rows: [] };
		};

		await expect(
			setProviderAuthDown("codex-bot-andy.a", "codex", 401, "x", queryFn),
		).rejects.toThrow("boom");
		expect(calls).toContain("ROLLBACK");
	});
});
