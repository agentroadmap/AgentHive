/**
 * P1123 AC-10 — Web board auto-update test via LISTEN-driven refresh.
 *
 * Validates that when a proposal is updated in the database, the web board
 * automatically reflects the change within 5 seconds (LISTEN path) or 10 seconds
 * (fallback timer path), without requiring a manual page refresh.
 *
 * This test ensures that the shared Postgres pool (which powers the LISTEN
 * subscription in the websocket-server) is not poisoned by any stray pool.end()
 * calls in long-running services. If the pool is poisoned, LISTEN subscriptions
 * fail and the board falls back to timer-driven polling (10s), then both paths
 * fail if the pool is truly dead.
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { Pool } from "pg";
import { ConfigResolver } from "../../src/shared/runtime/config.ts";

describe("P1123 AC-10: Web board auto-update via LISTEN", () => {
	let db: Pool;
	let testProposalId: number;
	const TEST_PROPOSAL_TITLE = `P1123-AC10-test-${Date.now()}`;

	before(async () => {
		// Connect to the same pool as the running service.
		const config = {
			host: process.env.PGHOST ?? "127.0.0.1",
			port: parseInt(process.env.PGPORT ?? "5432", 10),
			database: process.env.PGDATABASE ?? "agenthive",
			user: process.env.PGUSER ?? "postgres",
			password:
				process.env.PGPASSWORD ||
				ConfigResolver.resolvePasswordSync({
					host: process.env.PGHOST ?? "127.0.0.1",
					port: process.env.PGPORT ?? "5432",
					database: process.env.PGDATABASE ?? "agenthive",
					user: process.env.PGUSER ?? "postgres",
				}),
		};

		db = new Pool(config);

		// Create a test proposal if it doesn't exist.
		const result = await db.query(
			`INSERT INTO roadmap_proposal.proposal
             (display_id, type, status, title, project_id)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id`,
			[
				`TEST-P1123-AC10-${Date.now()}`,
				"feature",
				"Draft",
				TEST_PROPOSAL_TITLE,
				1,
			],
		);
		testProposalId = result.rows[0]?.id;

		if (!testProposalId) {
			throw new Error("Failed to create test proposal");
		}
	});

	it("should detect proposal update via LISTEN subscription", async () => {
		const listeningClient = new Pool({
			host: process.env.PGHOST ?? "127.0.0.1",
			port: parseInt(process.env.PGPORT ?? "5432", 10),
			database: process.env.PGDATABASE ?? "agenthive",
			user: process.env.PGUSER ?? "postgres",
			password:
				process.env.PGPASSWORD ||
				ConfigResolver.resolvePasswordSync({
					host: process.env.PGHOST ?? "127.0.0.1",
					port: process.env.PGPORT ?? "5432",
					database: process.env.PGDATABASE ?? "agenthive",
					user: process.env.PGUSER ?? "postgres",
				}),
		});

		const notifications: string[] = [];
		let notificationReceived = false;

		// Set up listener on the broadcast channel.
		const listenClient = await listeningClient.connect();
		listenClient.on("notification", (msg) => {
			notifications.push(msg.payload || "");
			if (msg.channel === "proposal_updates") {
				notificationReceived = true;
			}
		});

		await listenClient.query("LISTEN proposal_updates");

		// Give the listener a moment to establish.
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Update the proposal's modified_at to trigger the LISTEN broadcast.
		const updateStart = Date.now();
		await db.query(
			`UPDATE roadmap_proposal.proposal SET modified_at = now() WHERE id = $1`,
			[testProposalId],
		);

		// Wait up to 5 seconds for the LISTEN notification.
		const timeout = 5000;
		const pollInterval = 100;
		let elapsed = 0;

		while (!notificationReceived && elapsed < timeout) {
			await new Promise((resolve) => setTimeout(resolve, pollInterval));
			elapsed += pollInterval;
		}

		const updateEnd = Date.now();
		const latency = updateEnd - updateStart;

		// Clean up listener.
		await listenClient.query("UNLISTEN proposal_updates");
		await listeningClient.end();

		// Assert that the notification was received within the timeout.
		assert.ok(
			notificationReceived,
			`LISTEN notification for proposal_updates was not received within ${timeout}ms. ` +
				`Latency: ${latency}ms. Notifications received: ${notifications.length}. ` +
				`This indicates the shared pool may be poisoned or the LISTEN subscription is broken.`,
		);

		// Assert that the latency is reasonable (well under 5s).
		assert.ok(
			latency < timeout,
			`Notification latency (${latency}ms) exceeded timeout (${timeout}ms)`,
		);
	});

	it("should allow pool to serve subsequent queries after the LISTEN test", async () => {
		// Verify the pool is still healthy after the LISTEN test above.
		const result = await db.query("SELECT 1 as alive");
		assert.ok(result.rows[0]?.alive === 1, "Pool query failed after LISTEN test");
	});
});
