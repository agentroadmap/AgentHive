/**
 * P440 Integration Tests — Dispatch Retry and Terminal Semantics
 *
 * AC coverage:
 *   AC-1: squad_dispatch.dispatch_status accepts P440 values (posted, claimed,
 *         running, retry_wait) plus all legacy values.
 *   AC-2: squad_dispatch has attempt_count, last_attempt_at, next_retry_at,
 *         retry_policy_ref columns.
 *   AC-3: retry_policy table exists with required columns and seeded default row.
 *   AC-4: fn_record_dispatch_failure classifies retryable errors → retry_wait;
 *         non-retryable errors → failed + pg_notify reissue_required.
 *   AC-5: Terminal dispatches cannot be claimed (fn_claim_work_offer skips them)
 *         and fn_record_dispatch_failure raises on terminal rows.
 *   AC-6: 3 retryable failures increment attempt_count on the SAME dispatch row
 *         (no replacement rows). 4th failure (exceeding max_attempts=3) sets
 *         status=failed and emits reissue_required pg_notify.
 *
 * Prerequisites: migration 068 applied, PGPASSWORD set.
 * Skip gracefully when DB is unavailable.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { Pool, type PoolClient } from "pg";

const SKIP = !process.env.PGPASSWORD;
const skip = (name: string, fn: () => Promise<void>) =>
  SKIP ? it.skip(name, fn) : it(name, fn);

let pool: Pool;

before(async () => {
  if (SKIP) return;
  pool = new Pool({
    host:     process.env.PGHOST     ?? "127.0.0.1",
    port:     Number(process.env.PGPORT ?? 5432),
    user:     process.env.PGUSER     ?? "xiaomi",
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE ?? "agenthive",
    max:      5,
  });
});

after(async () => {
  if (!pool) return;
  await pool.end();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function anyProject(client: Pool | PoolClient): Promise<number> {
  const { rows } = await client.query<{ project_id: number }>(
    "SELECT project_id FROM roadmap.project LIMIT 1"
  );
  if (!rows[0]) throw new Error("No project rows found — is the DB seeded?");
  return rows[0].project_id;
}

interface ScratchFixture {
  agentId: number;
  agentIdentity: string;
  policyId: number;
  dispatchId: number;
}

/**
 * Creates a minimal scratch agent + retry policy + dispatch row for tests.
 * Caller is responsible for cleanup via teardownScratch().
 */
async function setupScratch(
  tag: string,
  maxAttempts = 3,
  retryableClasses = '["TIMEOUT"]'
): Promise<ScratchFixture> {
  const agentIdentity = `p440-agent-${tag}-${Date.now()}`;
  const projectId = await anyProject(pool);

  // Create scratch agent
  const { rows: [agentRow] } = await pool.query<{ id: number }>(`
    INSERT INTO roadmap_workforce.agent_registry
      (agent_identity, agent_type, status, availability, capabilities,
       model, provider, cost_class)
    VALUES ($1, 'agency', 'active', 'idle', '[]',
            'test-model', 'test-provider', 'low')
    RETURNING id
  `, [agentIdentity]);
  const agentId = agentRow.id;

  // Give agent a project scope so fn_claim_work_offer doesn't reject it
  await pool.query(`
    INSERT INTO roadmap_workforce.provider_registry
      (agency_id, agency_identity, project_id, capabilities, status, is_active)
    VALUES ($1, $2, $3, '[]', 'active', true)
    ON CONFLICT DO NOTHING
  `, [agentId, agentIdentity, projectId]);

  // Create test retry policy
  const { rows: [policyRow] } = await pool.query<{ policy_id: number }>(`
    INSERT INTO roadmap_workforce.retry_policy
      (policy_name, max_attempts, base_cooldown_seconds, backoff_multiplier,
       retryable_error_classes)
    VALUES ($1, $2, 1, 1.0, $3::jsonb)
    RETURNING policy_id
  `, [`p440-policy-${tag}-${Date.now()}`, maxAttempts, retryableClasses]);
  const policyId = policyRow.policy_id;

  // Create test dispatch row with retry_policy_ref
  const { rows: [dispatchRow] } = await pool.query<{ id: number }>(`
    INSERT INTO roadmap_workforce.squad_dispatch
      (proposal_id, agent_identity, squad_name, dispatch_role,
       dispatch_status, offer_status, required_capabilities,
       project_id, retry_policy_ref)
    VALUES (1, $1, 'p440-squad', 'developer',
            'running', 'active', '["general"]'::jsonb,
            $2, $3)
    RETURNING id
  `, [agentIdentity, projectId, policyId]);

  return { agentId, agentIdentity, policyId, dispatchId: dispatchRow.id };
}

