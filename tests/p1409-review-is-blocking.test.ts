/**
 * P1409: submit_review must persist is_blocking faithfully
 *
 * The MCP submit_review handler used to declare no `is_blocking` arg, build
 * INSERT/UPDATE without the column, and let the DB default (false) take over.
 * Reviewers calling with is_blocking=true got success back; the row stayed
 * non-blocking. Same class as P1389 (silent input drops on MCP write surfaces).
 *
 * Coverage:
 * - INSERT path persists is_blocking=true
 * - INSERT path persists is_blocking=false (explicit)
 * - INSERT path defaults to false when omitted
 * - UPDATE path (re-submit by same reviewer) persists is_blocking
 * - UPDATE path can flip is_blocking back to false
 * - `blocking` alias is accepted as a fallback for `is_blocking`
 * - listReviews returns is_blocking in its SELECT and tags the line output
 * - review_submitted event payload includes is_blocking for audit
 * - findings JSON column round-trips (regression guard — already worked, kept here so
 *   the audit obligation in AC-4 has a permanent home and any future silent-drop
 *   regression fails immediately)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query } from "../src/postgres/pool.ts";
import { submitReview, listReviews } from "../src/apps/mcp-server/tools/rfc/pg-handlers.ts";

describe("P1409: submit_review is_blocking persistence", () => {
	let testProposalId: number;
	const reviewerInsertTrue = "p1409-rev-insert-true";
	const reviewerInsertFalse = "p1409-rev-insert-false";
	const reviewerOmitted = "p1409-rev-omitted";
	const reviewerUpdate = "p1409-rev-update";
	const reviewerAlias = "p1409-rev-alias";
	const reviewerFindings = "p1409-rev-findings";

	beforeAll(async () => {
		const { rows } = await query(
			`INSERT INTO roadmap_proposal.proposal (title, type, audit)
       VALUES ('P1409 is_blocking persistence test proposal', 'feature', '{}')
       RETURNING id`,
			[],
		);
		testProposalId = rows[0].id;
	});

	afterAll(async () => {
		// Remove the scratch proposal AND the reviewer fixture identities this suite
		// uses. submitReview auto-creates an agent_registry row per reviewer; without
		// cleaning them, these p1409-rev-* rows leak into the live registry on every
		// run (observed 2026-06-01). Delete reviews first (FK), then the agents.
		const reviewers = [
			reviewerInsertTrue,
			reviewerInsertFalse,
			reviewerOmitted,
			reviewerUpdate,
			reviewerAlias,
			reviewerFindings,
		];
		await query("DELETE FROM roadmap_proposal.proposal_reviews WHERE proposal_id = $1", [testProposalId]);
		await query("DELETE FROM roadmap_proposal.proposal WHERE id = $1", [testProposalId]);
		await query(
			"DELETE FROM roadmap_workforce.agent_registry WHERE agent_identity = ANY($1::text[])",
			[reviewers],
		);
	});

	async function readBlocking(reviewer: string): Promise<boolean | null> {
		const { rows } = await query(
			`SELECT is_blocking FROM roadmap_proposal.proposal_reviews
       WHERE proposal_id = $1 AND reviewer_identity = $2`,
			[testProposalId, reviewer],
		);
		return rows.length ? rows[0].is_blocking : null;
	}

	it("INSERT path persists is_blocking=true", async () => {
		const result = await submitReview({
			proposal_id: String(testProposalId),
			reviewer: reviewerInsertTrue,
			verdict: "request_changes",
			notes: "blocker test",
			is_blocking: true,
		});
		expect((result.content[0] as any).text).toContain("✅");
		expect((result.content[0] as any).text).toContain("[blocking]");
		expect(await readBlocking(reviewerInsertTrue)).toBe(true);
	});

	it("INSERT path persists is_blocking=false explicitly", async () => {
		await submitReview({
			proposal_id: String(testProposalId),
			reviewer: reviewerInsertFalse,
			verdict: "approve",
			notes: "non-blocking",
			is_blocking: false,
		});
		expect(await readBlocking(reviewerInsertFalse)).toBe(false);
	});

	it("INSERT path defaults is_blocking to false when omitted", async () => {
		await submitReview({
			proposal_id: String(testProposalId),
			reviewer: reviewerOmitted,
			verdict: "approve",
			notes: "no flag set",
		});
		expect(await readBlocking(reviewerOmitted)).toBe(false);
	});

	it("UPDATE path persists is_blocking flip on re-submission", async () => {
		// First submission: non-blocking
		await submitReview({
			proposal_id: String(testProposalId),
			reviewer: reviewerUpdate,
			verdict: "approve",
			notes: "first pass",
			is_blocking: false,
		});
		expect(await readBlocking(reviewerUpdate)).toBe(false);

		// Same reviewer re-submits with is_blocking=true (UPDATE branch)
		await submitReview({
			proposal_id: String(testProposalId),
			reviewer: reviewerUpdate,
			verdict: "request_changes",
			notes: "actually blocking",
			is_blocking: true,
		});
		expect(await readBlocking(reviewerUpdate)).toBe(true);

		// And back to false on next UPDATE
		await submitReview({
			proposal_id: String(testProposalId),
			reviewer: reviewerUpdate,
			verdict: "approve",
			notes: "resolved",
			is_blocking: false,
		});
		expect(await readBlocking(reviewerUpdate)).toBe(false);
	});

	it("`blocking` alias is accepted as a fallback for is_blocking", async () => {
		await submitReview({
			proposal_id: String(testProposalId),
			reviewer: reviewerAlias,
			verdict: "request_changes",
			notes: "alias test",
			blocking: true,
		});
		expect(await readBlocking(reviewerAlias)).toBe(true);
	});

	it("listReviews SELECT returns is_blocking and tags the line output", async () => {
		const result = await listReviews({ proposal_id: String(testProposalId) });
		const text = (result.content[0] as any).text;
		expect(text).toContain(`${reviewerInsertTrue}: request_changes [blocking]`);
		expect(text).toContain(`${reviewerInsertFalse}: approve`);
		expect(text).not.toContain(`${reviewerInsertFalse}: approve [blocking]`);
	});

	it("review_submitted event payload includes is_blocking", async () => {
		const { rows } = await query(
			`SELECT payload FROM roadmap_proposal.proposal_event
       WHERE proposal_id = $1 AND event_type = 'review_submitted'
       ORDER BY id DESC LIMIT 10`,
			[testProposalId],
		);
		expect(rows.length).toBeGreaterThan(0);
		const payloads = rows.map((r) => r.payload);
		// At least one payload from this test should be is_blocking=true
		expect(payloads.some((p) => p.is_blocking === true)).toBe(true);
		// At least one should be is_blocking=false
		expect(payloads.some((p) => p.is_blocking === false)).toBe(true);
	});

	it("findings JSON column round-trips through INSERT (AC-4 regression guard)", async () => {
		const findings = { severity: "high", tags: ["security", "data-loss"], count: 3 };
		await submitReview({
			proposal_id: String(testProposalId),
			reviewer: reviewerFindings,
			verdict: "request_changes",
			notes: "findings round-trip",
			findings,
		});
		const { rows } = await query(
			`SELECT findings, notes FROM roadmap_proposal.proposal_reviews
       WHERE proposal_id = $1 AND reviewer_identity = $2`,
			[testProposalId, reviewerFindings],
		);
		expect(rows.length).toBe(1);
		expect(rows[0].findings).toEqual(findings);
		expect(rows[0].notes).toBe("findings round-trip");
	});
});
