/**
 * P1364: addDiscussion empty-body validation.
 *
 * The MCP addDiscussion handler historically accepted missing or empty body
 * args by coercing through aliases to "" and INSERTing anyway. Result: 5+
 * empty-body discussion rows observed between 2026-05-20 and 2026-05-22 that
 * looked like agent fabrications (agent claimed "added discussion #N" but
 * the row had no content).
 *
 * This test verifies the validation guard: empty/whitespace-only body returns
 * a clear error and DOES NOT INSERT.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { query } from "../../../../infra/postgres/pool.ts";
import { addDiscussion } from "../rfc/pg-handlers.ts";

const TEST_PROPOSAL_ID = 999800;

async function rowCountForTestProposal(): Promise<number> {
	const { rows } = await query<{ n: number }>(
		`SELECT count(*)::int AS n FROM roadmap_proposal.proposal_discussions
		 WHERE proposal_id = $1`,
		[TEST_PROPOSAL_ID],
	);
	return rows[0]?.n ?? 0;
}

describe("P1364: addDiscussion rejects empty/whitespace body", () => {
	beforeEach(async () => {
		// Clean any stale rows from prior runs
		await query(
			`DELETE FROM roadmap_proposal.proposal_discussions WHERE proposal_id = $1`,
			[TEST_PROPOSAL_ID],
		);
		await query(
			`DELETE FROM roadmap_proposal.proposal WHERE id = $1`,
			[TEST_PROPOSAL_ID],
		);
		// Seed a real proposal so resolveProposalId returns a numeric id.
		// roadmap_proposal.proposal.id is GENERATED ALWAYS AS IDENTITY, so use
		// OVERRIDING SYSTEM VALUE to pin our test id and avoid sequence collision.
		await query(
			`INSERT INTO roadmap_proposal.proposal
			  (id, display_id, type, title, status, maturity, audit)
			 OVERRIDING SYSTEM VALUE
			 VALUES ($1, $2, 'feature', 'P1364 test proposal', 'DRAFT', 'new', '[]'::jsonb)
			 ON CONFLICT (id) DO NOTHING`,
			[TEST_PROPOSAL_ID, `P${TEST_PROPOSAL_ID}`],
		);
	});

	afterEach(async () => {
		await query(
			`DELETE FROM roadmap_proposal.proposal_discussions WHERE proposal_id = $1`,
			[TEST_PROPOSAL_ID],
		);
		await query(
			`DELETE FROM roadmap_proposal.proposal WHERE id = $1`,
			[TEST_PROPOSAL_ID],
		);
	});

	it("AC-1: missing body returns clear error + no INSERT", async () => {
		const before = await rowCountForTestProposal();
		const result = await addDiscussion({
			proposal_id: String(TEST_PROPOSAL_ID),
			author: "system",
			content: "",
		});
		const after = await rowCountForTestProposal();

		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("missing or empty body");
		expect(text).toContain("content");
		// Mentions at least one alias so the agent can self-correct
		expect(text.toLowerCase()).toMatch(/discussion|text|body|message/);
		expect(after).toBe(before);
	});

	it("AC-2: explicit empty-string body returns clear error + no INSERT", async () => {
		const before = await rowCountForTestProposal();
		const result = await addDiscussion({
			proposal_id: String(TEST_PROPOSAL_ID),
			author: "system",
			content: "",
		});
		const after = await rowCountForTestProposal();

		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("missing or empty body");
		expect(after).toBe(before);
	});

	it("AC-3: whitespace-only body rejected after trim", async () => {
		const before = await rowCountForTestProposal();
		const result = await addDiscussion({
			proposal_id: String(TEST_PROPOSAL_ID),
			author: "system",
			content: "   \n\t  ",
		});
		const after = await rowCountForTestProposal();

		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("missing or empty body");
		expect(after).toBe(before);
	});

	it("AC-4: 1-char body passes (validation is empty/whitespace only)", async () => {
		const before = await rowCountForTestProposal();
		const result = await addDiscussion({
			proposal_id: String(TEST_PROPOSAL_ID),
			author: "system",
			content: "x",
		});
		const after = await rowCountForTestProposal();

		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toMatch(/Discussion #\d+ added/);
		expect(after).toBe(before + 1);

		const { rows } = await query<{ body: string }>(
			`SELECT body FROM roadmap_proposal.proposal_discussions WHERE proposal_id = $1 ORDER BY id DESC LIMIT 1`,
			[TEST_PROPOSAL_ID],
		);
		expect(rows[0]?.body).toBe("x");
	});

	it("AC-5: alias 'body' supplies content + INSERTs", async () => {
		const before = await rowCountForTestProposal();
		const result = await addDiscussion({
			proposal_id: String(TEST_PROPOSAL_ID),
			author: "system",
			content: "",
			body: "real content via alias",
		});
		const after = await rowCountForTestProposal();

		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toMatch(/Discussion #\d+ added/);
		expect(after).toBe(before + 1);

		const { rows } = await query<{ body: string }>(
			`SELECT body FROM roadmap_proposal.proposal_discussions WHERE proposal_id = $1 ORDER BY id DESC LIMIT 1`,
			[TEST_PROPOSAL_ID],
		);
		expect(rows[0]?.body).toBe("real content via alias");
	});
});
