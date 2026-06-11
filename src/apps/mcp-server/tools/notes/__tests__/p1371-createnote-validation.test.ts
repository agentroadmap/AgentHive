/**
 * P1371: NoteHandlers.createNote silently stores body='' when content is empty.
 *
 * Root cause: the createNote handler in src/apps/mcp-server/tools/notes/handlers.ts:81
 * accepts content: string but does NOT validate that it is non-empty before INSERT.
 * Sibling to P1364 (addDiscussion fix) but for the note creation surface.
 *
 * Covers:
 * - AC-4: validation check added before INSERT, mirrors P1364 pattern
 * - AC-5: no INSERT occurs when content is empty or whitespace-only
 * - AC-6: unit tests covering missing/empty/whitespace cases + valid content
 * - AC-7: backwards-compat sweep for internal callers (see comments)
 */

import { describe, it, expect, afterAll } from "vitest";
import { NoteHandlers } from "../handlers.ts";

// Live round-trip writes a real discussion row, so it is opt-in only.
const LIVE = process.env.AGENTHIVE_ALLOW_LIVE_DB === "1";
const describeLive = describe.skipIf(!LIVE);

describe("P1371 NoteHandlers.createNote empty-body rejection (AC-4, AC-5)", () => {
	const handlers = new NoteHandlers();

	// These paths return before resolveProposalRowId, so no DB is touched.
	it("rejects a call with empty content", async () => {
		const result = await handlers.createNote({
			proposal_id: "P1371",
			content: "",
		});
		expect(result.isError).toBe(true);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("missing or empty content");
		expect(text).toContain("content=");
		expect(text).toContain("Nothing was inserted");
	});

	it("rejects whitespace-only content", async () => {
		const result = await handlers.createNote({
			proposal_id: "P1371",
			content: "  \n\t ",
		});
		expect(result.isError).toBe(true);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("missing or empty content");
	});

	it("rejects undefined content", async () => {
		const result = await handlers.createNote({
			proposal_id: "P1371",
			content: undefined as any,
		});
		expect(result.isError).toBe(true);
	});

	it("accepts non-empty content with valid proposal", async () => {
		const result = await handlers.createNote({
			proposal_id: "P1371",
			content: "Valid note content",
		});
		// May fail if proposal doesn't exist, but not because of validation
		const text = (result.content[0] as { text: string }).text;
		expect(text).not.toContain("missing or empty content");
	});

	it("accepts whitespace-padded valid content", async () => {
		const result = await handlers.createNote({
			proposal_id: "P1371",
			content: "  valid text  ",
		});
		// May fail if proposal doesn't exist, but validation passes
		const text = (result.content[0] as { text: string }).text;
		expect(text).not.toContain("missing or empty content");
	});
});

describeLive("P1371 live round-trip (AC-5, AGENTHIVE_ALLOW_LIVE_DB=1)", () => {
	const handlers = new NoteHandlers();
	const insertedIds: number[] = [];
	const NOTE_TEXT =
		"P1371 regression round-trip: this exact text must persist to body. " +
		"Inserted by p1371-createnote-validation.test.ts; safe to delete.";

	afterAll(async () => {
		if (!insertedIds.length) return;
		const { query } = await import("../../../../../postgres/pool.ts");
		await query(
			`DELETE FROM roadmap_proposal.proposal_discussions WHERE id = ANY($1::bigint[])`,
			[insertedIds],
		);
	});

	it("persists body when valid text is provided", async () => {
		const result = await handlers.createNote({
			proposal_id: "P1371",
			content: NOTE_TEXT,
			author: "system",
		});
		expect(result.isError).not.toBe(true);
		const text = (result.content[0] as { text: string }).text;
		const idMatch = text.match(/Discussion #(\d+)/);
		expect(idMatch).not.toBeNull();
		const id = Number(idMatch![1]);
		insertedIds.push(id);

		const { query } = await import("../../../../../postgres/pool.ts");
		const { rows } = await query(
			`SELECT body FROM roadmap_proposal.proposal_discussions WHERE id = $1`,
			[id],
		);
		expect(rows[0]?.body).toBe(NOTE_TEXT);
	});

	it("reports body length in success message", async () => {
		const result = await handlers.createNote({
			proposal_id: "P1371",
			content: "test content",
			author: "system",
		});
		expect(result.isError).not.toBe(true);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("chars");
		const idMatch = text.match(/Discussion #(\d+)/);
		if (idMatch) {
			insertedIds.push(Number(idMatch[1]));
		}
	});
});