async function teardownScratch(fixture: ScratchFixture): Promise<void> {
  // Cascade order: dispatch → provider_registry → agent_registry → policy
  await pool.query(
    "DELETE FROM roadmap_workforce.squad_dispatch WHERE id = $1",
    [fixture.dispatchId]
  ).catch(() => { /* already deleted or cascaded */ });

  await pool.query(
    "DELETE FROM control_audit.claim_rejection WHERE agency_id = $1",
    [fixture.agentId]
  ).catch(() => { /* ok */ });

  await pool.query(
    "DELETE FROM roadmap_workforce.provider_registry WHERE agency_id = $1",
    [fixture.agentId]
  ).catch(() => { /* ok */ });

  await pool.query(
    "DELETE FROM roadmap_workforce.agent_registry WHERE id = $1",
    [fixture.agentId]
  ).catch(() => { /* ok */ });

  await pool.query(
    "DELETE FROM roadmap_workforce.retry_policy WHERE policy_id = $1",
    [fixture.policyId]
  ).catch(() => { /* ok */ });
}

// ─── AC-1: dispatch_status enum values ───────────────────────────────────────

describe("AC-1: dispatch_status CHECK constraint accepts P440 and legacy values", () => {
  skip("squad_dispatch_status_check constraint exists", async () => {
    const { rows } = await pool.query<{ conname: string }>(`
      SELECT conname FROM pg_constraint
      WHERE conname  = 'squad_dispatch_status_check'
        AND conrelid = 'roadmap_workforce.squad_dispatch'::regclass
    `);
    assert.equal(rows.length, 1, "squad_dispatch_status_check not found");
  });

  const validStatuses = [
    // P440 canonical
    "posted", "claimed", "running", "retry_wait",
    // terminal
    "failed", "cancelled", "completed",
    // legacy (backward compat)
    "open", "assigned", "active", "blocked",
  ];

  for (const status of validStatuses) {
    skip(`INSERT with dispatch_status='${status}' is accepted`, async () => {
      const projectId = await anyProject(pool);

      const { rows } = await pool.query<{ id: number }>(`
        INSERT INTO roadmap_workforce.squad_dispatch
          (proposal_id, squad_name, dispatch_role, dispatch_status,
           offer_status, required_capabilities, project_id)
        VALUES (1, 'ac1-squad', 'tester', $1, 'delivered', '["general"]'::jsonb, $2)
        RETURNING id
      `, [status, projectId]);

      assert.ok(rows[0]?.id, `INSERT with dispatch_status='${status}' should succeed`);
      await pool.query("DELETE FROM roadmap_workforce.squad_dispatch WHERE id = $1", [rows[0].id]);
    });
  }

  skip("INSERT with unknown dispatch_status raises CHECK violation", async () => {
    const projectId = await anyProject(pool);
    await assert.rejects(
      () => pool.query(`
        INSERT INTO roadmap_workforce.squad_dispatch
          (proposal_id, squad_name, dispatch_role, dispatch_status,
           offer_status, required_capabilities, project_id)
        VALUES (1, 'ac1-squad', 'tester', 'invalid_status', 'delivered', '["general"]'::jsonb, $1)
      `, [projectId]),
      /check.*violation|constraint/i,
      "Expected CHECK violation for unknown dispatch_status"
    );
  });
});

// ─── AC-2: squad_dispatch retry columns ──────────────────────────────────────

