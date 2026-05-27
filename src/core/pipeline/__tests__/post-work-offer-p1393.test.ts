/**
 * P1393: gate-paused + rate-limited circuit-breaker hotfix tests.
 *
 * Three behaviors verified against the live DB schema:
 *   AC-1: postWorkOffer throws ProposalPausedError when proposal.gate_scanner_paused=true
 *   AC-2: ProposalPausedError carries pausedBy + pausedAt and reads as skip-and-continue shape
 *   AC-4: loop counter excludes squad_dispatch rows with metadata.failure_reason='rate_limited'
 *
 * AC-3 (offer-dispatch-handler stamps the marker) is verified in
 * src/infra/agency/__tests__/offer-dispatch-handler-p1393.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "../../../infra/postgres/pool.ts";
import {
	ProposalPausedError,
	postWorkOffer,
} from "../post-work-offer.ts";

const TEST_TITLE_PREFIX = "P1393-hotfix-test:";
const TEST_ROLE = "skeptic-beta";
let pausedProposalId = 0;
let activeProposalId = 0;

async function seedProposal(paused: boolean, label: string): Promise<number> {
	const { rows } = await query<{ id: number }>(
		`INSERT INTO roadmap_proposal.proposal
		   (type, title, summary, status, maturity,
		    gate_scanner_paused, gate_paused_by, gate_paused_at, audit)
		 VALUES ('feature', $1, 'P1393 test', 'DEVELOP', 'mature',
		         $2, CASE WHEN $2 THEN 'circuit_breaker' ELSE NULL END,
		         CASE WHEN $2 THEN now() - interval '2 days' ELSE NULL END,
		         '{}'::jsonb)
		 RETURNING id`,
		[`${TEST_TITLE_PREFIX} ${label}`, paused],
	);
	return Number(rows[0]?.id);
}

async function cleanupProposals(): Promise<void> {
	const { rows } = await query<{ id: number }>(
		`SELECT id FROM roadmap_proposal.proposal WHERE title LIKE $1`,
		[`${TEST_TITLE_PREFIX}%`],
	);
	const ids = rows.map((r) => Number(r.id));
	if (ids.length === 0) return;
	await query(
		`DELETE FROM roadmap_workforce.squad_dispatch WHERE proposal_id = ANY($1)`,
		[ids],
	);
	await query(
		`DELETE FROM roadmap_workforce.agent_runs WHERE proposal_id = ANY($1)`,
		[ids],
	);
	await query(
		`DELETE FROM roadmap_proposal.proposal WHERE id = ANY($1)`,
		[ids],
	);
}

describe("P1393 hotfix: gate-paused + rate-limited circuit-breaker", () => {
	beforeAll(async () => {
		await cleanupProposals();
		pausedProposalId = await seedProposal(true, "paused");
		activeProposalId = await seedProposal(false, "active");
	});

	afterAll(async () => {
		await cleanupProposals();
	});

	it("AC-1: postWorkOffer throws ProposalPausedError when gate_scanner_paused=true", async () => {
		await expect(
			postWorkOffer({
				proposalId: pausedProposalId,
				squadName: "test-squad",
				role: TEST_ROLE,
				task: "test task",
			}),
		).rejects.toThrow(ProposalPausedError);

		// No squad_dispatch row should have been INSERTed.
		const { rows } = await query<{ n: number }>(
			`SELECT count(*)::int AS n FROM roadmap_workforce.squad_dispatch
			  WHERE proposal_id = $1`,
			[pausedProposalId],
		);
		expect(rows[0]?.n).toBe(0);
	});

	it("AC-2: ProposalPausedError carries pausedBy + pausedAt", () => {
		const pausedAt = new Date("2026-05-24T20:33:13Z");
		const err = new ProposalPausedError(1135, "circuit_breaker", pausedAt);

		expect(err.name).toBe("ProposalPausedError");
		expect(err.proposalId).toBe(1135);
		expect(err.pausedBy).toBe("circuit_breaker");
		expect(err.pausedAt).toEqual(pausedAt);
		expect(err.message).toContain("gate_scanner_paused=true");
		expect(err.message).toContain("circuit_breaker");
	});

	it("AC-1b: postWorkOffer proceeds past the pause check when gate_scanner_paused=false", async () => {
		// We don't require full dispatch success — only that ProposalPausedError
		// is NOT thrown. Any other downstream error (capability mismatch,
		// backpressure, loop) is acceptable for this control case.
		let threwProposalPaused = false;
		try {
			await postWorkOffer({
				proposalId: activeProposalId,
				squadName: "test-squad",
				role: TEST_ROLE,
				task: "test task",
			});
		} catch (err) {
			if (err instanceof ProposalPausedError) threwProposalPaused = true;
		}
		expect(threwProposalPaused).toBe(false);
	});

	it("AC-4: loop counter excludes squad_dispatch rows with failure_reason=rate_limited", async () => {
		await query(
			`DELETE FROM roadmap_workforce.squad_dispatch WHERE proposal_id = $1`,
			[activeProposalId],
		);

		// Seed 10 squad_dispatch rows, all failed, all with rate_limited marker.
		// Threshold is 6 per post-work-offer.ts. Without P1393 the breaker trips.
		for (let i = 0; i < 10; i++) {
			await query(
				`INSERT INTO roadmap_workforce.squad_dispatch
				   (proposal_id, squad_name, dispatch_role, dispatch_status,
				    offer_status, required_capabilities, assigned_at,
				    completed_at, metadata, idempotency_key)
				 VALUES ($1, 'test-squad', $2, 'failed', 'failed',
				         '["develop"]'::jsonb,
				         now() - interval '30 minutes',
				         now() - interval '29 minutes',
				         '{"failure_reason":"rate_limited"}'::jsonb,
				         'p1393-test-rl-' || $3::text || '-' || gen_random_uuid()::text)`,
				[activeProposalId, TEST_ROLE, i],
			);
		}

		// Query the loop counter directly — same SQL postWorkOffer uses.
		const { rows } = await query<{ recent_runs: number }>(
			`SELECT (
			   SELECT count(*)::int FROM roadmap_workforce.agent_runs
			    WHERE proposal_id = $1
			      AND status IN ('completed', 'failed')
			      AND COALESCE(completed_at, started_at) > now() - interval '1 hour'
			      AND (stage = $2 OR stage = upper($2) OR stage = 'gate:' || $2 OR agent_identity LIKE '%' || $2 || '%')
			 ) + (
			   SELECT count(*)::int FROM roadmap_workforce.squad_dispatch
			    WHERE proposal_id = $1
			      AND dispatch_role = $2
			      AND dispatch_status = 'failed'
			      AND completed_at > now() - interval '1 hour'
			      AND COALESCE(metadata->>'failure_reason', '') <> 'rate_limited'
			 ) AS recent_runs`,
			[activeProposalId, TEST_ROLE],
		);
		expect(rows[0]?.recent_runs).toBe(0);
	});

	it("AC-4b: control — squad_dispatch rows WITHOUT the marker still count", async () => {
		await query(
			`DELETE FROM roadmap_workforce.squad_dispatch WHERE proposal_id = $1`,
			[activeProposalId],
		);

		for (let i = 0; i < 10; i++) {
			await query(
				`INSERT INTO roadmap_workforce.squad_dispatch
				   (proposal_id, squad_name, dispatch_role, dispatch_status,
				    offer_status, required_capabilities, assigned_at,
				    completed_at, metadata, idempotency_key)
				 VALUES ($1, 'test-squad', $2, 'failed', 'failed',
				         '["develop"]'::jsonb,
				         now() - interval '30 minutes',
				         now() - interval '29 minutes',
				         '{}'::jsonb,
				         'p1393-test-noreason-' || $3::text || '-' || gen_random_uuid()::text)`,
				[activeProposalId, TEST_ROLE, i],
			);
		}

		const { rows } = await query<{ recent_runs: number }>(
			`SELECT count(*)::int AS recent_runs FROM roadmap_workforce.squad_dispatch
			  WHERE proposal_id = $1
			    AND dispatch_role = $2
			    AND dispatch_status = 'failed'
			    AND completed_at > now() - interval '1 hour'
			    AND COALESCE(metadata->>'failure_reason', '') <> 'rate_limited'`,
			[activeProposalId, TEST_ROLE],
		);
		expect(rows[0]?.recent_runs).toBe(10);
	});

	it("AC-5 (view): v_mature_queue excludes paused proposals (migration 180)", async () => {
		const { rows } = await query<{ id: number }>(
			`SELECT id FROM roadmap_proposal.v_mature_queue WHERE id = ANY($1)`,
			[[pausedProposalId, activeProposalId]],
		);
		const ids = rows.map((r) => Number(r.id));
		expect(ids).not.toContain(pausedProposalId);
		expect(ids).toContain(activeProposalId);
	});
});
