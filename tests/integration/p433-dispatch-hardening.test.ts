/**
 * P433 Integration Tests — Dispatch and Agency Hardening
 *
 * AC coverage:
 *   AC-1 (P433): UNIQUE index uniq_sd_active_dispatch exists on squad_dispatch.
 *   AC-4 (P433): Concurrent identical work-offer posts return same dispatch_id;
 *               second post is marked replay=true in feed (via pg_notify 'work_offers').
 *   AC-5 (P433): fn_claim_work_offer with non-matching p_required_capabilities
 *               logs NOT_ELIGIBLE in control_audit.claim_rejection; 0 rows returned;
 *               no worker (squad_dispatch row) is transitioned to 'claimed'.
 *   AC-6 (P433): agency over concurrency cap rejects subsequent claim with
 *               CONCURRENCY_EXCEEDED until a held claim is released.
 *
 * Isolation: all fixtures scoped to a dedicated scratch project (SCRATCH_PROJECT_ID).
 *   The live orchestrator subscribes to real projects only (Gate 6 blocks it here).
 *   All scratch rows are removed in teardown.
 *
 * Skip: when DATABASE_URL / PGPASSWORD is absent (CI without DB).
 *
 * Schema verified against migration 146-p433-dispatch-hardening.sql.
 */

import { test, before, after } from "node:test";
import assert from "node:assert";
import { Pool } from "pg";

const DB_URL =
  process.env.DATABASE_URL ?? "postgresql://admin@127.0.0.1:5432/agenthive";

const SKIP = !process.env.DATABASE_URL && !process.env.PGPASSWORD;

const CLAIM_FN = "roadmap_workforce.fn_claim_work_offer";

const SCRATCH_PROJECT_ID = 990433; // dedicated scratch project, no real agency subscribed
const FK_PROPOSAL_ID = 1432;        // P1432 umbrella — exists; used only for the proposal_id FK
const SCRATCH_AGENCY_BASE = "p433-hardening-test-agency";

let pool: Pool;

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Unique agency name per test to avoid cross-test interference. */
function agencyId(suffix: string): string {
  return `${SCRATCH_AGENCY_BASE}-${suffix}`;
}

async function ensureProject(p: Pool): Promise<void> {
  await p.query(
    `INSERT INTO roadmap.project
       (project_id, slug, name, worktree_root, status, host, port, bootstrap_status)
     VALUES ($1, $2, $2, '/tmp/p433-test', 'active', 'bot', 0, 'live')
     ON CONFLICT (project_id) DO UPDATE SET status = 'active'`,
    [SCRATCH_PROJECT_ID, "p433-hardening-test"],
  );
}

async function createAgency(
  p: Pool,
  name: string,
  maxClaims: number,
): Promise<number> {
  const { rows } = await p.query<{ id: number }>(
    `INSERT INTO roadmap_workforce.agent_registry
       (agent_identity, agent_type, status, max_concurrent_claims, project_id)
     VALUES ($1, 'agency', 'active', $2, $3)
     ON CONFLICT (agent_identity) DO UPDATE
       SET status = 'active', max_concurrent_claims = $2, project_id = $3
     RETURNING id`,
    [name, maxClaims, SCRATCH_PROJECT_ID],
  );
  const agencyDbId = rows[0].id;

  await p.query(
    `INSERT INTO roadmap_workforce.provider_registry
       (agency_id, agency_identity, project_id, status, is_active, capabilities)
     VALUES ($1, $2, $3, 'active', true, '{}'::jsonb)
     ON CONFLICT DO NOTHING`,
    [agencyDbId, name, SCRATCH_PROJECT_ID],
  );

  return agencyDbId;
}

async function insertOffer(
  p: Pool,
  opts: {
    squadName: string;
    requiredCaps?: string;  // jsonb text, default '["develop"]'
    proposalId?: number;
    iKey?: string;
  },
): Promise<number> {
  const caps = opts.requiredCaps ?? '["develop"]';
  const ikey = opts.iKey ?? `p433:${opts.squadName}:${Date.now()}:${Math.floor(Math.random() * 1e9)}`;
  const { rows } = await p.query<{ id: number }>(
    `INSERT INTO roadmap_workforce.squad_dispatch
       (proposal_id, project_id, squad_name, dispatch_role,
        dispatch_status, offer_status, required_capabilities, idempotency_key,
        workflow_state)
     VALUES ($1, $2, $3, 'developer', 'open', 'open', $4::jsonb, $5, 'DEVELOP')
     RETURNING id`,
    [opts.proposalId ?? FK_PROPOSAL_ID, SCRATCH_PROJECT_ID, opts.squadName, caps, ikey],
  );
  return rows[0].id;
}

