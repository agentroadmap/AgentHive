import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { query } from "../../src/infra/db.ts";
import { setupTestDb } from "../support/db-setup.ts";

// ─── P1409: Verify is_blocking and comment round-trip through submit_review ────

describe("P1409: proposal_reviews is_blocking and comment fields", () => {
	let testProposalId: number;
	let testReviewerId: string;

	beforeEach(async () => {
		await setupTestDb();

		// Create test proposal
		const { rows: proposalRows } = await query(
			`INSERT INTO roadmap_proposal.proposal (title, description, state)
       VALUES ('P1409 Test', 'Testing is_blocking field', 'draft')
       RETURNING id`,
		);
		testProposalId = proposalRows[0].id;

		// Register test reviewer agent
		testReviewerId = "p1409-test-reviewer";
		await query(
			`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, role, skills, status)
       VALUES ($1, 'llm', 'reviewer', '["review"]'::jsonb, 'active')
       ON CONFLICT (agent_identity) DO NOTHING`,
			[testReviewerId],
		);
	});

	afterEach(async () => {
		// Cleanup test data
		await query(
			`DELETE FROM roadmap_proposal.proposal_reviews WHERE proposal_id = $1`,
			[testProposalId],
		);
		await query(
			`DELETE FROM roadmap_proposal.proposal WHERE id = $1`,
			[testProposalId],
		);
	});

	it("INSERT: is_blocking=true persists to the database", async () => {
		const isBlockingValue = true;
		const { rows: inserted } = await query(
			`INSERT INTO roadmap_proposal.proposal_reviews
       (proposal_id, reviewer_identity, verdict, is_blocking)
       VALUES ($1, $2, $3, $4)
       RETURNING id, is_blocking`,
			[testProposalId, testReviewerId, "request_changes", isBlockingValue],
		);

		assert.strictEqual(inserted.length, 1, "Should insert exactly one review");
		assert.strictEqual(
			inserted[0].is_blocking,
			true,
			"is_blocking should be true",
		);
	});

	it("INSERT: comment field persists to the database", async () => {
		const testComment = "This change requires additional validation.";
		const { rows: inserted } = await query(
			`INSERT INTO roadmap_proposal.proposal_reviews
       (proposal_id, reviewer_identity, verdict, comment)
       VALUES ($1, $2, $3, $4)
       RETURNING id, comment`,
			[testProposalId, testReviewerId, "request_changes", testComment],
		);

		assert.strictEqual(inserted.length, 1, "Should insert exactly one review");
		assert.strictEqual(
			inserted[0].comment,
			testComment,
			"comment should match input",
		);
	});

	it("INSERT: both is_blocking and comment together", async () => {
		const testComment = "Blocking review with comment.";
		const isBlockingValue = true;

		const { rows: inserted } = await query(
			`INSERT INTO roadmap_proposal.proposal_reviews
       (proposal_id, reviewer_identity, verdict, is_blocking, comment)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, is_blocking, comment`,
			[testProposalId, testReviewerId, "reject", isBlockingValue, testComment],
		);

		assert.strictEqual(inserted.length, 1, "Should insert exactly one review");
		assert.strictEqual(
			inserted[0].is_blocking,
			true,
			"is_blocking should be true",
		);
		assert.strictEqual(
			inserted[0].comment,
			testComment,
			"comment should match input",
		);
	});

	it("UPDATE: is_blocking can be updated", async () => {
		// Insert with is_blocking=false
		const { rows: initialRows } = await query(
			`INSERT INTO roadmap_proposal.proposal_reviews
       (proposal_id, reviewer_identity, verdict, is_blocking)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
			[testProposalId, testReviewerId, "approve", false],
		);

		const reviewId = initialRows[0].id;

		// Update to is_blocking=true
		await query(
			`UPDATE roadmap_proposal.proposal_reviews
       SET is_blocking = $1
       WHERE id = $2`,
			[true, reviewId],
		);

		// Verify update
		const { rows: updated } = await query(
			`SELECT is_blocking FROM roadmap_proposal.proposal_reviews WHERE id = $1`,
			[reviewId],
		);

		assert.strictEqual(updated[0].is_blocking, true, "is_blocking should be updated to true");
	});

	it("UPDATE: comment can be updated", async () => {
		// Insert with empty comment
		const { rows: initialRows } = await query(
			`INSERT INTO roadmap_proposal.proposal_reviews
       (proposal_id, reviewer_identity, verdict, comment)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
			[testProposalId, testReviewerId, "approve_with_changes", null],
		);

		const reviewId = initialRows[0].id;
		const newComment = "Updated comment after re-review.";

		// Update comment
		await query(
			`UPDATE roadmap_proposal.proposal_reviews
       SET comment = $1
       WHERE id = $2`,
			[newComment, reviewId],
		);

		// Verify update
		const { rows: updated } = await query(
			`SELECT comment FROM roadmap_proposal.proposal_reviews WHERE id = $1`,
			[reviewId],
		);

		assert.strictEqual(updated[0].comment, newComment, "comment should be updated");
	});
});
