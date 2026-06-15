/**
 * P1028 — setMaturity handler accepts 'validated' end-to-end (AC-3, AC-8, AC-20).
 *
 * Drives the REAL PgProposalHandlers.setMaturity() with the pool `query` and the
 * proposal-storage `pg` module mocked, proving:
 *   - AC-20 site 1: 'validated' passes the validMaturityValues allowlist (no
 *     "Invalid maturity" rejection before any DB call).
 *   - AC-3 / AC-12: 'validated' is REJECTED when status != 'COMPLETE' (message
 *     names the required status), and ACCEPTED when status = 'COMPLETE'.
 *   - AC-8: existing transitions (obsolete) keep working — no breaking change.
 *
 * Run: npx vitest run src/apps/mcp-server/tools/proposals/p1028-validated-maturity.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// The handler resolves identity via the active lease; force a deterministic actor.
const queryMock = vi.fn();

vi.mock("../../../../postgres/pool.ts", () => ({
	query: (...args: unknown[]) => queryMock(...args),
}));

// Mock the storage module: resolveProposalId + setMaturity + the bits the
// handler touches. Only what setMaturity() needs.
const setMaturityMock = vi.fn();
vi.mock("../../../../infra/postgres/proposal-storage-v2.ts", () => ({
	resolveProposalId: vi.fn(async () => 1028),
	setMaturity: (...args: unknown[]) => setMaturityMock(...args),
}));

// resolveActingIdentity lives in proposal-integrity-adjacent code; the handler
// calls resolveActingIdentity() internally. It returns an actor when an agent
// arg is passed, so we always pass agent= to avoid the lease lookup.

import { PgProposalHandlers } from "./pg-handlers.ts";

const handlers = new PgProposalHandlers();

/** Route the handler's various SELECTs based on SQL shape. */
function installQueryRouter(status: string) {
	queryMock.mockImplementation(async (sql: string) => {
		// status gate query for 'validated'
		if (/SELECT status FROM roadmap_proposal\.proposal WHERE id = \$1/.test(sql)) {
			return { rows: [{ status }] };
		}
		// premature-maturity gate query (only hit for maturity='mature')
		if (/count\(ac/.test(sql)) {
			return { rows: [{ status, total: 0, passing: 0 }] };
		}
		// resolveActingIdentity lease lookup — return nothing; we pass agent= instead
		return { rows: [] };
	});
}

describe("P1028 setMaturity('validated')", () => {
	beforeEach(() => {
		queryMock.mockReset();
		setMaturityMock.mockReset();
		setMaturityMock.mockResolvedValue({
			id: 1028,
			display_id: "P1028",
			status: "COMPLETE",
		});
	});

	it("AC-20: 'validated' is NOT rejected by the allowlist (no 'Invalid maturity')", async () => {
		installQueryRouter("COMPLETE");
		const res = await handlers.setMaturity({ id: "P1028", maturity: "validated", agent: "test-actor" });
		const text = res.content[0]?.text ?? "";
		expect(text).not.toMatch(/Invalid maturity/);
	});

	it("AC-3: rejects 'validated' when status != COMPLETE, naming the required status", async () => {
		installQueryRouter("DEVELOP");
		const res = await handlers.setMaturity({ id: "P1028", maturity: "validated", agent: "test-actor" });
		const text = res.content[0]?.text ?? "";
		expect(text).toMatch(/requires status='COMPLETE'/);
		expect(text).toMatch(/DEVELOP/);
		// must NOT have reached the DB write
		expect(setMaturityMock).not.toHaveBeenCalled();
	});

	it("AC-3: accepts 'validated' when status = COMPLETE (reaches pg.setMaturity)", async () => {
		installQueryRouter("COMPLETE");
		const res = await handlers.setMaturity({ id: "P1028", maturity: "validated", agent: "test-actor" });
		const text = res.content[0]?.text ?? "";
		expect(text).not.toMatch(/refused/);
		expect(setMaturityMock).toHaveBeenCalledTimes(1);
		// 2nd positional arg to pg.setMaturity is the maturity value
		expect(setMaturityMock.mock.calls[0][1]).toBe("validated");
	});

	it("AC-8: existing 'obsolete' transition still works (no breaking change)", async () => {
		installQueryRouter("DEVELOP");
		setMaturityMock.mockResolvedValue({ id: 1028, display_id: "P1028", status: "DEVELOP" });
		const res = await handlers.setMaturity({ id: "P1028", maturity: "obsolete", agent: "test-actor" });
		const text = res.content[0]?.text ?? "";
		expect(text).not.toMatch(/Invalid maturity/);
		expect(setMaturityMock).toHaveBeenCalledTimes(1);
		expect(setMaturityMock.mock.calls[0][1]).toBe("obsolete");
	});
});
