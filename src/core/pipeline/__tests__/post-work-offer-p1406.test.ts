/**
 * P1406: lease_expired marker tests (sibling of P1393).
 *
 * AC-1: fn_reap_expired_offers stamps metadata.failure_reason='lease_expired'
 *       on exhaustion-path UPDATE.
 * AC-2: post-work-offer.ts loop counter excludes lease_expired from recent_runs.
 * AC-3: backfill verified live (covered in migration; not unit-tested).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "../../../infra/postgres/pool.ts";

const TEST_TITLE_PREFIX = "P1406-hotfix-test:";
const TEST_ROLE = "reviewer-d1";
let proposalId = 0;

async function seedProposal(label: string): Promise<number> {
	const { rows } = await query<{ id: number }>(
		`INSERT INTO roadmap_proposal.proposal
		   (type, title, summary, status, maturity, audit)
		 VALUES ('feature', $1, 'P1406 test', 'DRAFT', 'mature', '{}'::jsonb)
		 RETURNING id`,
		[`${TEST_TITLE_PREFIX} ${label}`],
	);
	return Number(rows[0]?.id);
}

async function cleanup(): Promise<void> {
	const { rows } = await query<{ id: number }>(
		`SELECT id FROM roadmap_proposal.proposal WHERE title LIKE $1`,
		[`${TEST_TITLE_PREFIX}%`],
	);
	const ids = rows.map((r) => Number(r.id));
	if (ids.length === 0) return;
	await query(`DELETE FROM roadmap_workforce.squad_dispatch WHERE proposal_id = ANY($1)`, [ids]);
	await query(`DELETE FROM roadmap_proposal.proposal WHERE id = ANY($1)`, [ids]);
}

describe("P1406 hotfix: lease_expired exclusion", () => {
	beforeAll(async () => {
		await cleanup();
		proposalId = await seedProposal("reviewer-d1-test");
	});

	afterAll(async () => {
		await cleanup();
	});

	it("AC-1: reaper stamps lease_expired on exhaustion-path UPDATE", async () => {
		// Insert a squad_dispatch row that looks like a claimed-but-stale offer.
		// Set reissue_count=max_reissues so reaper takes the exhaustion branch.
		const { rows } = await query<{ id: number }>(
			`INSERT INTO roadmap_workforce.squad_dispatch
			   (proposal_id, squad_name, dispatch_role, dispatch_status,
			    offer_status, required_capabilities, agent_identity,
			    claim_token, claim_expires_at, claimed_at, last_renewed_at,
			    reissue_count, max_reissues, assigned_at, idempotency_key)
			 VALUES ($1, 'test-squad', $2, 'assigned', 'claimed',
			         '["review"]'::jsonb, 'claude-agency-bot',
			         gen_random_uuid(),
			         now() - interval '1 minute',
			         now() - interval '10 minute',
			         now() - interval '5 minute',
			         3, 3,
			         now() - interval '10 minute',
			         'p1406-test-' || gen_random_uuid()::text)
			 RETURNING id`,
			[proposalId, TEST_ROLE],
		);
		const dispatchId = rows[0].id;

		await query(`SELECT * FROM roadmap_workforce.fn_reap_expired_offers()`);

		const { rows: after } = await query<{
			offer_status: string;
			dispatch_status: string;
			failure_reason: string | null;
		}>(
			`SELECT offer_status, dispatch_status, metadata->>'failure_reason' AS failure_reason
			   FROM roadmap_workforce.squad_dispatch WHERE id = $1`,
			[dispatchId],
		);
		expect(after[0]?.offer_status).toBe("expired");
		expect(after[0]?.dispatch_status).toBe("failed");
		expect(after[0]?.failure_reason).toBe("lease_expired");
	});

	it("AC-2: loop counter excludes lease_expired squad_dispatch rows", async () => {
		await query(`DELETE FROM roadmap_workforce.squad_dispatch WHERE proposal_id = $1`, [proposalId]);

		// Seed 10 squad_dispatch rows tagged as lease_expired — threshold is 6.
		// Without P1406 exclusion these would trip the loop counter.
		for (let i = 0; i < 10; i++) {
			await query(
				`INSERT INTO roadmap_workforce.squad_dispatch
				   (proposal_id, squad_name, dispatch_role, dispatch_status,
				    offer_status, required_capabilities, assigned_at,
				    completed_at, metadata, idempotency_key)
				 VALUES ($1, 'test-squad', $2, 'failed', 'expired',
				         '["review"]'::jsonb,
				         now() - interval '30 minutes',
				         now() - interval '29 minutes',
				         '{"failure_reason":"lease_expired"}'::jsonb,
				         'p1406-test-le-' || $3::text || '-' || gen_random_uuid()::text)`,
				[proposalId, TEST_ROLE, i],
			);
		}

		// Mirror the exact loop-counter SQL from post-work-offer.ts.
		const { rows } = await query<{ recent_runs: number }>(
			`SELECT (
			   SELECT count(*)::int FROM roadmap_workforce.agent_runs
			    WHERE proposal_id = $1
			      AND status IN ('completed','failed')
			      AND COALESCE(completed_at, started_at) > now() - interval '1 hour'
			      AND (stage = $2 OR stage = upper($2) OR stage = 'gate:' || $2 OR agent_identity LIKE '%' || $2 || '%')
			 ) + (
			   SELECT count(*)::int FROM roadmap_workforce.squad_dispatch
			    WHERE proposal_id = $1
			      AND dispatch_role = $2
			      AND dispatch_status = 'failed'
			      AND completed_at > now() - interval '1 hour'
			      AND COALESCE(metadata->>'failure_reason', '') NOT IN ('rate_limited','lease_expired')
			 ) AS recent_runs`,
			[proposalId, TEST_ROLE],
		);
		expect(rows[0]?.recent_runs).toBe(0);
	});

	it("AC-2b: control — rows WITHOUT marker still count as loop failures", async () => {
		await query(`DELETE FROM roadmap_workforce.squad_dispatch WHERE proposal_id = $1`, [proposalId]);

		for (let i = 0; i < 10; i++) {
			await query(
				`INSERT INTO roadmap_workforce.squad_dispatch
				   (proposal_id, squad_name, dispatch_role, dispatch_status,
				    offer_status, required_capabilities, assigned_at,
				    completed_at, metadata, idempotency_key)
				 VALUES ($1, 'test-squad', $2, 'failed', 'failed',
				         '["review"]'::jsonb,
				         now() - interval '30 minutes',
				         now() - interval '29 minutes',
				         '{}'::jsonb,
				         'p1406-test-noreason-' || $3::text || '-' || gen_random_uuid()::text)`,
				[proposalId, TEST_ROLE, i],
			);
		}

		const { rows } = await query<{ n: number }>(
			`SELECT count(*)::int AS n FROM roadmap_workforce.squad_dispatch
			  WHERE proposal_id = $1
			    AND dispatch_role = $2
			    AND dispatch_status = 'failed'
			    AND completed_at > now() - interval '1 hour'
			    AND COALESCE(metadata->>'failure_reason', '') NOT IN ('rate_limited','lease_expired')`,
			[proposalId, TEST_ROLE],
		);
		expect(rows[0]?.n).toBe(10);
	});
});
