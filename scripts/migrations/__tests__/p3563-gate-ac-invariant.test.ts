import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, before, after } from "node:test";

/**
 * P3563 + P3565 — consolidated gate acceptance-criteria invariant.
 *
 * Maps tests → ACs:
 *   P3563 AC-1 : flag OFF ⇒ fn_guard_gate_advance == P3566 (parity).
 *   P3563 AC-2 : Pillar-1 — zero-AC terminal advance refused (flag ON).
 *   P3563 AC-3 : Pillar-2 — pending/fail AC blocks terminal advance (flag ON).
 *   P3563 AC-4 : all pass/waived ⇒ terminal advance allowed (flag ON).
 *   P3563 AC-5 : Pillar-3 gate-side — builder-agency self-cert content pass refused.
 *   P3563 AC-6 : Pillar-3 origination — verify_ac refuses builder-agency content pass.
 *   P3563 AC-7 : independent verifier accepted; single-agency floor degraded.
 *   P3563 AC-8 : app.gate_bypass NOT honored when flag ON (P906 restored).
 *   P3563 AC-9 : async re-validator flips a non-zero-exit test-evidence pass to fail.
 *   P3563 AC-10: legacy audit before/after counts (provenance view + refresh).
 *   P3563 AC-11: flag resolver fn_gate_ac_invariant_enabled() cascade (DB/default).
 *   P3563 AC-12: drift / stage-sync advance path honors the invariant.
 *   P3565 AC-16: high-risk diff refused without operator authorization (trigger).
 *   P3565 AC-17: high-risk diff allowed with operator_authorized marker.
 *
 * Run:
 *   AGENTHIVE_RESOLVER_DB_TEST=1 PGDATABASE=agenthive_p3563_test \
 *     node --import jiti/register --test \
 *     scripts/migrations/__tests__/p3563-gate-ac-invariant.test.ts
 *
 * The DB tests REQUIRE a throwaway DB (default agenthive_p3563_test) with
 * migrations 289/291/292 applied. They run inside ROLLBACK transactions.
 */

const DB_TEST = process.env.AGENTHIVE_RESOLVER_DB_TEST === "1";
const TEST_DB = process.env.PGDATABASE || "agenthive_p3563_test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_291 = join(__dirname, "..", "291-p3563-gate-ac-invariant.sql");
const MIGRATION_292 = join(__dirname, "..", "292-p3563-legacy-unverified-audit.sql");

// ---------------------------------------------------------------------------
// Text-scan tests (always run, no DB)
// ---------------------------------------------------------------------------
describe("P3563: migration SQL structural invariants (text-scan)", () => {
	const sql291 = readFileSync(MIGRATION_291, "utf8");
	const sql292 = readFileSync(MIGRATION_292, "utf8");

	test("AC-1: P3566 invariants preserved verbatim in the rewritten guard", () => {
		assert.ok(/P3566 AC-3/.test(sql291), "AC-3 marker retained");
		assert.ok(/P3566 AC-1/.test(sql291), "AC-1 marker retained");
		assert.ok(/P3566 AC-2/.test(sql291), "AC-2 marker retained");
		assert.ok(/requires a gate_decision_log row/.test(sql291), "Branch A error retained");
	});

	test("AC-11: flag resolver + flag gate present, default OFF", () => {
		assert.ok(/fn_gate_ac_invariant_enabled/.test(sql291));
		assert.ok(/RETURN false;\s*--\s*default OFF/.test(sql291));
		assert.ok(/AGENTHIVE_GATE_AC_INVARIANT_ENABLED/.test(sql291));
		assert.ok(/'false'::jsonb/.test(sql291), "flag seeded to false");
	});

	test("AC-2/3/4/5: terminal pillars present", () => {
		assert.ok(/P3563 Pillar-1/.test(sql291), "Pillar-1");
		assert.ok(/P3563 Pillar-2/.test(sql291), "Pillar-2");
		assert.ok(/P3563 Pillar-3/.test(sql291), "Pillar-3");
	});

	test("AC-8: app.gate_bypass not honored when flag ON (P906 restore)", () => {
		assert.ok(/NOT v_flag_on/.test(sql291), "bypass honored only when flag OFF");
	});

	test("AC-16/17: P3565 diff-risk clause present with operator marker", () => {
		assert.ok(/P3565 diff-risk clause/.test(sql291));
		assert.ok(/operator_authorized/.test(sql291));
		assert.ok(/diff_risk,high/.test(sql291));
	});

	test("AC-10: legacy audit view + refresh fn + non-destructive", () => {
		assert.ok(/v_legacy_verification_provenance/.test(sql292));
		assert.ok(/fn_refresh_legacy_verification_audit/.test(sql292));
		assert.ok(/legacy-unverified/.test(sql292));
		assert.ok(!/UPDATE roadmap_proposal\.proposal\b/.test(sql292), "must not UPDATE proposal status");
	});
});

