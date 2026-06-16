import assert from "node:assert";
import { describe, test, before } from "node:test";

/**
 * P3563 AC-6/AC-7 (origination side): checkPillar3Origination against the test DB.
 *
 * Requires the throwaway DB (PGDATABASE=agenthive_p3563_test) with migrations
 * 289/291/292 applied and base reference rows seeded. Gated by
 * AGENTHIVE_RESOLVER_DB_TEST=1. Sets the flag ON for these tests, then resets.
 *
 * Run:
 *   AGENTHIVE_RESOLVER_DB_TEST=1 PGDATABASE=agenthive_p3563_test \
 *   AGENTHIVE_GATE_AC_INVARIANT_ENABLED=1 \
 *     node --import jiti/register --test \
 *     src/core/gate/__tests__/p3563-verifier-independence.test.ts
 */

const DB_TEST = process.env.AGENTHIVE_RESOLVER_DB_TEST === "1";

describe("P3563: checkPillar3Origination (verify_ac side)", { skip: !DB_TEST }, () => {
	let query: any;
	let checkPillar3Origination: any;

	before(async () => {
		// Force the env-layer flag ON for the origination guard.
		process.env.AGENTHIVE_GATE_AC_INVARIANT_ENABLED = "1";
		({ query } = await import("../../../postgres/pool.ts"));
		({ checkPillar3Origination } = await import("../verifier-independence.ts"));
	});

	async function ensureAgent(identity: string, agencyId: number | null = null): Promise<number> {
		await query(
			`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, agency_id)
			 VALUES ($1,'llm',$2) ON CONFLICT (agent_identity) DO UPDATE SET agency_id = EXCLUDED.agency_id`,
			[identity, agencyId],
		);
		const { rows } = await query(
			`SELECT id FROM roadmap_workforce.agent_registry WHERE agent_identity=$1`, [identity]);
		return rows[0].id;
	}

	async function seedProposal(): Promise<number> {
		const { rows } = await query(
			`INSERT INTO roadmap_proposal.proposal (title,type,status,maturity,priority,audit)
			 VALUES ('p3563-indep','feature','DEVELOP','mature','high','{}'::jsonb) RETURNING id`);
		return rows[0].id;
	}

	async function addBuilder(pid: number, agency: string, extra = false) {
		await query(
			`INSERT INTO roadmap_workforce.squad_dispatch
			   (proposal_id, squad_name, dispatch_role, agency_identity, required_capabilities, offer_status)
			 VALUES ($1,'sq',$2,$3,'["build"]'::jsonb,'open')`,
			[pid, extra ? "engineer" : "developer", agency],
		);
	}

	async function cleanup(pid: number) {
		await query(`DELETE FROM roadmap_workforce.squad_dispatch WHERE proposal_id=$1`, [pid]);
		await query(`DELETE FROM roadmap_proposal.proposal WHERE id=$1`, [pid]);
	}

	// AC-6: builder-agency verifier originating a CONTENT pass is blocked (multi-agency).
	test("AC-6: builder-agency content pass is BLOCKED when other agencies exist", async () => {
		const aId = await ensureAgent("indep.agency-a.a");
		await query(`UPDATE roadmap_workforce.agent_registry SET agency_id=$1 WHERE agent_identity='indep.agency-a.a'`, [aId]);
		const bId = await ensureAgent("indep.agency-b.a");
		await query(`UPDATE roadmap_workforce.agent_registry SET agency_id=$1 WHERE agent_identity='indep.agency-b.a'`, [bId]);
		const verifier = "indep.builder-v";
		await ensureAgent(verifier, aId); // belongs to agency-a
		const pid = await seedProposal();
		try {
			await addBuilder(pid, "indep.agency-a.a");       // agency-a built it
			await addBuilder(pid, "indep.agency-b.a", true); // agency-b also built (multi-agency)
			const r = await checkPillar3Origination(pid, verifier, "file/module");
			assert.strictEqual(r.blocked, true, "builder-agency content pass must be blocked");
			assert.strictEqual(r.code, "BUILDER_AGENCY_SELF_CERT");
		} finally {
			await cleanup(pid);
		}
	});

	// AC-7: independent verifier accepted.
	test("AC-7: independent-agency verifier is ALLOWED", async () => {
		const aId = await ensureAgent("indep2.agency-a.a");
		await query(`UPDATE roadmap_workforce.agent_registry SET agency_id=$1 WHERE agent_identity='indep2.agency-a.a'`, [aId]);
		const cId = await ensureAgent("indep2.agency-c.a");
		await query(`UPDATE roadmap_workforce.agent_registry SET agency_id=$1 WHERE agent_identity='indep2.agency-c.a'`, [cId]);
		const verifier = "indep2.outside-v";
		await ensureAgent(verifier, cId); // belongs to agency-c, which did NOT build
		const pid = await seedProposal();
		try {
			await addBuilder(pid, "indep2.agency-a.a");
			const r = await checkPillar3Origination(pid, verifier, "file/module");
			assert.strictEqual(r.blocked, false, "independent verifier must be allowed");
		} finally {
			await cleanup(pid);
		}
	});

	// AC-7: single-agency floor degrades to advisory (not blocked).
	test("AC-7: single-agency floor → advisory, not blocked", async () => {
		const aId = await ensureAgent("floor.agency.a");
		await query(`UPDATE roadmap_workforce.agent_registry SET agency_id=$1 WHERE agent_identity='floor.agency.a'`, [aId]);
		const verifier = "floor.builder-v";
		await ensureAgent(verifier, aId);
		const pid = await seedProposal();
		try {
			await addBuilder(pid, "floor.agency.a"); // the ONLY builder agency
			const r = await checkPillar3Origination(pid, verifier, "file/module");
			assert.strictEqual(r.blocked, false, "single-agency floor must not hard-block");
			assert.strictEqual(r.code, "SINGLE_AGENCY_FLOOR_ADVISORY");
		} finally {
			await cleanup(pid);
		}
	});

	// Non-content category is never origination-restricted.
	test("non-content category (mcp_tool excluded? no — content) — metadata-less pass allowed when no builder match", async () => {
		const pid = await seedProposal();
		try {
			// verifier with no agency → cannot prove dependence → allowed.
			await ensureAgent("floor.no-agency-v");
			const r = await checkPillar3Origination(pid, "floor.no-agency-v", "file/module");
			assert.strictEqual(r.blocked, false, "unresolved verifier agency must not block");
		} finally {
			await cleanup(pid);
		}
	});
});