describe("AC-2: squad_dispatch has all P440 retry columns", () => {
  const requiredColumns = [
    "attempt_count", "last_attempt_at", "next_retry_at", "retry_policy_ref",
  ];

  skip("all four retry columns exist on squad_dispatch", async () => {
    const { rows } = await pool.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'roadmap_workforce'
        AND table_name   = 'squad_dispatch'
        AND column_name IN ('attempt_count','last_attempt_at','next_retry_at','retry_policy_ref')
    `);
    const found = rows.map(r => r.column_name).sort();
    assert.deepEqual(
      found,
      [...requiredColumns].sort(),
      `Missing columns: ${requiredColumns.filter(c => !found.includes(c)).join(", ")}`
    );
  });

  skip("attempt_count defaults to 0 on new rows", async () => {
    const projectId = await anyProject(pool);
    const { rows } = await pool.query<{ id: number; attempt_count: number }>(`
      INSERT INTO roadmap_workforce.squad_dispatch
        (proposal_id, squad_name, dispatch_role, dispatch_status,
         offer_status, required_capabilities, project_id)
      VALUES (1, 'ac2-squad', 'tester', 'posted', 'open', '["general"]'::jsonb, $1)
      RETURNING id, attempt_count
    `, [projectId]);

    assert.equal(rows[0].attempt_count, 0, "attempt_count should default to 0");
    await pool.query("DELETE FROM roadmap_workforce.squad_dispatch WHERE id = $1", [rows[0].id]);
  });

  skip("attempt_count rejects negative values", async () => {
    const projectId = await anyProject(pool);

    const { rows } = await pool.query<{ id: number }>(`
      INSERT INTO roadmap_workforce.squad_dispatch
        (proposal_id, squad_name, dispatch_role, dispatch_status,
         offer_status, required_capabilities, project_id)
      VALUES (1, 'ac2-neg-squad', 'tester', 'posted', 'open', '["general"]'::jsonb, $1)
      RETURNING id
    `, [projectId]);

    await assert.rejects(
      () => pool.query(
        "UPDATE roadmap_workforce.squad_dispatch SET attempt_count = -1 WHERE id = $1",
        [rows[0].id]
      ),
      /check.*violation|constraint/i,
      "Expected CHECK violation for negative attempt_count"
    );

    await pool.query("DELETE FROM roadmap_workforce.squad_dispatch WHERE id = $1", [rows[0].id]);
  });
});

// ─── AC-3: retry_policy table ────────────────────────────────────────────────

describe("AC-3: retry_policy table exists with required columns and default row", () => {
  skip("retry_policy table exists in roadmap_workforce schema", async () => {
    const { rows } = await pool.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'roadmap_workforce'
        AND table_name   = 'retry_policy'
    `);
    assert.equal(rows.length, 1, "retry_policy table not found");
  });

  skip("retry_policy has all required columns", async () => {
    const expected = [
      "policy_id", "policy_name", "max_attempts",
      "base_cooldown_seconds", "backoff_multiplier",
      "retryable_error_classes", "created_at",
    ];
    const { rows } = await pool.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'roadmap_workforce'
        AND table_name   = 'retry_policy'
        AND column_name IN (${expected.map((_, i) => `$${i + 1}`).join(",")})
    `, expected);

    const found = rows.map(r => r.column_name).sort();
    assert.deepEqual(found, [...expected].sort(),
      `Missing columns: ${expected.filter(c => !found.includes(c)).join(", ")}`
    );
  });

  skip("default retry_policy row exists with sensible values", async () => {
    const { rows } = await pool.query<{
      max_attempts: number;
      retryable_error_classes: string;
    }>(`
      SELECT max_attempts, retryable_error_classes::text
      FROM roadmap_workforce.retry_policy
      WHERE policy_name = 'default'
    `);
    assert.equal(rows.length, 1, "default retry_policy row not found");
    assert.ok(rows[0].max_attempts > 0, "default max_attempts must be > 0");
  });

  skip("max_attempts CHECK rejects zero", async () => {
    await assert.rejects(
      () => pool.query(`
        INSERT INTO roadmap_workforce.retry_policy
          (policy_name, max_attempts, base_cooldown_seconds, backoff_multiplier,
           retryable_error_classes)
        VALUES ('bad-zero', 0, 30, 2.0, '[]')
      `),
      /check.*violation|constraint/i,
      "Expected CHECK violation for max_attempts=0"
    );
  });

  skip("backoff_multiplier CHECK rejects values less than 1.0", async () => {
    await assert.rejects(
      () => pool.query(`
        INSERT INTO roadmap_workforce.retry_policy
          (policy_name, max_attempts, base_cooldown_seconds, backoff_multiplier,
           retryable_error_classes)
        VALUES ('bad-mult', 3, 30, 0.5, '[]')
      `),
      /check.*violation|constraint/i,
      "Expected CHECK violation for backoff_multiplier=0.5"
    );
  });
});

// ─── AC-4: fn_record_dispatch_failure — retryable vs non-retryable ───────────

describe("AC-4: fn_record_dispatch_failure classifies errors correctly", () => {
  skip("retryable error → retry_wait + offer_status=expired + next_retry_at set", async () => {
    const fixture = await setupScratch("ac4-retry", 5, '["TIMEOUT"]');
    try {
      const { rows } = await pool.query<{
        out_dispatch_status: string;
        out_attempt_count: number;
        out_next_retry_at: string | null;
      }>(`
        SELECT * FROM roadmap_workforce.fn_record_dispatch_failure($1, 'TIMEOUT', 'test timeout')
      `, [fixture.dispatchId]);

      assert.equal(rows[0].out_dispatch_status, "retry_wait");
      assert.equal(rows[0].out_attempt_count, 1);
      assert.ok(rows[0].out_next_retry_at != null, "next_retry_at should be set for retry_wait");

      // Verify the row was actually updated.
      const { rows: [row] } = await pool.query<{
        dispatch_status: string;
        offer_status: string;
        attempt_count: number;
        next_retry_at: string | null;
      }>(`
        SELECT dispatch_status, offer_status, attempt_count, next_retry_at
        FROM roadmap_workforce.squad_dispatch
        WHERE id = $1
      `, [fixture.dispatchId]);

      assert.equal(row.dispatch_status, "retry_wait");
      assert.equal(row.offer_status, "expired");
      assert.equal(row.attempt_count, 1);
      assert.ok(row.next_retry_at != null, "next_retry_at should be persisted");
    } finally {
      await teardownScratch(fixture);
    }
  });

  skip("non-retryable error → failed + offer_status=failed + next_retry_at null", async () => {
    const fixture = await setupScratch("ac4-nonretry", 5, '["TIMEOUT"]');
    try {
      const { rows } = await pool.query<{
        out_dispatch_status: string;
        out_attempt_count: number;
        out_next_retry_at: string | null;
      }>(`
        SELECT * FROM roadmap_workforce.fn_record_dispatch_failure($1, 'FATAL_ERROR', 'non-retryable')
      `, [fixture.dispatchId]);

      assert.equal(rows[0].out_dispatch_status, "failed");
      assert.equal(rows[0].out_attempt_count, 1);
      assert.equal(rows[0].out_next_retry_at, null);

      const { rows: [row] } = await pool.query<{
        dispatch_status: string;
        offer_status: string;
      }>(`
        SELECT dispatch_status, offer_status
        FROM roadmap_workforce.squad_dispatch WHERE id = $1
      `, [fixture.dispatchId]);

      assert.equal(row.dispatch_status, "failed");
      assert.equal(row.offer_status, "failed");
    } finally {
      await teardownScratch(fixture);
    }
  });
});

// ─── AC-5: Terminal dispatches cannot be claimed / re-failed ─────────────────

describe("AC-5: terminal dispatch_status rows are immutable", () => {
  skip("fn_record_dispatch_failure raises on already-failed dispatch", async () => {
    const fixture = await setupScratch("ac5-terminal", 5, '["TIMEOUT"]');
    try {
      // Drive to failed
      await pool.query(
        "UPDATE roadmap_workforce.squad_dispatch SET dispatch_status='failed' WHERE id = $1",
        [fixture.dispatchId]
      );

      await assert.rejects(
        () => pool.query(`
          SELECT * FROM roadmap_workforce.fn_record_dispatch_failure($1, 'TIMEOUT', 'should fail')
        `, [fixture.dispatchId]),
        /terminal state|invalid_parameter_value/i,
        "Expected exception when recording failure on a terminal dispatch"
      );
    } finally {
      await teardownScratch(fixture);
    }
  });

  skip("fn_record_dispatch_failure raises on cancelled dispatch", async () => {
    const fixture = await setupScratch("ac5-cancelled", 5, '["TIMEOUT"]');
    try {
      await pool.query(
        "UPDATE roadmap_workforce.squad_dispatch SET dispatch_status='cancelled' WHERE id = $1",
        [fixture.dispatchId]
      );

      await assert.rejects(
        () => pool.query(`
          SELECT * FROM roadmap_workforce.fn_record_dispatch_failure($1, 'TIMEOUT', 'should fail')
        `, [fixture.dispatchId]),
        /terminal state|invalid_parameter_value/i,
        "Expected exception on cancelled dispatch"
      );
    } finally {
      await teardownScratch(fixture);
    }
  });

  skip("fn_claim_work_offer skips dispatches with terminal dispatch_status", async () => {
    const projectId = await anyProject(pool);
    const agentIdentity = `p440-claim-terminal-${Date.now()}`;

    let agentId: number | undefined;
    let dispatchId: number | undefined;

    try {
      // Create agent
      const { rows: [ar] } = await pool.query<{ id: number }>(`
        INSERT INTO roadmap_workforce.agent_registry
          (agent_identity, agent_type, status, availability, capabilities,
           model, provider, cost_class)
        VALUES ($1, 'agency', 'active', 'idle', '["general"]',
                'test-model', 'test-provider', 'low')
        RETURNING id
      `, [agentIdentity]);
      agentId = ar.id;

      // Register project scope
      await pool.query(`
        INSERT INTO roadmap_workforce.provider_registry
          (agency_id, agency_identity, project_id, capabilities, status, is_active)
        VALUES ($1, $2, $3, '["general"]', 'active', true)
        ON CONFLICT DO NOTHING
      `, [agentId, agentIdentity, projectId]);

      // Create a dispatch that looks open but has terminal dispatch_status
      const { rows: [dr] } = await pool.query<{ id: number }>(`
        INSERT INTO roadmap_workforce.squad_dispatch
          (proposal_id, agent_identity, squad_name, dispatch_role,
           dispatch_status, offer_status, required_capabilities, project_id)
        VALUES (1, $1, 'terminal-squad', 'tester',
                'failed', 'open', '["general"]'::jsonb, $2)
        RETURNING id
      `, [agentIdentity, projectId]);
      dispatchId = dr.id;

      // Attempt to claim — should get 0 rows because dispatch_status='failed'
      const { rows: claimRows } = await pool.query(`
        SELECT * FROM roadmap_workforce.fn_claim_work_offer($1, '["general"]'::jsonb, 20, $2)
      `, [agentIdentity, projectId]);

      assert.equal(
        claimRows.filter((r: { dispatch_id: number }) => r.dispatch_id === dispatchId).length,
        0,
        "Terminal dispatch row should not be claimable"
      );
    } finally {
      if (dispatchId) {
        await pool.query("DELETE FROM roadmap_workforce.squad_dispatch WHERE id = $1", [dispatchId]);
      }
      if (agentId) {
        await pool.query("DELETE FROM control_audit.claim_rejection WHERE agency_id = $1", [agentId]);
        await pool.query("DELETE FROM roadmap_workforce.provider_registry WHERE agency_id = $1", [agentId]);
        await pool.query("DELETE FROM roadmap_workforce.agent_registry WHERE id = $1", [agentId]);
      }
    }
  });
});

// ─── AC-6: 3 retries → same row; 4th → failed + reissue_required notify ──────

describe("AC-6: 3 retryable failures on same row; 4th triggers failed + pg_notify", () => {
  skip(
    "attempt_count increments 1→2→3 (retry_wait each time) then 4th sets failed + reissue_required",
    async () => {
      // max_attempts=3: attempts 1,2,3 ≤ 3 → retry_wait; attempt 4 > 3 → failed
      const fixture = await setupScratch("ac6", 3, '["TIMEOUT"]');

      // Dedicated listener on a separate client so pg_notify from pool.query() reaches it.
      const listenerClient = await pool.connect();
      const receivedPayloads: string[] = [];
      listenerClient.on("notification", msg => {
        if (msg.channel === "reissue_required") receivedPayloads.push(msg.payload ?? "");
      });
      await listenerClient.query("LISTEN reissue_required");

      try {
        // Drive dispatch back to 'running' before each call (simulating re-claim + re-start).
        // The function only requires a non-terminal status, not necessarily 'running'.
        const resetStatus = async () =>
          pool.query(
            "UPDATE roadmap_workforce.squad_dispatch SET dispatch_status='running', offer_status='active' WHERE id = $1",
            [fixture.dispatchId]
          );

        for (let attempt = 1; attempt <= 3; attempt++) {
          const { rows } = await pool.query<{
            out_dispatch_status: string;
            out_attempt_count: number;
          }>(`
            SELECT * FROM roadmap_workforce.fn_record_dispatch_failure($1, 'TIMEOUT', 'retry test')
          `, [fixture.dispatchId]);

          assert.equal(rows[0].out_dispatch_status, "retry_wait",
            `Attempt ${attempt}: expected retry_wait`);
          assert.equal(rows[0].out_attempt_count, attempt,
            `Attempt ${attempt}: expected attempt_count=${attempt}`);

          // Verify same row (no replacement rows created)
          const { rows: [row] } = await pool.query<{ id: number; attempt_count: number }>(`
            SELECT id, attempt_count FROM roadmap_workforce.squad_dispatch
            WHERE id = $1
          `, [fixture.dispatchId]);

          assert.equal(row.id, fixture.dispatchId, "Dispatch ID must not change between retries");
          assert.equal(row.attempt_count, attempt, `Row attempt_count mismatch on attempt ${attempt}`);

          // Reset status so we can record the next failure
          if (attempt < 3) await resetStatus();
        }

        // Reset for the 4th (terminal) failure
        await resetStatus();

        // 4th failure: attempt_count → 4 > max_attempts(3) → failed + pg_notify
        const { rows: [terminal] } = await pool.query<{
          out_dispatch_status: string;
          out_attempt_count: number;
          out_next_retry_at: string | null;
        }>(`
          SELECT * FROM roadmap_workforce.fn_record_dispatch_failure($1, 'TIMEOUT', 'terminal')
        `, [fixture.dispatchId]);

        assert.equal(terminal.out_dispatch_status, "failed",
          "4th failure must set dispatch_status=failed");
        assert.equal(terminal.out_attempt_count, 4,
          "attempt_count should be 4 after 4th failure");
        assert.equal(terminal.out_next_retry_at, null,
          "next_retry_at must be null for terminal failed row");

        // Verify DB row is terminal
        const { rows: [finalRow] } = await pool.query<{
          dispatch_status: string;
          offer_status: string;
          attempt_count: number;
        }>(`
          SELECT dispatch_status, offer_status, attempt_count
          FROM roadmap_workforce.squad_dispatch WHERE id = $1
        `, [fixture.dispatchId]);

        assert.equal(finalRow.dispatch_status, "failed");
        assert.equal(finalRow.offer_status, "failed");
        assert.equal(finalRow.attempt_count, 4);

        // Wait up to 1 second for the pg_notify to arrive on the listener client.
        await new Promise<void>((resolve, reject) => {
          if (receivedPayloads.length > 0) { resolve(); return; }
          const deadline = setTimeout(
            () => reject(new Error("Timed out waiting for reissue_required pg_notify")),
            1000
          );
          const poll = setInterval(() => {
            if (receivedPayloads.length > 0) {
              clearInterval(poll);
              clearTimeout(deadline);
              resolve();
            }
          }, 50);
        });

        assert.ok(receivedPayloads.length >= 1, "Expected at least one reissue_required notification");

        // Verify payload shape
        const payload = JSON.parse(receivedPayloads[0]!);
        assert.equal(payload.dispatch_id, fixture.dispatchId);
        assert.equal(payload.attempt_count, 4);
        assert.ok(
          payload.reason === "max_attempts_exceeded",
          `Expected reason=max_attempts_exceeded, got ${payload.reason}`
        );
      } finally {
        await listenerClient.query("UNLISTEN reissue_required");
        listenerClient.release();
        await teardownScratch(fixture);
      }
    }
  );

  skip("non-retryable error on first attempt also emits reissue_required", async () => {
    const fixture = await setupScratch("ac6-nonretry", 5, '["TIMEOUT"]');
    const listenerClient = await pool.connect();
    const receivedPayloads: string[] = [];
    listenerClient.on("notification", msg => {
      if (msg.channel === "reissue_required") receivedPayloads.push(msg.payload ?? "");
    });
    await listenerClient.query("LISTEN reissue_required");

    try {
      await pool.query(`
        SELECT * FROM roadmap_workforce.fn_record_dispatch_failure($1, 'FATAL_ERROR', 'no retry')
      `, [fixture.dispatchId]);

      await new Promise<void>((resolve, reject) => {
        if (receivedPayloads.length > 0) { resolve(); return; }
        const deadline = setTimeout(
          () => reject(new Error("Timed out waiting for reissue_required pg_notify")),
          1000
        );
        const poll = setInterval(() => {
          if (receivedPayloads.length > 0) {
            clearInterval(poll);
            clearTimeout(deadline);
            resolve();
          }
        }, 50);
      });

      const payload = JSON.parse(receivedPayloads[0]!);
      assert.equal(payload.reason, "non_retryable_error");
    } finally {
      await listenerClient.query("UNLISTEN reissue_required");
      listenerClient.release();
      await teardownScratch(fixture);
    }
  });
});

// ─── Requeue function ─────────────────────────────────────────────────────────

describe("fn_requeue_ready_dispatches: promotes retry_wait rows past their cooldown", () => {
  skip("promotes retry_wait row with past next_retry_at back to posted/open", async () => {
    const fixture = await setupScratch("requeue", 5, '["TIMEOUT"]');
    try {
      // Manually place dispatch in retry_wait with a past next_retry_at
      await pool.query(`
        UPDATE roadmap_workforce.squad_dispatch
        SET dispatch_status = 'retry_wait',
            offer_status    = 'expired',
            next_retry_at   = now() - interval '1 minute'
        WHERE id = $1
      `, [fixture.dispatchId]);

      // Run requeue
      const { rows } = await pool.query<{ out_dispatch_id: number }>(`
        SELECT * FROM roadmap_workforce.fn_requeue_ready_dispatches()
      `);

      const requeued = rows.find(r => r.out_dispatch_id === fixture.dispatchId);
      assert.ok(requeued, "Expected fixture dispatch to be requeued");

      // Verify state
      const { rows: [row] } = await pool.query<{
        dispatch_status: string;
        offer_status: string;
        next_retry_at: string | null;
      }>(`
        SELECT dispatch_status, offer_status, next_retry_at
        FROM roadmap_workforce.squad_dispatch WHERE id = $1
      `, [fixture.dispatchId]);

      assert.equal(row.dispatch_status, "posted");
      assert.equal(row.offer_status, "open");
      assert.equal(row.next_retry_at, null, "next_retry_at should be cleared after requeue");
    } finally {
      await teardownScratch(fixture);
    }
  });

  skip("does not promote retry_wait row whose cooldown has not expired", async () => {
    const fixture = await setupScratch("requeue-future", 5, '["TIMEOUT"]');
    try {
      // next_retry_at in the future
      await pool.query(`
        UPDATE roadmap_workforce.squad_dispatch
        SET dispatch_status = 'retry_wait',
            offer_status    = 'expired',
            next_retry_at   = now() + interval '1 hour'
        WHERE id = $1
      `, [fixture.dispatchId]);

      await pool.query("SELECT * FROM roadmap_workforce.fn_requeue_ready_dispatches()");

      const { rows: [row] } = await pool.query<{ dispatch_status: string }>(`
        SELECT dispatch_status FROM roadmap_workforce.squad_dispatch WHERE id = $1
      `, [fixture.dispatchId]);

      assert.equal(row.dispatch_status, "retry_wait",
        "Row still in cooldown should remain retry_wait after requeue run");
    } finally {
      await teardownScratch(fixture);
    }
  });
});
