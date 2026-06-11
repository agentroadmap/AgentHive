/**
 * P1351 — Agency resolver chain walking tests
 *
 * AC-6: buildAgencyChain walks parent_agency_id upwards to construct
 * the full ancestor list [parent_id, ..., leaf_id].
 *
 * AC-6 resolveAgency includes agency_chain in the returned candidate.
 */

import { afterAll, beforeAll, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { buildAgencyChain } from "./agency-resolver.ts";

const SKIP = !process.env.PGUSER && !process.env.PGPASSWORD;
let pool: Pool;

const dbTest = (name: string, fn: () => Promise<void>) =>
	it(name, async () => {
		if (SKIP) {
			console.log(`  [skipped: ${name}] — DB credentials absent`);
			return;
		}
		await fn();
	});

beforeAll(async () => {
	if (SKIP) return;
	pool = new Pool({
		host: process.env.PGHOST ?? "127.0.0.1",
		port: Number(process.env.PGPORT ?? 5432),
		user: process.env.PGUSER ?? "admin",
		password: process.env.PGPASSWORD,
		database: process.env.PGDATABASE ?? "agenthive",
	});
	await pool.query("SELECT 1");
});

afterAll(async () => {
	if (SKIP || !pool) return;
	await pool.end();
});

describe("P1351 AC-6 — buildAgencyChain", () => {
	dbTest("buildAgencyChain returns [agency_id] for root agencies", async () => {
		// Create a root agency (no parent)
		const testId = `test/root-${Date.now()}`;
		await pool.query(
			`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id)
			 VALUES ($1, $2, 'test', 'test-host')
			 ON CONFLICT DO NOTHING`,
			[testId, testId],
		);

		try {
			const chain = await buildAgencyChain(testId);
			assert.deepStrictEqual(
				chain,
				[testId],
				"root agency chain should be [self]",
			);
		} finally {
			await pool.query(`DELETE FROM roadmap.agency WHERE agency_id = $1`, [
				testId,
			]);
		}
	});

	dbTest(
		"buildAgencyChain walks parent chain: [parent, child] returns [parent, child]",
		async () => {
			const parent = `test/parent-chain-${Date.now()}`;
			const child = `test/child-chain-${Date.now()}`;

			// Insert parent first
			await pool.query(
				`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id)
				 VALUES ($1, $2, 'test', 'test-host')
				 ON CONFLICT DO NOTHING`,
				[parent, parent],
			);

			// Insert child with parent reference
			await pool.query(
				`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, parent_agency_id)
				 VALUES ($1, $2, 'test', 'test-host', $3)
				 ON CONFLICT DO NOTHING`,
				[child, child, parent],
			);

			try {
				const chain = await buildAgencyChain(child);
				assert.deepStrictEqual(
					chain,
					[parent, child],
					"child chain should walk up to parent",
				);
			} finally {
				await pool.query(
					`DELETE FROM roadmap.agency WHERE agency_id IN ($1, $2)`,
					[parent, child],
				);
			}
		},
	);

	dbTest(
		"buildAgencyChain handles 3-level hierarchy: [grandparent, parent, child]",
		async () => {
			const grandparent = `test/gp-${Date.now()}`;
			const parent = `test/p-${Date.now()}`;
			const child = `test/c-${Date.now()}`;

			// Build hierarchy
			await pool.query(
				`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id)
				 VALUES ($1, $2, 'test', 'test-host')
				 ON CONFLICT DO NOTHING`,
				[grandparent, grandparent],
			);
			await pool.query(
				`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, parent_agency_id)
				 VALUES ($1, $2, 'test', 'test-host', $3)
				 ON CONFLICT DO NOTHING`,
				[parent, parent, grandparent],
			);
			await pool.query(
				`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, parent_agency_id)
				 VALUES ($1, $2, 'test', 'test-host', $3)
				 ON CONFLICT DO NOTHING`,
				[child, child, parent],
			);

			try {
				const chain = await buildAgencyChain(child);
				assert.deepStrictEqual(
					chain,
					[grandparent, parent, child],
					"3-level hierarchy should be [gp, p, c]",
				);
			} finally {
				await pool.query(
					`DELETE FROM roadmap.agency WHERE agency_id IN ($1, $2, $3)`,
					[grandparent, parent, child],
				);
			}
		},
	);

	dbTest("buildAgencyChain returns [nonexistent_id] for missing agency", async () => {
		const fakeId = `test/nonexistent-${Date.now()}`;
		const chain = await buildAgencyChain(fakeId);
		// Non-existent agency returns empty chain, which falls back to [id]
		assert.deepStrictEqual(
			chain,
			[fakeId],
			"nonexistent agency should return [id]",
		);
	});
});
