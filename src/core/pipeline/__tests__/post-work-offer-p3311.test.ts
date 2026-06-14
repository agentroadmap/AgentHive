/**
 * P3311: proactive premature-maturity guard tests.
 *
 * A DEVELOP/mature proposal with ACs but ZERO passing AC was never built — it
 * was matured by mistake. The D3 gate (skeptic-beta) then fires every scan,
 * HOLDs ("no code"), but the hold doesn't demote maturity → infinite re-gate
 * until a reactive breaker trips after burning 6+ runs. This guard fires FIRST:
 * refuse the gate offer and demote maturity to 'new' (routes to a developer).
 *
 * Verified against the live DB schema:
 *   AC-1: DEVELOP/mature + ACs all pending → PrematureGateError, no dispatch row,
 *         maturity demoted to 'new'.
 *   AC-2: DEVELOP/mature + >=1 passing AC → guard does NOT fire (real evidence;
 *         a stuck gate here is the separate artifact-gap bug, not prematurity).
 *   AC-3: DEVELOP/mature + ZERO ACs total → guard does NOT fire (left to gate).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "../../../infra/postgres/pool.ts";
import { PrematureGateError, postWorkOffer } from "../post-work-offer.ts";

const TEST_TITLE_PREFIX = "P3311-premature-guard-test:";
const TEST_ROLE = "skeptic-beta";

let zeroPassId = 0;
let hasPassId = 0;
let zeroAcId = 0;

async function seedProposal(label: string): Promise<number> {
	const { rows } = await query<{ id: number }>(
		`INSERT INTO roadmap_proposal.proposal
		   (type, title, summary, status, maturity, gate_scanner_paused, audit)
		 VALUES ('feature', $1, 'P3311 test', 'DEVELOP', 'mature', false, '{}'::jsonb)
		 RETURNING id`,
		[`${TEST_TITLE_PREFIX} ${label}`],
	);
	return Number(rows[0]?.id);
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
		[proposalId, itemNumber, `P3311 test AC ${itemNumber}`, status],
	);
}

async function maturityOf(proposalId: number): Promise<string | null> {
	const { rows } = await query<{ maturity: string }>(
		`SELECT maturity FROM roadmap_proposal.proposal WHERE id = $1`,
		[proposalId],
	);
	return rows[0]?.maturity ?? null;
}

async function cleanup(): Promise<void> {
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
		`DELETE FROM roadmap_proposal.proposal_acceptance_criteria WHERE proposal_id = ANY($1)`,
		[ids],
	);
	await query(
		`DELETE FROM roadmap.notification_queue WHERE proposal_id = ANY($1)`,
		[ids],
	);
	await query(`DELETE FROM roadmap_proposal.proposal WHERE id = ANY($1)`, [ids]);
}

describe("P3311 proactive premature-maturity guard", () => {
	beforeAll(async () => {
		await cleanup();
		zeroPassId = await seedProposal("zero-pass");
		await seedAc(zeroPassId, 1, "pending");
		await seedAc(zeroPassId, 2, "fail");

		hasPassId = await seedProposal("has-pass");
		await seedAc(hasPassId, 1, "pass");
		await seedAc(hasPassId, 2, "pending");

		zeroAcId = await seedProposal("zero-ac");
		// no ACs seeded
	});

	afterAll(async () => {
		await cleanup();
	});

	it("AC-1: DEVELOP/mature with 0 passing ACs → PrematureGateError, no dispatch, demoted to new", async () => {
		await expect(
			postWorkOffer({
				proposalId: zeroPassId,
				squadName: "test-squad",
				role: TEST_ROLE,
				task: "gate review",
			}),
		).rejects.toThrow(PrematureGateError);

		// No squad_dispatch row inserted.
		const { rows } = await query<{ n: number }>(
			`SELECT count(*)::int AS n FROM roadmap_workforce.squad_dispatch WHERE proposal_id = $1`,
			[zeroPassId],
		);
		expect(rows[0]?.n).toBe(0);

		// Maturity demoted to 'new' so the next scan routes to a developer.
		expect(await maturityOf(zeroPassId)).toBe("new");
	});

	it("AC-2: DEVELOP/mature with >=1 passing AC → guard does NOT fire", async () => {
		let threwPremature = false;
		try {
			await postWorkOffer({
				proposalId: hasPassId,
				squadName: "test-squad",
				role: TEST_ROLE,
				task: "gate review",
			});
		} catch (err) {
			if (err instanceof PrematureGateError) threwPremature = true;
			// other downstream errors (capability/backpressure) are acceptable here
		}
		expect(threwPremature).toBe(false);
		// Maturity untouched.
		expect(await maturityOf(hasPassId)).toBe("mature");
	});

	it("AC-3: DEVELOP/mature with ZERO ACs total → guard does NOT fire", async () => {
		let threwPremature = false;
		try {
			await postWorkOffer({
				proposalId: zeroAcId,
				squadName: "test-squad",
				role: TEST_ROLE,
				task: "gate review",
			});
		} catch (err) {
			if (err instanceof PrematureGateError) threwPremature = true;
		}
		expect(threwPremature).toBe(false);
		expect(await maturityOf(zeroAcId)).toBe("mature");
	});

	it("AC-4: PrematureGateError carries proposalId, role, totalAcs", () => {
		const err = new PrematureGateError(3311, "skeptic-beta", 5);
		expect(err.name).toBe("PrematureGateError");
		expect(err.proposalId).toBe(3311);
		expect(err.role).toBe("skeptic-beta");
		expect(err.totalAcs).toBe(5);
		expect(err.message).toContain("premature maturity");
		expect(err.message).toContain("0/5");
	});
});
