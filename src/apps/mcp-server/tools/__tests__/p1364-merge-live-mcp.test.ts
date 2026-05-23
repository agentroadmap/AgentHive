/**
 * P1364 MERGE-phase verification: addDiscussion empty-body rejection via live MCP.
 *
 * The unit tests (p1364-add-discussion-empty-body.test.ts) verify the handler
 * function directly. This integration test exercises the LIVE running MCP service
 * on http://127.0.0.1:6421/sse to prove the guard works end-to-end through the
 * SSE transport with a real client call.
 *
 * MCP service was restarted 2026-05-22 ~18:50 EDT with commit 6eb23831.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { query } from "../../../../infra/postgres/pool.ts";

const TEST_PROPOSAL_ID = 999810;
const MCP_URL = "http://127.0.0.1:6421/sse";

async function rowCountForTestProposal(): Promise<number> {
	const { rows } = await query<{ n: number }>(
		`SELECT count(*)::int AS n FROM roadmap_proposal.proposal_discussions
		 WHERE proposal_id = $1`,
		[TEST_PROPOSAL_ID],
	);
	return rows[0]?.n ?? 0;
}

async function createMcpClient(): Promise<Client> {
	const client = new Client({
		name: "p1364-test-client",
		version: "1.0.0",
	});

	const transport = new SSEClientTransport(new URL(MCP_URL));
	await client.connect(transport);
	return client;
}

async function callMcpAddDiscussion(
	client: Client,
	args: Record<string, unknown>,
): Promise<{ success: boolean; text: string }> {
	const result = await client.callTool({
		name: "add_discussion",
		arguments: args,
	});

	const text =
		result.content[0]?.type === "text" ? result.content[0].text : "";
	// Success = contains "Discussion #N added" (success path)
	// Failure = starts with "add_discussion:" or contains error indicators
	const success =
		/Discussion #\d+ added/.test(text) || (text.includes("✅") && !text.startsWith("add_discussion:"));
	return {
		success,
		text,
	};
}

describe("P1364: Live MCP add_discussion empty-body rejection", () => {
	beforeAll(async () => {
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
		// OVERRIDING SYSTEM VALUE to pin our test id.
		await query(
			`INSERT INTO roadmap_proposal.proposal
			  (id, display_id, type, title, status, maturity, audit)
			 OVERRIDING SYSTEM VALUE
			 VALUES ($1, $2, 'feature', 'P1364 MERGE live-mcp test', 'DRAFT', 'new', '[]'::jsonb)
			 ON CONFLICT (id) DO NOTHING`,
			[TEST_PROPOSAL_ID, `P${TEST_PROPOSAL_ID}`],
		);
	});

	afterAll(async () => {
		// Cleanup: delete any rows created in tests
		await query(
			`DELETE FROM roadmap_proposal.proposal_discussions WHERE proposal_id = $1`,
			[TEST_PROPOSAL_ID],
		);
		await query(
			`DELETE FROM roadmap_proposal.proposal WHERE id = $1`,
			[TEST_PROPOSAL_ID],
		);
	});

	it("AC-1: Live MCP rejects empty-body via SSE transport + no INSERT", async () => {
		const client = await createMcpClient();
		try {
			const before = await rowCountForTestProposal();

			const result = await callMcpAddDiscussion(client, {
				proposal_id: String(TEST_PROPOSAL_ID),
				author: "system",
				content: "",
			});

			const after = await rowCountForTestProposal();

			expect(result.success).toBe(false);
			expect(result.text).toContain("missing or empty body");
			expect(result.text).toContain("content");
			expect(result.text.toLowerCase()).toMatch(/discussion|text|body|message/);
			expect(after).toBe(before);
		} finally {
			await (client as any).close?.();
		}
	});

	it("AC-2: Live MCP rejects whitespace-only body + no INSERT", async () => {
		const client = await createMcpClient();
		try {
			const before = await rowCountForTestProposal();

			const result = await callMcpAddDiscussion(client, {
				proposal_id: String(TEST_PROPOSAL_ID),
				author: "system",
				content: "   \n\t  ",
			});

			const after = await rowCountForTestProposal();

			expect(result.success).toBe(false);
			expect(result.text).toContain("missing or empty body");
			expect(after).toBe(before);
		} finally {
			await (client as any).close?.();
		}
	});

	it("AC-3: Live MCP accepts valid body + INSERTs discussion row", async () => {
		const client = await createMcpClient();
		try {
			const before = await rowCountForTestProposal();

			const result = await callMcpAddDiscussion(client, {
				proposal_id: String(TEST_PROPOSAL_ID),
				author: "system",
				content: "real merge-phase test body for P1364 MERGE validation",
			});

			const after = await rowCountForTestProposal();

			expect(result.success).toBe(true);
			expect(result.text).toMatch(/Discussion #\d+ added/);
			expect(after).toBe(before + 1);

			// Verify the row was actually inserted
			const { rows } = await query<{ body: string }>(
				`SELECT body FROM roadmap_proposal.proposal_discussions WHERE proposal_id = $1 ORDER BY id DESC LIMIT 1`,
				[TEST_PROPOSAL_ID],
			);
			expect(rows[0]?.body).toBe(
				"real merge-phase test body for P1364 MERGE validation",
			);
		} finally {
			await (client as any).close?.();
		}
	});

	it("AC-4: Live MCP accepts alias 'body' after coercion + INSERTs", async () => {
		const client = await createMcpClient();
		try {
			const before = await rowCountForTestProposal();

			const result = await callMcpAddDiscussion(client, {
				proposal_id: String(TEST_PROPOSAL_ID),
				author: "system",
				content: "",
				body: "content via alias 'body' field should be accepted",
			});

			const after = await rowCountForTestProposal();

			expect(result.success).toBe(true);
			expect(result.text).toMatch(/Discussion #\d+ added/);
			expect(after).toBe(before + 1);

			// Verify the row was actually inserted with alias content
			const { rows } = await query<{ body: string }>(
				`SELECT body FROM roadmap_proposal.proposal_discussions WHERE proposal_id = $1 ORDER BY id DESC LIMIT 1`,
				[TEST_PROPOSAL_ID],
			);
			expect(rows[0]?.body).toBe(
				"content via alias 'body' field should be accepted",
			);
		} finally {
			await (client as any).close?.();
		}
	});

	it("AC-5: Live MCP rejects invalid proposal_id + no INSERT", async () => {
		const client = await createMcpClient();
		try {
			const before = await rowCountForTestProposal();

			const result = await callMcpAddDiscussion(client, {
				proposal_id: "999999", // Non-existent proposal
				author: "system",
				content: "real content but proposal does not exist",
			});

			const after = await rowCountForTestProposal();

			expect(result.success).toBe(false);
			expect(result.text).toContain("not found");
			expect(after).toBe(before);
		} finally {
			await (client as any).close?.();
		}
	});
});