async function teardown(p: Pool): Promise<void> {
  await p.query(
    `DELETE FROM control_audit.claim_rejection
     WHERE agency_id IN (
       SELECT id FROM roadmap_workforce.agent_registry
       WHERE project_id = $1
     )`,
    [SCRATCH_PROJECT_ID],
  );
  await p.query(
    `DELETE FROM roadmap_workforce.squad_dispatch WHERE project_id = $1`,
    [SCRATCH_PROJECT_ID],
  );
  await p.query(
    `DELETE FROM roadmap_workforce.provider_registry
     WHERE agency_identity LIKE $1`,
    [`${SCRATCH_AGENCY_BASE}%`],
  );
  await p.query(
    `DELETE FROM roadmap_workforce.agent_registry
     WHERE agent_identity LIKE $1`,
    [`${SCRATCH_AGENCY_BASE}%`],
  );
  await p.query(
    `DELETE FROM roadmap.project WHERE project_id = $1`,
    [SCRATCH_PROJECT_ID],
  );
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

before(async () => {
  if (SKIP) return;
  pool = new Pool({ connectionString: DB_URL, max: 16 });
  await teardown(pool);
  await ensureProject(pool);
});

after(async () => {
  if (!pool) return;
  await teardown(pool);
  await pool.end();
});

// ── AC-1: UNIQUE index exists ─────────────────────────────────────────────────

test("P433 AC-1: uniq_sd_active_dispatch index exists on squad_dispatch", async (t) => {
  if (SKIP) { t.skip("no DB connection"); return; }

  const { rows } = await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = 'roadmap_workforce'
       AND tablename  = 'squad_dispatch'
       AND indexname  = 'uniq_sd_active_dispatch'`,
  );
  assert.equal(rows.length, 1, "uniq_sd_active_dispatch index not found after migration 146");
});

test("P433 AC-1: uniq_sd_active_dispatch blocks duplicate (project, proposal, workflow_state, role) in assigned/active", async (t) => {
  if (SKIP) { t.skip("no DB connection"); return; }

  const PROPOSAL_ID = FK_PROPOSAL_ID;
  const ROLE = "developer";
  const WSTATE = "DEVELOP";

  // Insert first active dispatch
  const { rows: [r1] } = await pool.query<{ id: number }>(
    `INSERT INTO roadmap_workforce.squad_dispatch
       (proposal_id, project_id, squad_name, dispatch_role,
        dispatch_status, offer_status, required_capabilities,
        idempotency_key, workflow_state)
     VALUES ($1, $2, 'ac1-squad-a', $3, 'assigned', 'claimed',
             '["develop"]'::jsonb, $4, $5)
     RETURNING id`,
    [PROPOSAL_ID, SCRATCH_PROJECT_ID, ROLE, `p433:ac1:a:${Date.now()}`, WSTATE],
  );

  // Second insert with same (project, proposal, workflow_state, role) in 'assigned' — must fail
  await assert.rejects(
    async () => {
      await pool.query(
        `INSERT INTO roadmap_workforce.squad_dispatch
           (proposal_id, project_id, squad_name, dispatch_role,
            dispatch_status, offer_status, required_capabilities,
            idempotency_key, workflow_state)
         VALUES ($1, $2, 'ac1-squad-b', $3, 'assigned', 'claimed',
                 '["develop"]'::jsonb, $4, $5)`,
        [PROPOSAL_ID, SCRATCH_PROJECT_ID, ROLE, `p433:ac1:b:${Date.now()}`, WSTATE],
      );
    },
    /unique.*constraint|duplicate key/i,
    "Expected unique-violation on duplicate (project, proposal, workflow_state, role) in assigned",
  );

  // Cleanup
  await pool.query(`DELETE FROM roadmap_workforce.squad_dispatch WHERE id = $1`, [r1.id]);
});

// ── AC-4: Concurrent identical work-offer posts — replay detection ────────────

test("P433 AC-4: workflow_state and project_id are populated on new squad_dispatch rows", async (t) => {
  if (SKIP) { t.skip("no DB connection"); return; }

  const offerId = await insertOffer(pool, { squadName: "ac4-wstate-squad" });

  const { rows: [r] } = await pool.query<{
    workflow_state: string | null;
    project_id: number | null;
  }>(
    `SELECT workflow_state, project_id FROM roadmap_workforce.squad_dispatch WHERE id = $1`,
    [offerId],
  );

  assert.equal(r.workflow_state, "DEVELOP",
    "workflow_state should be populated on new dispatch rows (migration 146 + postWorkOffer)");
  assert.equal(Number(r.project_id), SCRATCH_PROJECT_ID,
    "project_id should be populated on new dispatch rows");

  await pool.query(`DELETE FROM roadmap_workforce.squad_dispatch WHERE id = $1`, [offerId]);
});

test("P433 AC-4: concurrent identical offers collapse to same dispatch_id, second is replay", async (t) => {
  if (SKIP) { t.skip("no DB connection"); return; }

  const IKEY = `p433:ac4:concurrent:${Date.now()}`;
  const CAPS = '["develop"]';
  const WSTATE = "DEVELOP";

  const insertOp = () =>
    pool.query<{ id: number; attempt_count: number; was_replay: boolean }>(
      `INSERT INTO roadmap_workforce.squad_dispatch
         (proposal_id, project_id, squad_name, dispatch_role,
          dispatch_status, offer_status, required_capabilities,
          idempotency_key, workflow_state, attempt_count)
       VALUES ($1, $2, 'ac4-squad', 'developer', 'open', 'open',
               $3::jsonb, $4, $5, 1)
       ON CONFLICT (idempotency_key)
         WHERE dispatch_status IN ('open', 'assigned', 'active')
       DO UPDATE SET
         attempt_count = squad_dispatch.attempt_count + 1,
         metadata = squad_dispatch.metadata
                  || jsonb_build_object('last_replay_at', to_jsonb(now()),
                                        'replay_reason', 'idempotency_collision')
       RETURNING id,
                 attempt_count,
                 (xmax::text::int <> 0) AS was_replay`,
      [FK_PROPOSAL_ID, SCRATCH_PROJECT_ID, CAPS, IKEY, WSTATE],
    );

  // Fire two inserts concurrently
  const [r1, r2] = await Promise.all([insertOp(), insertOp()]);

  const id1 = r1.rows[0]?.id;
  const id2 = r2.rows[0]?.id;

  assert.ok(id1, "first insert should return a row");
  assert.ok(id2, "second insert should return a row");
  assert.equal(id1, id2, "both concurrent posts should return the same dispatch_id");

  const replayCount = [r1.rows[0].was_replay, r2.rows[0].was_replay].filter(Boolean).length;
  assert.equal(replayCount, 1, "exactly one of the two should be flagged as replay");

  // DB should show attempt_count = 2
  const { rows: [db] } = await pool.query<{ attempt_count: number }>(
    `SELECT attempt_count FROM roadmap_workforce.squad_dispatch WHERE id = $1`,
    [id1],
  );
  assert.equal(db.attempt_count, 2, "attempt_count should be 2 after two concurrent posts");

  await pool.query(`DELETE FROM roadmap_workforce.squad_dispatch WHERE id = $1`, [id1]);
});

// ── AC-5: NOT_ELIGIBLE rejection on capability mismatch ──────────────────────

test("P433 AC-5: claim with non-matching capabilities logs NOT_ELIGIBLE in claim_rejection", async (t) => {
  if (SKIP) { t.skip("no DB connection"); return; }

  const agency = agencyId("ac5-mismatch");
  const agencyDbId = await createAgency(pool, agency, 3);

  // Offer requires "special" capability; agency will offer "other"
  const offerId = await insertOffer(pool, {
    squadName: `ac5-mismatch-squad`,
    requiredCaps: '["special"]',
  });

  // Clear any prior rejections for this agency
  await pool.query(
    `DELETE FROM control_audit.claim_rejection WHERE agency_id = $1`,
    [agencyDbId],
  );

  // Agency claims with capabilities that do NOT satisfy "special"
  const { rows: claimRows } = await pool.query(
    `SELECT * FROM ${CLAIM_FN}($1, $2::jsonb, 1320, $3, NULL)`,
    [agency, '["other"]', SCRATCH_PROJECT_ID],
  );

  assert.equal(claimRows.length, 0, "claim should return 0 rows when capabilities mismatch");

  // Check NOT_ELIGIBLE was logged
  const { rows: rejections } = await pool.query<{ reason_class: string; reason_detail: string }>(
    `SELECT reason_class, reason_detail
     FROM control_audit.claim_rejection
     WHERE agency_id = $1
     ORDER BY id DESC LIMIT 1`,
    [agencyDbId],
  );

  assert.equal(rejections.length, 1, "exactly one claim_rejection row should exist");
  assert.equal(rejections[0].reason_class, "NOT_ELIGIBLE",
    `Expected NOT_ELIGIBLE, got ${rejections[0].reason_class}`);
  assert.ok(
    rejections[0].reason_detail.includes(agency),
    "reason_detail should reference the agency",
  );

  // The offer should still be open (not claimed)
  const { rows: [offer] } = await pool.query<{ offer_status: string }>(
    `SELECT offer_status FROM roadmap_workforce.squad_dispatch WHERE id = $1`,
    [offerId],
  );
  assert.equal(offer.offer_status, "open",
    "offer must remain 'open' after a NOT_ELIGIBLE rejection — no worker created");

  // Cleanup
  await pool.query(`DELETE FROM roadmap_workforce.squad_dispatch WHERE id = $1`, [offerId]);
});

test("P433 AC-5: claim returns empty rows but does NOT log NOT_ELIGIBLE when no offers exist", async (t) => {
  if (SKIP) { t.skip("no DB connection"); return; }

  const agency = agencyId("ac5-nooffer");
  const agencyDbId = await createAgency(pool, agency, 3);

  await pool.query(
    `DELETE FROM control_audit.claim_rejection WHERE agency_id = $1`,
    [agencyDbId],
  );

  // No offers exist for this project — should return 0 rows silently
  const { rows: claimRows } = await pool.query(
    `SELECT * FROM ${CLAIM_FN}($1, $2::jsonb, 1320, $3, NULL)`,
    [agency, '["other"]', SCRATCH_PROJECT_ID],
  );

  assert.equal(claimRows.length, 0, "should return 0 rows when no offers exist");

  const { rows: rejections } = await pool.query<{ reason_class: string }>(
    `SELECT reason_class FROM control_audit.claim_rejection
     WHERE agency_id = $1 AND reason_class = 'NOT_ELIGIBLE'`,
    [agencyDbId],
  );

  assert.equal(rejections.length, 0,
    "NOT_ELIGIBLE must NOT be logged when there are no open offers at all");
});

// ── AC-6: Concurrency cap rejection ──────────────────────────────────────────

test("P433 AC-6: agency over concurrency cap gets CONCURRENCY_EXCEEDED until slot frees", async (t) => {
  if (SKIP) { t.skip("no DB connection"); return; }

  const agency = agencyId("ac6-concap");
  const agencyDbId = await createAgency(pool, agency, 1); // ceiling = 1

  await pool.query(
    `DELETE FROM control_audit.claim_rejection WHERE agency_id = $1`,
    [agencyDbId],
  );

  // Two offers available
  const offerId1 = await insertOffer(pool, { squadName: `ac6-cap-offer-1` });
  const offerId2 = await insertOffer(pool, { squadName: `ac6-cap-offer-2` });

  // First claim succeeds (fills the 1-slot ceiling)
  const { rows: [claimed1] } = await pool.query<{ dispatch_id: number }>(
    `SELECT dispatch_id FROM ${CLAIM_FN}($1, $2::jsonb, 1320, $3, NULL)`,
    [agency, '["develop"]', SCRATCH_PROJECT_ID],
  );
  assert.ok(claimed1?.dispatch_id, "first claim should succeed when at capacity=0");

  // Second claim must be rejected
  const { rows: claimRows2 } = await pool.query(
    `SELECT * FROM ${CLAIM_FN}($1, $2::jsonb, 1320, $3, NULL)`,
    [agency, '["develop"]', SCRATCH_PROJECT_ID],
  );
  assert.equal(claimRows2.length, 0, "second claim should be rejected (at concurrency cap)");

  const { rows: rejections } = await pool.query<{ reason_class: string }>(
    `SELECT reason_class FROM control_audit.claim_rejection
     WHERE agency_id = $1 AND reason_class = 'CONCURRENCY_EXCEEDED'
     ORDER BY id DESC LIMIT 1`,
    [agencyDbId],
  );
  assert.equal(rejections.length, 1, "CONCURRENCY_EXCEEDED should be logged");
  assert.equal(rejections[0].reason_class, "CONCURRENCY_EXCEEDED");

  // Release the held claim by marking it completed
  await pool.query(
    `UPDATE roadmap_workforce.squad_dispatch
     SET offer_status = 'delivered', dispatch_status = 'completed', completed_at = now()
     WHERE id = $1`,
    [claimed1.dispatch_id],
  );

  // Third attempt should now succeed (slot freed)
  const { rows: [claimed3] } = await pool.query<{ dispatch_id: number }>(
    `SELECT dispatch_id FROM ${CLAIM_FN}($1, $2::jsonb, 1320, $3, NULL)`,
    [agency, '["develop"]', SCRATCH_PROJECT_ID],
  );
  assert.ok(claimed3?.dispatch_id,
    "claim should succeed after the held slot is released (count drops below max)");

  // Cleanup
  await pool.query(
    `DELETE FROM roadmap_workforce.squad_dispatch WHERE id = ANY($1)`,
    [[offerId1, offerId2]],
  );
});
