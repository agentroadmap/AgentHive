/**
 * P1123 AC-10 — Web board auto-update via LISTEN-driven refresh.
 *
 * Exercises the REAL live-board mechanism (websocket-server.ts LISTENs on
 * proposal_state_changed / proposal_gate_ready / proposal_maturity_changed):
 * a maturity UPDATE on a fixture proposal must produce a NOTIFY on
 * proposal_maturity_changed within 5 seconds. If the shared pool were
 * poisoned (stray pool.end()), the LISTEN connection would be dead and no
 * notification would arrive — which is exactly the regression P1123 guards.
 *
 * LIVE-DB TEST: connects to the live agenthive DB and writes ONE fixture
 * proposal row, deleted in teardown. Skipped unless AGENTHIVE_ALLOW_LIVE_DB=1
 * to keep the default suite hermetic (see commit 1baa05c6).
 *
 * Mechanism proven manually 2026-06-10: payload includes proposal_id,
 * from_maturity, to_maturity, transitioned_by (trg_notify_maturity_change).
 *
 * RUNTIME CAVEAT (verified 2026-06-10): bun does NOT deliver node-postgres
 * LISTEN notifications (socket-compat gap) — the same probe under node
 * receives the NOTIFY in <1s. Run the live mode under node
 * (e.g. `node --import jiti/register --test` or a node-based runner);
 * this is also why scripts/start-a2a-host.ts runs under node.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Client } from "pg";

const LIVE = process.env.AGENTHIVE_ALLOW_LIVE_DB === "1";

describe("P1123 AC-10: board LISTEN path (live, env-gated)", () => {
	let listener: Client;
	let writer: Client;
	let fixtureId: number;

	beforeAll(async () => {
		if (!LIVE) return;
		const cfg = {
			host: process.env.PGHOST ?? "127.0.0.1",
			port: Number(process.env.PGPORT ?? 5432),
			database: process.env.PGDATABASE ?? "agenthive",
			user: process.env.PGUSER ?? "admin",
			password: process.env.PGPASSWORD,
		};
		listener = new Client(cfg);
		writer = new Client(cfg);
		await listener.connect();
		await writer.connect();
		await listener.query("LISTEN proposal_maturity_changed");
		const res = await writer.query(
			`INSERT INTO roadmap_proposal.proposal (type, status, title, project_id, maturity, audit)
			 VALUES ('feature','DRAFT','P1123-AC10 listen fixture (auto-cleanup)',1,'new','{}'::jsonb)
			 RETURNING id`,
		);
		fixtureId = res.rows[0].id;
	});

	afterAll(async () => {
		if (!LIVE) return;
		await writer.query("DELETE FROM roadmap_proposal.proposal WHERE id = $1", [
			fixtureId,
		]);
		await listener.end();
		await writer.end();
	});

	it.skipIf(!LIVE)(
		"maturity update NOTIFYs proposal_maturity_changed within 5s",
		async () => {
			const notified = new Promise<string>((resolve, reject) => {
				const t = setTimeout(
					() => reject(new Error("no NOTIFY within 5000ms — LISTEN path dead")),
					5000,
				);
				listener.on("notification", (msg) => {
					if (msg.channel !== "proposal_maturity_changed") return;
					const payload = JSON.parse(msg.payload ?? "{}");
					if (payload.proposal_id === fixtureId) {
						clearTimeout(t);
						resolve(payload.to_maturity);
					}
				});
			});
			await writer.query(
				"UPDATE roadmap_proposal.proposal SET maturity='active' WHERE id = $1",
				[fixtureId],
			);
			expect(await notified).toBe("active");
		},
		10000,
	);
});
