/**
 * P1131 — Gate-review cluster alarm smoke test (AC-6, AC-7)
 *
 * Verifies that the tg_proposal_review_cluster_detect trigger:
 *   - emits pg_notify('control_feed', ...) with event_type='gate_review_cluster'
 *     exactly once when the 3rd approve is inserted (AC-6)
 *   - emits a second notify at the 6th approve, not before (AC-7)
 *   - does NOT emit on non-approve verdicts
 *
 * Requires a live Postgres connection (same convention as a2a-cross-process.test.ts).
 * Uses a synthetic reviewer identity stamped with Date.now() to avoid collisions.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";

const STAMP = Date.now();
const TEST_REVIEWER = `test-cluster-alarm-${STAMP}`;

// Minimal test proposal: reuse the lowest-id proposal available.
// If none exists the test is skipped cleanly.

function makePgClient(): Client {
	return new Client({
		host: process.env.PGHOST ?? "127.0.0.1",
		port: Number(process.env.PGPORT ?? "5432"),
		user: process.env.PGUSER,
		database: process.env.PGDATABASE ?? "agenthive",
	});
}

async function getTestProposalId(client: Client): Promise<number | null> {
	const res = await client.query<{ id: number }>(
		"SELECT id FROM roadmap_proposal.proposal ORDER BY id LIMIT 1",
	);
	return res.rows[0]?.id ?? null;
}

async function insertReview(
	client: Client,
	proposalId: number,
	verdict: "approve" | "request_changes" | "reject",
): Promise<void> {
	await client.query(
		`INSERT INTO roadmap_proposal.proposal_reviews
		   (proposal_id, reviewer_identity, verdict, notes, reviewed_at)
		 VALUES ($1, $2, $3, 'cluster-alarm smoke test', now())`,
		[proposalId, TEST_REVIEWER, verdict],
	);
}

async function collectNotifies(
	listenClient: Client,
	timeoutMs: number,
): Promise<string[]> {
	return new Promise((resolve) => {
		const collected: string[] = [];
		const timer = setTimeout(() => resolve(collected), timeoutMs);
		listenClient.on("notification", (msg) => {
			if (msg.channel === "control_feed" && msg.payload) {
				try {
					const parsed = JSON.parse(msg.payload);
					if (
						parsed.event_type === "gate_review_cluster" &&
						parsed.reviewer_identity === TEST_REVIEWER
					) {
						collected.push(msg.payload);
					}
				} catch {
					// not JSON — ignore
				}
			}
		});
		// Clear timer eagerly once we have enough (2) notifications.
		const earlyCheck = setInterval(() => {
			if (collected.length >= 2) {
				clearInterval(earlyCheck);
				clearTimeout(timer);
				resolve(collected);
			}
		}, 50);
	});
}

describe("P1131 cluster-alarm trigger", async () => {
	let writeClient: Client;
	let listenClient: Client;
	let proposalId: number;

	before(async () => {
		writeClient = makePgClient();
		listenClient = makePgClient();
		await writeClient.connect();
		await listenClient.connect();
		await listenClient.query("LISTEN control_feed");

		const id = await getTestProposalId(writeClient);
		if (id === null) {
			throw new Error("No proposals in DB — cannot run cluster-alarm smoke test");
		}
		proposalId = id;
	});

	after(async () => {
		// Clean up synthetic rows so they don't pollute prod queries.
		await writeClient
			.query(
				"DELETE FROM roadmap_proposal.proposal_reviews WHERE reviewer_identity = $1",
				[TEST_REVIEWER],
			)
			.catch(() => {});
		await writeClient.end().catch(() => {});
		await listenClient.end().catch(() => {});
	});

	it("emits no notify for non-approve verdict", async () => {
		// Set up a short-window collector before the INSERT.
		const collecting = collectNotifies(listenClient, 400);
		await insertReview(writeClient, proposalId, "request_changes");
		const notifies = await collecting;
		assert.strictEqual(notifies.length, 0, "should not notify on request_changes");
	});

	it("emits no notify for first and second approve", async () => {
		const collecting = collectNotifies(listenClient, 400);
		await insertReview(writeClient, proposalId, "approve"); // count = 1
		await insertReview(writeClient, proposalId, "approve"); // count = 2
		const notifies = await collecting;
		assert.strictEqual(notifies.length, 0, "should not notify below threshold");
	});

	it("emits exactly one notify at the 3rd approve (AC-6)", async () => {
		const collectingP = collectNotifies(listenClient, 600);
		await insertReview(writeClient, proposalId, "approve"); // count = 3 → alert
		const notifies = await collectingP;
		assert.strictEqual(notifies.length, 1, "should emit exactly one notify at count=3");

		const parsed = JSON.parse(notifies[0]!);
		assert.strictEqual(parsed.event_type, "gate_review_cluster");
		assert.strictEqual(parsed.reviewer_identity, TEST_REVIEWER);
		assert.ok(parsed.approve_count >= 3, "approve_count should be >= 3");
		assert.strictEqual(parsed.window_seconds, 60);
		assert.ok(parsed.latest_proposal_id, "latest_proposal_id should be set");
	});

	it("emits no notify at 4th and 5th approve (AC-7 between milestones)", async () => {
		const collecting = collectNotifies(listenClient, 400);
		await insertReview(writeClient, proposalId, "approve"); // count = 4
		await insertReview(writeClient, proposalId, "approve"); // count = 5
		const notifies = await collecting;
		assert.strictEqual(notifies.length, 0, "should not notify at counts 4 and 5");
	});

	it("emits exactly one notify at the 6th approve (AC-7 second milestone)", async () => {
		const collectingP = collectNotifies(listenClient, 600);
		await insertReview(writeClient, proposalId, "approve"); // count = 6 → alert
		const notifies = await collectingP;
		assert.strictEqual(notifies.length, 1, "should emit exactly one notify at count=6");
		const parsed = JSON.parse(notifies[0]!);
		assert.ok(parsed.approve_count >= 6, "approve_count should be >= 6");
	});
});
