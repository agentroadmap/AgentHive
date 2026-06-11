/**
 * P3001: add_discussion silently stored body='' behind a success ID.
 *
 * Root cause: the alias-coercion list in addDiscussion accepted
 * discussion/text/body/message but NOT note/notes/comment/summary — callers
 * passing `note:` fell through to `?? ""` and the handler inserted an empty
 * body while still returning "✅ Discussion #N added".
 *
 * Covers:
 * - AC-1: non-empty text via `note` (and other aliases) reaches `content`
 * - AC-2: empty/missing text is rejected with isError, nothing inserted
 * - AC-3 (live-gated): round-trip insert via `note` persists to
 *   proposal_discussions.body, asserted byte-for-byte
 */

import { describe, it, expect, afterAll } from "vitest";
import {
	addDiscussion,
	coerceDiscussionContent,
} from "../pg-handlers.ts";

// Live round-trip writes a real discussion row, so it is opt-in only —
// same convention as p1372-register-agency.test.ts (P2323 discussion #9731).
const LIVE = process.env.AGENTHIVE_ALLOW_LIVE_DB === "1";
const describeLive = describe.skipIf(!LIVE);

describe("P3001 coerceDiscussionContent", () => {
	it("prefers canonical content when present", () => {
		expect(
			coerceDiscussionContent({ content: "canonical", note: "alias" }),
		).toBe("canonical");
	});

	it.each([
		"discussion",
		"text",
		"body",
		"message",
		"note",
		"notes",
		"comment",
		"summary",
		"review",
	])("coerces %s alias into content", (alias) => {
		expect(coerceDiscussionContent({ [alias]: "via alias" })).toBe(
			"via alias",
		);
	});

	it("treats blank canonical content as missing and falls back to alias", () => {
		expect(coerceDiscussionContent({ content: "   ", note: "fallback" })).toBe(
			"fallback",
		);
	});

	it("ignores non-string alias values", () => {
		expect(coerceDiscussionContent({ note: 42, notes: { a: 1 } })).toBe("");
	});

	it("returns empty string when nothing usable is passed", () => {
		expect(coerceDiscussionContent({ proposal_id: "P3001" })).toBe("");
	});
});

describe("P3001 addDiscussion empty-body rejection (AC-2)", () => {
	// These paths return before resolveProposalId, so no DB is touched.
	it("rejects a call with no discussion text at all", async () => {
		const result = await addDiscussion({
			proposal_id: "P3001",
			author: "p3001-test",
			content: "",
		});
		expect(result.isError).toBe(true);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("rejected");
		expect(text).toContain("note");
		expect(text).toContain("Nothing was inserted");
	});

	it("rejects whitespace-only content", async () => {
		const result = await addDiscussion({
			proposal_id: "P3001",
			author: "p3001-test",
			content: "  \n\t ",
		});
		expect(result.isError).toBe(true);
	});

	it("rejects when only a non-string alias is passed", async () => {
		const result = await addDiscussion({
			proposal_id: "P3001",
			author: "p3001-test",
			content: "",
			note: 12345,
		} as any);
		expect(result.isError).toBe(true);
	});
});

describeLive("P3001 live round-trip (AC-3, AGENTHIVE_ALLOW_LIVE_DB=1)", () => {
	const insertedIds: number[] = [];
	const NOTE_TEXT =
		"P3001 regression round-trip: this exact text must persist to body. " +
		"Inserted by p3001-add-discussion-body.test.ts; safe to delete.";

	afterAll(async () => {
		if (!insertedIds.length) return;
		const { query } = await import("../../../../../postgres/pool.ts");
		await query(
			`DELETE FROM roadmap_proposal.proposal_discussions WHERE id = ANY($1::bigint[])`,
			[insertedIds],
		);
	});

	it("persists body when text arrives via `note` alias", async () => {
		const result = await addDiscussion({
			proposal_id: "P3001",
			author: "system",
			content: "",
			note: NOTE_TEXT,
		} as any);
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
		expect(rows[0].body).toBe(NOTE_TEXT);
	});
});
