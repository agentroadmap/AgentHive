import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runMonitorCycle } from "../../src/core/schema-drift/monitor.ts";
import { extractDriftHits, fingerprintHit } from "../../src/core/schema-drift/parse.ts";

/**
 * In-memory stand-ins for `pg.Pool` and the proposal creator. Each test
 * builds one fresh so we never share state.
 */

interface FakeRow {
	fingerprint: string;
	occurrence_count: number;
	first_seen: Date;
	last_seen: Date;
	hotfix_proposal_id: string | null;
	resolved_at: Date | null;
	last_escalated_at: Date | null;
}

function makeFakePool(seed: Map<string, FakeRow> = new Map()) {
	const inserts: Array<{ fingerprint: string; row: FakeRow }> = [];
	const escalations: any[] = [];

	const pool: any = {
		query: async (text: string, params: any[] = []) => {
			if (/SELECT fingerprint, occurrence_count/i.test(text)) {
				const fp = params[0] as string;
				const row = seed.get(fp);
				return { rows: row ? [row] : [] };
			}
			if (/INSERT INTO roadmap.schema_drift_seen/i.test(text)) {
				const [fingerprint, , , , hotfixId] = params;
				const row: FakeRow = {
					fingerprint,
					occurrence_count: 1,
					first_seen: new Date(),
					last_seen: new Date(),
					hotfix_proposal_id: hotfixId ? String(hotfixId) : null,
					resolved_at: null,
					last_escalated_at: null,
				};
				seed.set(fingerprint, row);
				inserts.push({ fingerprint, row });
				return { rows: [] };
			}
			if (/UPDATE roadmap.schema_drift_seen.*occurrence_count = occurrence_count \+ 1/is.test(text)) {
				const fp = params[0] as string;
				const r = seed.get(fp);
				if (r) {
					r.occurrence_count++;
					r.last_seen = new Date();
				}
				return { rows: [] };
			}
			if (/UPDATE roadmap.schema_drift_seen.*last_escalated_at/is.test(text)) {
				const fp = params[0] as string;
				const r = seed.get(fp);
				if (r) r.last_escalated_at = new Date();
				return { rows: [] };
			}
			if (/INSERT INTO roadmap.notification_queue/i.test(text)) {
				escalations.push({ proposal_id: params[0], title: params[1], body: params[2] });
				return { rows: [] };
			}
			throw new Error(`unexpected query: ${text.slice(0, 80)}`);
		},
	};
	return { pool, inserts, escalations, seed };
}