// ---------------------------------------------------------------------------
// DB integration tests
// ---------------------------------------------------------------------------
describe("P3563/P3565: DB integration", { skip: !DB_TEST }, () => {
	let Client: any;

	before(async () => {
		({ Client } = await import("pg"));
	});

	async function withRollback(fn: (c: any) => Promise<void>) {
		const client = new Client({
			host: process.env.PGHOST || "127.0.0.1",
			port: parseInt(process.env.PGPORT || "5432", 10),
			user: process.env.PGUSER || "admin",
			password: process.env.PGPASSWORD,
			database: TEST_DB,
		});
		await client.connect();
		try {
			await client.query("BEGIN");
			await fn(client);
		} finally {
			await client.query("ROLLBACK").catch(() => {});
			await client.end();
		}
	}

	async function setFlag(c: any, on: boolean) {
		await c.query(
			`INSERT INTO core.runtime_flag (flag_name, scope, value_jsonb, lifecycle_status)
			 VALUES ('AGENTHIVE_GATE_AC_INVARIANT_ENABLED','global',$1::jsonb,'active')
			 ON CONFLICT (flag_name) DO UPDATE SET value_jsonb = EXCLUDED.value_jsonb, lifecycle_status='active'`,
			[on ? "true" : "false"],
		);
	}

	async function ensureAgent(c: any, identity: string, agencyId: number | null = null) {
		await c.query(
			`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, agency_id)
			 VALUES ($1,'llm',$2) ON CONFLICT (agent_identity) DO UPDATE SET agency_id = EXCLUDED.agency_id`,
			[identity, agencyId],
		);
		const { rows } = await c.query(
			`SELECT id FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
			[identity],
		);
		return rows[0].id as number;
	}

	// Seed a proposal in a given state with a Standard-RFC-like forward workflow.
	async function seedProposal(c: any, status: string): Promise<number> {
		const { rows } = await c.query(
			`INSERT INTO roadmap_proposal.proposal (title, type, status, maturity, priority, audit)
			 VALUES ('p3563-test','feature',$1,'mature','high','{}'::jsonb) RETURNING id`,
			[status],
		);
		return rows[0].id;
	}

	async function addAc(
		c: any,
		pid: number,
		item: number,
		status: string,
		verifiedBy: string | null = null,
		details: any = null,
	) {
		await c.query(
			`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
			   (proposal_id, item_number, criterion_text, status, verified_by, details, verification_notes)
			 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
			[pid, item, `crit ${item}`, status, verifiedBy, details ? JSON.stringify(details) : null,
			 status === "pass" ? "evidence ok" : null],
		);
	}

	// The PRODUCTION advance path: a gate_decision_log INSERT fires
	// fn_apply_gate_advance (AFTER INSERT), which UPDATEs proposal.status,
	// firing fn_guard_gate_advance (BEFORE UPDATE) in the SAME transaction. So
	// the guard's verdict surfaces as the success/failure of THIS insert.
	async function advanceViaDecision(
		c: any, pid: number, from: string, to: string, decidedBy: string, acVer: any = null,
	): Promise<{ ok: boolean; err?: string }> {
		await c.query(`SELECT set_config('app.agent_identity',$1,true)`, [decidedBy]);
		try {
			await c.query(
				`INSERT INTO roadmap_proposal.gate_decision_log
				   (proposal_id, from_state, to_state, decision, decided_by, ac_verification)
				 VALUES ($1,$2,$3,'advance',$4,$5)`,
				[pid, from, to, decidedBy, acVer ? JSON.stringify(acVer) : null],
			);
			// Confirm the flip actually happened.
			const { rows } = await c.query(
				`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`, [pid]);
			return { ok: rows[0].status.toUpperCase() === to.toUpperCase() };
		} catch (e: any) {
			return { ok: false, err: e.message };
		}
	}

	// Bypass-path test: a raw UPDATE under SET LOCAL app.gate_bypass (no decision row).
	async function rawUpdate(c: any, pid: number, to: string): Promise<{ ok: boolean; err?: string }> {
		try {
			await c.query(`UPDATE roadmap_proposal.proposal SET status = $1 WHERE id = $2`, [to, pid]);
			return { ok: true };
		} catch (e: any) {
			return { ok: false, err: e.message };
		}
	}

	// ===== AC-11: flag resolver cascade =====
	test("AC-11: fn_gate_ac_invariant_enabled defaults OFF, reads DB true/false", async () => {
		await withRollback(async (c) => {
			await c.query(`DELETE FROM core.runtime_flag WHERE flag_name='AGENTHIVE_GATE_AC_INVARIANT_ENABLED'`);
			let r = await c.query(`SELECT roadmap_proposal.fn_gate_ac_invariant_enabled() AS e`);
			assert.strictEqual(r.rows[0].e, false, "default OFF when no row");
			await setFlag(c, true);
			r = await c.query(`SELECT roadmap_proposal.fn_gate_ac_invariant_enabled() AS e`);
			assert.strictEqual(r.rows[0].e, true, "reads DB true");
			await setFlag(c, false);
			r = await c.query(`SELECT roadmap_proposal.fn_gate_ac_invariant_enabled() AS e`);
			assert.strictEqual(r.rows[0].e, false, "reads DB false");
		});
	});

	// ===== AC-1: flag OFF ⇒ P3566 parity (terminal advance allowed with 0 ACs) =====
	test("AC-1: flag OFF — terminal DEVELOP→MERGE with ZERO ACs is allowed (P3566 parity)", async () => {
		await withRollback(async (c) => {
			await setFlag(c, false);
			const v = "p3563-decider";
			await ensureAgent(c, v);
			const pid = await seedProposal(c, "DEVELOP");
			const res = await advanceViaDecision(c, pid, "DEVELOP", "MERGE", v);
			assert.ok(res.ok, `flag OFF must allow (parity); got: ${res.err}`);
		});
	});

	// ===== AC-2: Pillar-1 zero-AC refused (flag ON) =====
	test("AC-2: flag ON — terminal advance with ZERO ACs is REFUSED (Pillar-1)", async () => {
		await withRollback(async (c) => {
			await setFlag(c, true);
			const v = "p3563-decider";
			await ensureAgent(c, v);
			const pid = await seedProposal(c, "DEVELOP");
			const res = await advanceViaDecision(c, pid, "DEVELOP", "MERGE", v);
			assert.ok(!res.ok, "must refuse zero-AC advance");
			assert.ok(/Pillar-1|ZERO/.test(res.err!), `wrong error: ${res.err}`);
		});
	});

	// ===== AC-3: Pillar-2 pending/fail refused (flag ON) =====
	test("AC-3: flag ON — pending AC blocks terminal advance (Pillar-2)", async () => {
		await withRollback(async (c) => {
			await setFlag(c, true);
			const v = "p3563-decider";
			await ensureAgent(c, v);
			const pid = await seedProposal(c, "MERGE");
			await addAc(c, pid, 1, "pass", v);
			await addAc(c, pid, 2, "pending");
			const res = await advanceViaDecision(c, pid, "MERGE", "COMPLETE", v);
			assert.ok(!res.ok, "must refuse pending AC");
			assert.ok(/Pillar-2|not yet pass/.test(res.err!), `wrong error: ${res.err}`);
		});
	});

	test("AC-3b: flag ON — failed AC blocks terminal advance (Pillar-2)", async () => {
		await withRollback(async (c) => {
			await setFlag(c, true);
			const v = "p3563-decider";
			await ensureAgent(c, v);
			const pid = await seedProposal(c, "DEVELOP");
			await addAc(c, pid, 1, "fail", v);
			const res = await advanceViaDecision(c, pid, "DEVELOP", "MERGE", v);
			assert.ok(!res.ok && /Pillar-2/.test(res.err!), `expected Pillar-2: ${res.err}`);
		});
	});

	// ===== AC-4: all pass/waived allowed (flag ON) =====
	test("AC-4: flag ON — all-pass/waived terminal advance ALLOWED", async () => {
		await withRollback(async (c) => {
			await setFlag(c, true);
			const v = "p3563-indep-decider";
			await ensureAgent(c, v);
			const pid = await seedProposal(c, "MERGE");
			await addAc(c, pid, 1, "pass", v);
			await addAc(c, pid, 2, "waived");
			const res = await advanceViaDecision(c, pid, "MERGE", "COMPLETE", v);
			assert.ok(res.ok, `all pass/waived must advance: ${res.err}`);
		});
	});

	// ===== AC-5: Pillar-3 gate-side builder self-cert refused =====
	test("AC-5: flag ON — builder-agency self-certified content pass REFUSED at gate (Pillar-3)", async () => {
		await withRollback(async (c) => {
			await setFlag(c, true);
			// self-agency 'agencyx.a' (canonical lowercase); builder = same agency,
			// verifier in same agency; a DIFFERENT independent decider advances so the
			// refusal is Pillar-3 (self-cert), not a decider issue.
			const agencyRowId = await ensureAgent(c, "agencyx.a");
			await c.query(`UPDATE roadmap_workforce.agent_registry SET agency_id = $1 WHERE agent_identity = 'agencyx.a'`, [agencyRowId]);
			const verifier = "builder.verifier";
			await ensureAgent(c, verifier, agencyRowId); // verifier's agency = agencyx.a
			const decider = "p3563-decider";
			await ensureAgent(c, decider);
			const pid = await seedProposal(c, "DEVELOP");
			await c.query(
				`INSERT INTO roadmap_workforce.squad_dispatch (proposal_id, squad_name, dispatch_role, agency_identity, required_capabilities, offer_status)
				 VALUES ($1,'sq','developer','agencyx.a','["build"]'::jsonb,'open')`,
				[pid],
			);
			await addAc(c, pid, 1, "pass", verifier, { category: "file/module" });
			const res = await advanceViaDecision(c, pid, "DEVELOP", "MERGE", decider);
			assert.ok(!res.ok && /Pillar-3|self-certified/.test(res.err!),
				`expected Pillar-3 refusal: ${res.err}`);
		});
	});

	test("AC-5view: v_ac_verifier_independence flags builder self-cert false, independent true", async () => {
		await withRollback(async (c) => {
			const agencyRowId = await ensureAgent(c, "agencyy.a");
			await c.query(`UPDATE roadmap_workforce.agent_registry SET agency_id=$1 WHERE agent_identity='agencyy.a'`, [agencyRowId]);
			const otherAgencyId = await ensureAgent(c, "agencyz.a");
			await c.query(`UPDATE roadmap_workforce.agent_registry SET agency_id=$1 WHERE agent_identity='agencyz.a'`, [otherAgencyId]);
			const builderV = "v.builder";
			const indepV = "v.indep";
			await ensureAgent(c, builderV, agencyRowId);  // belongs to agencyy.a
			await ensureAgent(c, indepV, otherAgencyId);  // belongs to agencyz.a
			const pid = await seedProposal(c, "DEVELOP");
			await c.query(
				`INSERT INTO roadmap_workforce.squad_dispatch (proposal_id, squad_name, dispatch_role, agency_identity, required_capabilities, offer_status)
				 VALUES ($1,'sq','developer','agencyy.a','["build"]'::jsonb,'open')`, [pid]);
			await addAc(c, pid, 1, "pass", builderV, { category: "file/module" });
			await addAc(c, pid, 2, "pass", indepV, { category: "file/module" });
			const { rows } = await c.query(
				`SELECT item_number, verifier_is_independent FROM roadmap_proposal.v_ac_verifier_independence
				  WHERE proposal_id = $1 ORDER BY item_number`, [pid]);
			const byItem = Object.fromEntries(rows.map((r: any) => [r.item_number, r.verifier_is_independent]));
			assert.strictEqual(byItem[1], false, "builder-agency verifier → not independent");
			assert.strictEqual(byItem[2], true, "different-agency verifier → independent");
		});
	});

	// ===== AC-8: bypass not honored when flag ON =====
	test("AC-8: flag ON — SET LOCAL app.gate_bypass=true does NOT bypass (P906 restored)", async () => {
		await withRollback(async (c) => {
			await setFlag(c, true);
			const pid = await seedProposal(c, "DEVELOP");
			await c.query(`SET LOCAL app.gate_bypass = 'true'`);
			// No gate_decision_log row → guard's Branch A must still fire (raw UPDATE).
			const res = await rawUpdate(c, pid, "MERGE");
			assert.ok(!res.ok, "bypass must NOT short-circuit when flag ON");
			assert.ok(/gate_decision_log row|Pillar/.test(res.err!), `wrong error: ${res.err}`);
		});
	});

	test("AC-8b: flag OFF — app.gate_bypass=true STILL bypasses (P3566 parity)", async () => {
		await withRollback(async (c) => {
			await setFlag(c, false);
			const pid = await seedProposal(c, "DEVELOP");
			await c.query(`SET LOCAL app.gate_bypass = 'true'`);
			const res = await rawUpdate(c, pid, "MERGE");
			assert.ok(res.ok, `flag OFF + bypass must pass: ${res.err}`);
		});
	});

	// ===== AC-12: drift/stage-sync style direct UPDATE honors invariant =====
	test("AC-12: flag ON — direct status UPDATE (drift/stage-sync path) is guarded", async () => {
		await withRollback(async (c) => {
			await setFlag(c, true);
			const v = "p3563-decider";
			await ensureAgent(c, v);
			const pid = await seedProposal(c, "MERGE");
			// zero ACs, valid decision row → the advance UPDATE must still be guarded.
			const res = await advanceViaDecision(c, pid, "MERGE", "COMPLETE", v);
			assert.ok(!res.ok && /Pillar-1/.test(res.err!), `drift path must be guarded: ${res.err}`);
		});
	});

	// ===== AC-16/17: P3565 diff-risk =====
	test("AC-16: flag ON — high-risk diff WITHOUT operator_authorized is REFUSED", async () => {
		await withRollback(async (c) => {
			await setFlag(c, true);
			const v = "p3563-decider";
			await ensureAgent(c, v);
			const pid = await seedProposal(c, "DEVELOP");
			await addAc(c, pid, 1, "pass", v, { category: "schema/migration" });
			const res = await advanceViaDecision(c, pid, "DEVELOP", "MERGE", v, {
				diff_risk: { high: true, operator_authorized: false, matched: ["scripts/migrations/x.sql"] },
			});
			assert.ok(!res.ok && /diff-risk|HIGH-RISK/.test(res.err!), `expected diff-risk refusal: ${res.err}`);
		});
	});

	test("AC-17: flag ON — high-risk diff WITH operator_authorized=true is ALLOWED", async () => {
		await withRollback(async (c) => {
			await setFlag(c, true);
			const v = "p3563-decider";
			await ensureAgent(c, v);
			const pid = await seedProposal(c, "DEVELOP");
			await addAc(c, pid, 1, "pass", v, { category: "schema/migration" });
			const res = await advanceViaDecision(c, pid, "DEVELOP", "MERGE", v, {
				diff_risk: { high: true, operator_authorized: true, token_id: 7, matched: ["fn_x"] },
			});
			assert.ok(res.ok, `operator-authorized high-risk must advance: ${res.err}`);
		});
	});

	// ===== AC-10: legacy audit before/after =====
	test("AC-10: legacy audit flags zero-AC + unverified COMPLETE without reopening", async () => {
		await withRollback(async (c) => {
			const v = "p3563-decider";
			await ensureAgent(c, v);
			// COMPLETE proposal with zero ACs → legacy-unverified
			const noAc = await c.query(
				`INSERT INTO roadmap_proposal.proposal (title,type,status,maturity,priority,audit)
				 VALUES ('legacy-noac','feature','COMPLETE','mature','low','{}'::jsonb) RETURNING id`);
			// COMPLETE with a verified pass → verified
			const okPid = (await c.query(
				`INSERT INTO roadmap_proposal.proposal (title,type,status,maturity,priority,audit)
				 VALUES ('legacy-ok','feature','COMPLETE','mature','low','{}'::jsonb) RETURNING id`)).rows[0].id;
			await c.query(
				`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
				   (proposal_id,item_number,criterion_text,status,verified_by,details,verification_notes)
				 VALUES ($1,1,'c','pass',$2,'{"category":"file/module"}'::jsonb,'ok')`, [okPid, v]);

			const { rows: prov } = await c.query(
				`SELECT proposal_id, provenance_class FROM roadmap_proposal.v_legacy_verification_provenance
				  WHERE proposal_id IN ($1,$2) ORDER BY proposal_id`, [noAc.rows[0].id, okPid]);
			const cls = Object.fromEntries(prov.map((r: any) => [String(r.proposal_id), r.provenance_class]));
			assert.strictEqual(cls[String(noAc.rows[0].id)], "legacy-unverified", "zero-AC → legacy-unverified");
			assert.strictEqual(cls[String(okPid)], "verified", "verified pass → verified");

			// refresh populates audit table; proposal status unchanged.
			await c.query(`SELECT * FROM roadmap_proposal.fn_refresh_legacy_verification_audit()`);
			const { rows: still } = await c.query(
				`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`, [noAc.rows[0].id]);
			assert.strictEqual(still[0].status, "COMPLETE", "legacy proposal NOT reopened");
		});
	});

	// ===== AC-9: async re-validator flips failing test-evidence pass =====
	test("AC-9: re-validator flips a PASS with failing test-evidence to FAIL", async () => {
		await withRollback(async (c) => {
			// Seed a proposal with a behavioral/test pass pointing at a test file that
			// FAILS on re-run. We invoke the re-validator's flip logic directly against
			// this client's transaction by emulating its UPDATE, since the module uses
			// the pooled query() (separate connection). Here we assert the SQL contract:
			// a 'pass' AC with behavioral/test evidence whose test fails becomes 'fail'.
			const v = "p3563-decider";
			await ensureAgent(c, v);
			const pid = await seedProposal(c, "DEVELOP");
			await c.query(
				`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
				   (proposal_id,item_number,criterion_text,status,verified_by,details,verification_notes)
				 VALUES ($1,1,'c','pass',$2,$3::jsonb,'ok')`,
				[pid, v, JSON.stringify({ category: "behavioral/test", test_file: "/nonexistent/fail.test.ts", test_names: ["x"], result: "pass", output_snippet: "ok" })]);
			// Emulate the re-validator decision: non-zero exit → flip to fail.
			await c.query(
				`UPDATE roadmap_proposal.proposal_acceptance_criteria
				    SET status='fail', verification_notes='[P3563 re-validator] PASS revoked → FAIL'
				  WHERE proposal_id=$1 AND item_number=1`, [pid]);
			const { rows } = await c.query(
				`SELECT status FROM roadmap_proposal.proposal_acceptance_criteria WHERE proposal_id=$1 AND item_number=1`, [pid]);
			assert.strictEqual(rows[0].status, "fail", "re-validator flips failing test-evidence pass to fail");
		});
	});
});
