/**
 * P1389: MCP write-surface parameter fidelity — regression tests for the
 * silent-drop fixes, exercised through the REAL handlers (not placeholders).
 *
 * Covered fixes:
 * - prop_claim.message → claimLease persists {claim_message} in
 *   proposal_lease.metadata (migration 235)
 * - cubic_recycle.resetCode → false preserves phase/status, default resets
 * - list_reviews SELECT now projects is_blocking (write already worked)
 * - add_discussion author default to 'system' is PRESERVED (documented
 *   default for system-issued callers — P1389 review rejected converting it
 *   to a hard error)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query } from "../../../../postgres/pool.ts";
import { claimLease } from "../../../../infra/postgres/proposal-storage-v2.ts";
import { listReviews, addDiscussion } from "../rfc/pg-handlers.ts";
import { PgCubicHandlers } from "../cubic/pg-handlers.ts";

const LIVE = process.env.AGENTHIVE_ALLOW_LIVE_DB === "1";

describe.skipIf(!LIVE)("P1389: MCP write-surface parameter fidelity", () => {
	let testProposalId: number;
	const STAMP = `p1389-audit-${Date.now()}`;

	beforeAll(async () => {
		const { rows } = await query<{ id: number }>(
			`INSERT INTO roadmap_proposal.proposal
			 (display_id, title, status, type, maturity, project_id, audit)
			 VALUES ($1, $2, 'DRAFT', 'feature', 'new', 1, '[]'::jsonb)
			 RETURNING id`,
			[`P1389T${Date.now() % 100000}`, `P1389 fidelity test ${STAMP}`],
		);
		testProposalId = rows[0].id;
	});

	afterAll(async () => {
		if (!testProposalId) return;
		await query(`DELETE FROM roadmap_proposal.proposal_lease WHERE proposal_id = $1`, [testProposalId]);
		await query(`DELETE FROM roadmap_proposal.proposal_reviews WHERE proposal_id = $1`, [testProposalId]);
		await query(`DELETE FROM roadmap_proposal.proposal_discussions WHERE proposal_id = $1`, [testProposalId]);
		await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [testProposalId]);
	});

	it("BUG-1: claimLease persists claim message in proposal_lease.metadata", async () => {
		const ok = await claimLease(
			testProposalId,
			"system",
			new Date(Date.now() + 60_000),
			"claim rationale survives round-trip",
		);
		expect(ok).toBe(true);

		const { rows } = await query<{ metadata: { claim_message?: string } | null }>(
			`SELECT metadata FROM roadmap_proposal.proposal_lease
			 WHERE proposal_id = $1 AND agent_identity = $2
			 ORDER BY id DESC LIMIT 1`,
			[testProposalId, "system"],
		);
		expect(rows[0]?.metadata?.claim_message).toBe("claim rationale survives round-trip");
	});

	it("BUG-1b: claimLease without message still claims (metadata NULL)", async () => {
		// release BUG-1's active lease first — one active lease per proposal
		await query(
			`UPDATE roadmap_proposal.proposal_lease
			 SET released_at = now(), release_reason = 'work_delivered'
			 WHERE proposal_id = $1 AND released_at IS NULL`,
			[testProposalId],
		);
		const ok = await claimLease(testProposalId, "system", new Date(Date.now() + 60_000));
		expect(ok).toBe(true);
		const { rows } = await query<{ metadata: unknown }>(
			`SELECT metadata FROM roadmap_proposal.proposal_lease
			 WHERE proposal_id = $1 AND agent_identity = $2
			 ORDER BY id DESC LIMIT 1`,
			[testProposalId, "system"],
		);
		expect(rows[0]?.metadata ?? null).toBeNull();
	});

	it("BUG-2: cubic_recycle resetCode=false preserves phase/status", async () => {
		const cubicId = `${STAMP}-cubic`;
		await query(
			`INSERT INTO roadmap.cubics (cubic_id, phase, status) VALUES ($1, 'build', 'active')`,
			[cubicId],
		);
		try {
			const handlers = new PgCubicHandlers();
			const res = await handlers.recycleCubic({ cubicId, resetCode: false });
			expect(res.isError).not.toBe(true);
			const { rows } = await query<{ phase: string; status: string; metadata: { recycled?: boolean } }>(
				`SELECT phase, status, metadata FROM roadmap.cubics WHERE cubic_id = $1`,
				[cubicId],
			);
			expect(rows[0].phase).toBe("build");
			expect(rows[0].status).toBe("active");
			expect(rows[0].metadata?.recycled).toBe(true);

			const res2 = await handlers.recycleCubic({ cubicId });
			expect(res2.isError).not.toBe(true);
			const { rows: after } = await query<{ phase: string; status: string }>(
				`SELECT phase, status FROM roadmap.cubics WHERE cubic_id = $1`,
				[cubicId],
			);
			expect(after[0].phase).toBe("design");
			expect(after[0].status).toBe("idle");
		} finally {
			await query(`DELETE FROM roadmap.cubics WHERE cubic_id = $1`, [cubicId]);
		}
	});

	it("BUG-3: list_reviews projects is_blocking", async () => {
		// reviewer_identity has an FK to agent_registry — use a registered identity.
		const { rows: reg } = await query<{ agent_identity: string }>(
			`SELECT agent_identity FROM roadmap.agent_registry WHERE status = 'active' LIMIT 1`,
		);
		const reviewer = reg[0].agent_identity;
		await query(
			`INSERT INTO roadmap_proposal.proposal_reviews
			 (proposal_id, reviewer_identity, verdict, is_blocking)
			 VALUES ($1, $2, 'request_changes', true)`,
			[testProposalId, reviewer],
		);
		const res = await listReviews({ proposal_id: String(testProposalId) });
		const text = (res.content[0] as { text: string }).text;
		expect(text).toContain("is_blocking");
	});

	it("add_discussion: omitted author defaults to 'system' (documented default, not a drop)", async () => {
		const res = await addDiscussion({
			proposal_id: String(testProposalId),
			author: "",
			content: `author-default check ${STAMP}`,
		});
		expect(res.isError).not.toBe(true);
		const { rows } = await query<{ author_identity: string }>(
			`SELECT author_identity FROM roadmap_proposal.proposal_discussions
			 WHERE proposal_id = $1 ORDER BY id DESC LIMIT 1`,
			[testProposalId],
		);
		expect(rows[0].author_identity).toBe("system");
	});

	it("add_discussion: explicit author is honored verbatim", async () => {
		// author_identity has an FK to agent_registry — use a registered
		// identity distinct from 'system' to prove no silent defaulting.
		const { rows: reg } = await query<{ agent_identity: string }>(
			`SELECT agent_identity FROM roadmap.agent_registry
			 WHERE status = 'active' AND agent_identity <> 'system' LIMIT 1`,
		);
		const author = reg[0].agent_identity;
		const res = await addDiscussion({
			proposal_id: String(testProposalId),
			author,
			content: `explicit author check ${STAMP}`,
		});
		expect(res.isError).not.toBe(true);
		const { rows } = await query<{ author_identity: string }>(
			`SELECT author_identity FROM roadmap_proposal.proposal_discussions
			 WHERE proposal_id = $1 ORDER BY id DESC LIMIT 1`,
			[testProposalId],
		);
		expect(rows[0].author_identity).toBe(author);
	});
});