describe("runMonitorCycle", () => {
	it("first occurrence files a hotfix and inserts a seen-row", async () => {
		const { pool, inserts, escalations } = makeFakePool();

		const log = `Apr 28 07:00:00 bot node[1]: Error listing routes: column "cost_per_1k_input" does not exist`;
		const filed: any[] = [];

		const result = await runMonitorCycle({
			pool,
			repoRoot: "/tmp/r",
			scrape: () => log,
			exec: () => "",
			createHotfixProposal: async (args) => {
				filed.push(args);
				return { id: 999, displayId: "P999" };
			},
			log: () => {},
			warn: () => {},
		});

		assert.equal(result.uniqueFingerprints, 1);
		assert.equal(result.newHotfixes, 1);
		assert.equal(result.repeats, 0);
		assert.equal(result.escalations, 0);
		assert.equal(filed.length, 1);
		assert.equal(filed[0].missingName, "cost_per_1k_input");
		assert.equal(inserts.length, 1);
		assert.equal(escalations.length, 0);
	});

	it("repeat occurrence below threshold bumps counter without escalating", async () => {
		const seen = new Map<string, FakeRow>();
		// Use real parsing to compute the fingerprint
		const log = `Error: SELECT cost_per_1k_input FROM model_routes WHERE id = 1 -- column "cost_per_1k_input" does not exist`;
		const hits = extractDriftHits(log);
		assert.ok(hits.length > 0, "expected at least one hit");
		const fp = fingerprintHit(hits[0]);

		seen.set(fp, {
			fingerprint: fp,
			occurrence_count: 1,
			first_seen: new Date(Date.now() - 5 * 60 * 1000), // 5 min ago
			last_seen: new Date(),
			hotfix_proposal_id: "999",
			resolved_at: null,
			last_escalated_at: null,
		});
		const { pool, escalations } = makeFakePool(seen);

		const result = await runMonitorCycle({
			pool,
			repoRoot: "/tmp/r",
			scrape: () => log,
			exec: () => "",
			createHotfixProposal: async () => null,
			log: () => {},
			warn: () => {},
		});

		assert.equal(result.repeats, 1);
		assert.equal(result.escalations, 0);
		assert.equal(escalations.length, 0);
	});

	it("escalates after 4th occurrence when still unresolved", async () => {
		const seen = new Map<string, FakeRow>();
		const log = `error: column "missing_col" does not exist`;
		const hits = extractDriftHits(log);
		assert.ok(hits.length > 0, "expected at least one hit");
		const fp = fingerprintHit(hits[0]);

		seen.set(fp, {
			fingerprint: fp,
			occurrence_count: 3,
			first_seen: new Date(Date.now() - 10 * 60 * 1000),
			last_seen: new Date(),
			hotfix_proposal_id: "777",
			resolved_at: null,
			last_escalated_at: null,
		});
		const { pool, escalations } = makeFakePool(seen);

		const result = await runMonitorCycle({
			pool,
			repoRoot: "/tmp/r",
			scrape: () => log,
			exec: () => "",
			createHotfixProposal: async () => null,
			log: () => {},
			warn: () => {},
		});

		assert.equal(result.repeats, 1);
		assert.equal(result.escalations, 1);
		assert.equal(escalations.length, 1);
		assert.match(escalations[0].title, /Schema drift unresolved/);
	});

	it("escalates after 2h unresolved even on the 2nd occurrence", async () => {
		const seen = new Map<string, FakeRow>();
		const log = `error: column "aged_col" does not exist`;
		const hits = extractDriftHits(log);
		assert.ok(hits.length > 0, "expected at least one hit");
		const fp = fingerprintHit(hits[0]);

		seen.set(fp, {
			fingerprint: fp,
			occurrence_count: 1,
			first_seen: new Date(Date.now() - 3 * 60 * 60 * 1000), // 3h ago
			last_seen: new Date(),
			hotfix_proposal_id: "888",
			resolved_at: null,
			last_escalated_at: null,
		});
		const { pool, escalations } = makeFakePool(seen);

		const result = await runMonitorCycle({
			pool,
			repoRoot: "/tmp/r",
			scrape: () => log,
			exec: () => "",
			createHotfixProposal: async () => null,
			log: () => {},
			warn: () => {},
		});

		assert.equal(result.escalations, 1);
		assert.equal(escalations.length, 1);
	});

	it("respects the 1h cooldown between escalations", async () => {
		const seen = new Map<string, FakeRow>();
		const log = `error: column "cooldown_col" does not exist`;
		const hits = extractDriftHits(log);
		assert.ok(hits.length > 0, "expected at least one hit");
		const fp = fingerprintHit(hits[0]);

		seen.set(fp, {
			fingerprint: fp,
			occurrence_count: 6,
			first_seen: new Date(Date.now() - 3 * 60 * 60 * 1000),
			last_seen: new Date(),
			hotfix_proposal_id: "555",
			resolved_at: null,
			last_escalated_at: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago
		});
		const { pool, escalations } = makeFakePool(seen);

		const result = await runMonitorCycle({
			pool,
			repoRoot: "/tmp/r",
			scrape: () => log,
			exec: () => "",
			createHotfixProposal: async () => null,
			log: () => {},
			warn: () => {},
		});

		assert.equal(result.escalations, 0);
		assert.equal(escalations.length, 0);
	});

	it("stops escalating once resolved", async () => {
		const seen = new Map<string, FakeRow>();
		const log = `error: column "done_col" does not exist`;
		const hits = extractDriftHits(log);
		assert.ok(hits.length > 0, "expected at least one hit");
		const fp = fingerprintHit(hits[0]);

		seen.set(fp, {
			fingerprint: fp,
			occurrence_count: 5,
			first_seen: new Date(Date.now() - 3 * 60 * 60 * 1000),
			last_seen: new Date(),
			hotfix_proposal_id: "444",
			resolved_at: new Date(),
			last_escalated_at: null,
		});
		const { pool, escalations } = makeFakePool(seen);

		await runMonitorCycle({
			pool,
			repoRoot: "/tmp/r",
			scrape: () => log,
			exec: () => "",
			createHotfixProposal: async () => null,
			log: () => {},
			warn: () => {},
		});

		assert.equal(escalations.length, 0);
	});

	it("scrape failure surfaces in errors[] without crashing", async () => {
		const { pool } = makeFakePool();
		const result = await runMonitorCycle({
			pool,
			repoRoot: "/tmp/r",
			scrape: () => {
				throw new Error("journalctl missing");
			},
			exec: () => "",
			createHotfixProposal: async () => null,
			log: () => {},
			warn: () => {},
		});
		assert.equal(result.errors.length, 1);
		assert.match(result.errors[0], /journalctl/);
	});
});
