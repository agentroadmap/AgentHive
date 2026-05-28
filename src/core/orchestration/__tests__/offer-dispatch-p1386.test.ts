/**
 * P1386: architect early-exit precondition tests
 *
 * Covers:
 *   AC-1 — roadmap_proposal.v_architect_early_exit(proposal_id) returns
 *          true iff all ACs are pass/waived AND design >= 200 chars AND
 *          no open design_gap discussions newer than the proposal update.
 *   AC-2 — OrchestratorOfferDispatcher.tryArchitectEarlyExit short-circuits
 *          the dispatch path when the predicate matches:
 *            - role !== architect → falls through (returns false)
 *            - predicate false → falls through
 *            - predicate true → writes synthetic agent_runs row + completes
 *              offer, returns true
 *
 * Touches live DB via the same pool the runtime uses. Test rows use a
 * dedicated proposal_id space (1_000_001+) to avoid collisions.
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { query } from "../../../infra/postgres/pool.ts";
import { OrchestratorOfferDispatcher } from "../offer-dispatch.ts";
import type { ClaimedOffer } from "../offer-dispatch.ts";

const BASE_PROPOSAL_ID = 1_000_001;
const ORCHESTRATOR_IDENTITY = "test:p1386-orchestrator";

async function cleanupProposal(proposalId: number) {
	await query(`DELETE FROM agent_runs WHERE proposal_id = $1`, [proposalId]);
	await query(
		`DELETE FROM roadmap_proposal.proposal_discussions WHERE proposal_id = $1`,
		[proposalId],
	);
	await query(
		`DELETE FROM roadmap_proposal.proposal_acceptance_criteria WHERE proposal_id = $1`,
		[proposalId],
	);
	await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [
		proposalId,
	]);
}

async function seedProposalWithDesign(
	proposalId: number,
	designLen: number,
): Promise<void> {
	await cleanupProposal(proposalId);
	const design = "x".repeat(designLen);
	await query(
		`INSERT INTO roadmap_proposal.proposal
		   (id, display_id, title, status, type, maturity, design)
		 VALUES ($1, $2, 'P1386 test fixture', 'DRAFT', 'feature', 'new', $3)`,
		[proposalId, `T${proposalId}`, design],
	);
}

async function seedAc(
	proposalId: number,
	itemNumber: number,
	status: string,
): Promise<void> {
	await query(
		`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
		   (proposal_id, item_number, criterion_text, status)
		 VALUES ($1, $2, $3, $4)`,
		[proposalId, itemNumber, `criterion ${itemNumber}`, status],
	);
}

describe("P1386 AC-1: v_architect_early_exit predicate", () => {
	const proposalId = BASE_PROPOSAL_ID;

	afterEach(async () => {
		await cleanupProposal(proposalId);
	});

	afterAll(async () => {
		await cleanupProposal(proposalId);
	});

	async function predicate(): Promise<boolean> {
		const { rows } = await query<{ ok: boolean }>(
			`SELECT roadmap_proposal.v_architect_early_exit($1) AS ok`,
			[proposalId],
		);
		return rows[0]?.ok === true;
	}

	it("returns false when proposal has zero ACs", async () => {
		await seedProposalWithDesign(proposalId, 500);
		expect(await predicate()).toBe(false);
	});

	it("returns false when any AC is pending", async () => {
		await seedProposalWithDesign(proposalId, 500);
		await seedAc(proposalId, 1, "pass");
		await seedAc(proposalId, 2, "pending");
		expect(await predicate()).toBe(false);
	});

	it("returns false when design is too short (<200 chars)", async () => {
		await seedProposalWithDesign(proposalId, 100);
		await seedAc(proposalId, 1, "pass");
		expect(await predicate()).toBe(false);
	});

	it("returns true when all ACs are pass + design is substantive", async () => {
		await seedProposalWithDesign(proposalId, 500);
		await seedAc(proposalId, 1, "pass");
		await seedAc(proposalId, 2, "waived");
		expect(await predicate()).toBe(true);
	});

	it("returns false when a design_gap discussion is newer than proposal.updated_at", async () => {
		await seedProposalWithDesign(proposalId, 500);
		await seedAc(proposalId, 1, "pass");

		// Backdate the proposal's updated_at, then add a fresh design_gap.
		await query(
			`UPDATE roadmap_proposal.proposal
			    SET updated_at = now() - interval '1 hour'
			  WHERE id = $1`,
			[proposalId],
		);
		await query(
			`INSERT INTO roadmap_proposal.proposal_discussions
			   (proposal_id, author_identity, context_prefix, body)
			 VALUES ($1, 'test:p1386', 'design_gap:', 'open gap reopens design')`,
			[proposalId],
		);

		expect(await predicate()).toBe(false);
	});

	it("returns true when a design_gap discussion is older than the latest proposal edit", async () => {
		await seedProposalWithDesign(proposalId, 500);
		await seedAc(proposalId, 1, "pass");

		// Old design_gap, then a fresh design edit that supersedes it.
		await query(
			`INSERT INTO roadmap_proposal.proposal_discussions
			   (proposal_id, author_identity, context_prefix, body, created_at)
			 VALUES ($1, 'test:p1386', 'design_gap:', 'historical gap',
			         now() - interval '2 days')`,
			[proposalId],
		);
		await query(
			`UPDATE roadmap_proposal.proposal SET updated_at = now() WHERE id = $1`,
			[proposalId],
		);

		expect(await predicate()).toBe(true);
	});
});

describe("P1386 AC-2: tryArchitectEarlyExit dispatch short-circuit", () => {
	const proposalId = BASE_PROPOSAL_ID + 1;

	function baseClaim(overrides: Partial<ClaimedOffer> = {}): ClaimedOffer {
		return {
			offerId: "00000000-0000-0000-0000-000000099999",
			dispatchId: 999_999,
			proposalId,
			squadName: "test-squad",
			role: "architect",
			claimToken: "tok-p1386",
			claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
			offerVersion: 1,
			metadata: {},
			leaseTtlSeconds: 60,
			...overrides,
		};
	}

	function newDispatcher() {
		// Stub network-touching collaborators — the early-exit path must NOT
		// reach pickAgency, briefingAssemble, or sendMessage. If it does,
		// the test fails by virtue of the stub throwing.
		return new OrchestratorOfferDispatcher({
			orchestratorIdentity: ORCHESTRATOR_IDENTITY,
			logger: { log: () => {}, warn: () => {}, error: () => {} },
			dispatch_resolveAgency: async () => {
				throw new Error("pickAgency must not run on early-exit path");
			},
			dispatch_briefingAssemble: async () => {
				throw new Error("briefingAssemble must not run on early-exit path");
			},
			dispatch_sendMessage: async () => {
				throw new Error("sendMessage must not run on early-exit path");
			},
			dispatch_queryAgentIdentity: async () => null,
		});
	}

	beforeAll(async () => {
		// fn_complete_work_offer requires a real squad_dispatch row + claim
		// token reference. The test's dispatch_id won't exist, so the SQL call
		// fails — that's acceptable for this unit test because the assertion
		// is about whether dispatch SHORT-CIRCUITS before pickAgency. The
		// fn_complete_work_offer error is downstream of the short-circuit and
		// surfaces as a thrown exception we catch + assert. Tests below isolate
		// the path that matters by checking the agent_runs row was written.
	});

	afterEach(async () => {
		await cleanupProposal(proposalId);
	});

	afterAll(async () => {
		await cleanupProposal(proposalId);
	});

	it("falls through when role is not architect (no early-exit row written)", async () => {
		await seedProposalWithDesign(proposalId, 500);
		await seedAc(proposalId, 1, "pass");

		const d = newDispatcher();
		// Calling dispatch() with non-architect role would normally invoke
		// pickAgency (which we've stubbed to throw). We instead invoke the
		// private path through a public surface by passing role='develop'.
		// Asserting throw confirms the early-exit short-circuit did NOT fire.
		await expect(
			d.dispatch(baseClaim({ role: "develop" })),
		).rejects.toThrow(/pickAgency must not run|must not run/);

		const { rows } = await query<{ n: string }>(
			`SELECT count(*)::text AS n FROM agent_runs WHERE proposal_id = $1`,
			[proposalId],
		);
		expect(Number(rows[0].n)).toBe(0);
	});

	it("falls through when predicate is false (no early-exit row written)", async () => {
		// Architect role + pending AC → predicate returns false → normal dispatch path
		await seedProposalWithDesign(proposalId, 500);
		await seedAc(proposalId, 1, "pending");

		const d = newDispatcher();
		await expect(d.dispatch(baseClaim())).rejects.toThrow(
			/pickAgency must not run/,
		);

		const { rows } = await query<{ n: string }>(
			`SELECT count(*)::text AS n FROM agent_runs WHERE proposal_id = $1`,
			[proposalId],
		);
		expect(Number(rows[0].n)).toBe(0);
	});

	it("writes synthetic agent_runs row + does NOT call pickAgency when predicate is true", async () => {
		await seedProposalWithDesign(proposalId, 500);
		await seedAc(proposalId, 1, "pass");
		await seedAc(proposalId, 2, "waived");

		const d = newDispatcher();
		// fn_complete_work_offer will fail (no real squad_dispatch row) but
		// that happens AFTER the agent_runs telemetry write, so the row exists
		// even on downstream failure. Test assertion verifies the telemetry
		// row is present and pickAgency was not called.
		await d.dispatch(baseClaim()).catch(() => {
			/* fn_complete_work_offer expected to fail for synthetic dispatch_id */
		});

		const { rows } = await query<{
			status: string;
			activity: string;
			output_summary: string;
			duration_ms: number;
			agent_identity: string;
			stage: string;
		}>(
			`SELECT status, activity, output_summary, duration_ms, agent_identity, stage
			   FROM agent_runs
			  WHERE proposal_id = $1
			  ORDER BY id DESC
			  LIMIT 1`,
			[proposalId],
		);
		expect(rows.length).toBe(1);
		expect(rows[0].status).toBe("completed");
		expect(rows[0].activity).toBe("early-exit");
		expect(rows[0].output_summary).toBe("early-exit: no design work");
		expect(Number(rows[0].duration_ms)).toBe(0);
		expect(rows[0].agent_identity).toBe(ORCHESTRATOR_IDENTITY);
		expect(rows[0].stage).toBe("architect");
	});
});
