/**
 * P919 AC-12: claimDisplayAlias unit tests.
 *
 * In-process tests with the pg pool mocked, so we can exercise the structured
 * result paths (claimed / row_already_has_different_alias / alias_in_use)
 * without needing a live DB. The integration-style tests in
 * alias-manager.test.ts cover the SQL semantics against a real Postgres.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const queryMock = vi.fn();

vi.mock("../../../../infra/postgres/pool.ts", () => ({
	query: (...args: unknown[]) => queryMock(...args),
}));

import { claimDisplayAlias } from "../alias-manager.ts";

describe("claimDisplayAlias — P919 AC-12", () => {
	beforeEach(() => {
		queryMock.mockReset();
	});

	it("claimed=true when UPDATE returns the row id", async () => {
		queryMock.mockResolvedValueOnce({ rows: [{ id: 42 }] });
		const result = await claimDisplayAlias(42, "Gemini-Bot", { tier: 1 });
		expect(result).toEqual({ claimed: true });
		expect(queryMock).toHaveBeenCalledOnce();
		const [sql, params] = queryMock.mock.calls[0];
		expect(sql).toContain("UPDATE roadmap_workforce.agent_registry");
		expect(sql).toContain("display_alias = $2");
		expect(sql).toContain("display_alias IS NULL OR display_alias = $2");
		expect(params[0]).toBe(42);
		expect(params[1]).toBe("Gemini-Bot");
		// Audit JSONB carries the tier marker.
		const audit = JSON.parse(params[2] as string);
		expect(audit[0]).toMatchObject({
			action: "claimed",
			tier: 1,
			alias: "Gemini-Bot",
		});
	});

	it("returns row_already_has_different_alias when UPDATE matches no rows", async () => {
		queryMock.mockResolvedValueOnce({ rows: [] });
		const result = await claimDisplayAlias(42, "Gemini-Bot", { tier: 1 });
		expect(result).toEqual({
			claimed: false,
			reason: "row_already_has_different_alias",
		});
	});

	it("returns alias_in_use on partial-unique-index collision (23505)", async () => {
		const pgErr = Object.assign(
			new Error(
				"duplicate key value violates unique constraint \"idx_agent_alias_active\"",
			),
			{ code: "23505", constraint: "idx_agent_alias_active" },
		);
		queryMock.mockRejectedValueOnce(pgErr);
		const result = await claimDisplayAlias(42, "Gemini-Bot", { tier: 1 });
		expect(result).toEqual({ claimed: false, reason: "alias_in_use" });
	});

	it("re-throws unrelated DB errors", async () => {
		const pgErr = Object.assign(new Error("connection refused"), {
			code: "08006",
		});
		queryMock.mockRejectedValueOnce(pgErr);
		await expect(
			claimDisplayAlias(42, "Gemini-Bot", { tier: 1 }),
		).rejects.toThrow("connection refused");
	});

	it("rejects empty alias", async () => {
		await expect(claimDisplayAlias(42, "", { tier: 1 })).rejects.toThrow(
			/alias is required/,
		);
		await expect(claimDisplayAlias(42, "   ", { tier: 1 })).rejects.toThrow(
			/alias is required/,
		);
		expect(queryMock).not.toHaveBeenCalled();
	});

	it("uses provided client when supplied (transaction participation)", async () => {
		const clientQuery = vi.fn().mockResolvedValue({ rows: [{ id: 7 }] });
		const fakeClient = { query: clientQuery } as unknown as Parameters<
			typeof claimDisplayAlias
		>[2]["client"];
		const result = await claimDisplayAlias(7, "Codex-Mac", {
			tier: 1,
			client: fakeClient,
		});
		expect(result).toEqual({ claimed: true });
		expect(clientQuery).toHaveBeenCalledOnce();
		expect(queryMock).not.toHaveBeenCalled();
	});

	it("records tier=2 in audit when caller passes tier:2", async () => {
		queryMock.mockResolvedValueOnce({ rows: [{ id: 99 }] });
		await claimDisplayAlias(99, "Claude-Bot-Architect", { tier: 2 });
		const [, params] = queryMock.mock.calls[0];
		const audit = JSON.parse(params[2] as string);
		expect(audit[0].tier).toBe(2);
	});
});
