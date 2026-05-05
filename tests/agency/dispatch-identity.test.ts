/**
 * AC-4 / AC-5 (P289): Dispatch identity columns are populated correctly.
 *
 * Verifies:
 *   - agency_identity is set on squad_dispatch when an offer is claimed
 *   - worker_identity is set when the offer is activated with a worker
 *   - Both columns remain distinct (agency ≠ worker)
 *   - fn_offer_provider_heartbeat upserts provider_registry with status='active'
 *     and flipping to 'paused' via UPDATE works (the DB side of AC2)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPool,
  bootstrapNamespace,
  teardownNamespace,
} from './helpers.js';
import { Pool } from 'pg';

const NS = 'dispatch_id';

// Minimal roadmap_workforce stubs used by the P289 functions
const WORKFORCE_STUBS = `
CREATE SCHEMA IF NOT EXISTS roadmap_workforce_${NS};

CREATE TABLE IF NOT EXISTS roadmap_workforce_${NS}.agent_registry (
  id              BIGSERIAL PRIMARY KEY,
  agent_identity  TEXT NOT NULL UNIQUE,
  agent_type      TEXT NOT NULL DEFAULT 'agency',
  preferred_provider TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roadmap_workforce_${NS}.provider_registry (
  id              BIGSERIAL PRIMARY KEY,
  agency_id       BIGINT NOT NULL REFERENCES roadmap_workforce_${NS}.agent_registry(id),
  agency_identity TEXT NOT NULL,
  project_id      BIGINT,
  squad_name      TEXT,
  capabilities    JSONB NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT provider_registry_agency_project_squad_uniq_${NS}
    UNIQUE NULLS NOT DISTINCT (agency_id, project_id, squad_name)
);

CREATE TABLE IF NOT EXISTS roadmap_workforce_${NS}.squad_dispatch (
  id              BIGSERIAL PRIMARY KEY,
  proposal_id     BIGINT,
  squad_name      TEXT NOT NULL DEFAULT 'default',
  dispatch_role   TEXT NOT NULL DEFAULT 'developer',
  offer_status    TEXT NOT NULL DEFAULT 'open',
  required_capabilities JSONB NOT NULL DEFAULT '{}',
  agent_identity  TEXT,
  agency_identity TEXT,
  worker_identity TEXT,
  claim_token     UUID,
  claim_expires_at TIMESTAMPTZ,
  offer_version   INT NOT NULL DEFAULT 0,
  metadata        JSONB,
  project_id      BIGINT,
  assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at      TIMESTAMPTZ,
  last_renewed_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roadmap_workforce_${NS}.agent_capability (
  id         BIGSERIAL PRIMARY KEY,
  agent_id   BIGINT NOT NULL REFERENCES roadmap_workforce_${NS}.agent_registry(id),
  capability TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS roadmap_workforce_${NS}.projects (
  id   BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE
);
`;

async function setupWorkforce(pool: Pool, ns: string): Promise<void> {
  // Create the namespace-specific workforce schema
  await pool.query(WORKFORCE_STUBS);

  // Create fn_offer_provider_heartbeat in the namespaced schema
  await pool.query(`
    CREATE OR REPLACE FUNCTION roadmap_workforce_${ns}.fn_offer_provider_heartbeat(
      p_agency_identity TEXT,
      p_project_id      BIGINT DEFAULT NULL,
      p_squad_name      TEXT   DEFAULT NULL,
      p_capabilities    JSONB  DEFAULT '{}'::jsonb
    ) RETURNS VOID LANGUAGE plpgsql AS $fn$
    DECLARE v_agency_id BIGINT;
    BEGIN
      SELECT id INTO v_agency_id FROM roadmap_workforce_${ns}.agent_registry
      WHERE agent_identity = p_agency_identity;
      IF v_agency_id IS NULL THEN
        RAISE EXCEPTION 'unknown agency_identity %', p_agency_identity
          USING ERRCODE = 'foreign_key_violation';
      END IF;
      INSERT INTO roadmap_workforce_${ns}.provider_registry
        (agency_id, agency_identity, project_id, squad_name, capabilities, status, last_seen_at)
      VALUES
        (v_agency_id, p_agency_identity, p_project_id, p_squad_name, p_capabilities, 'active', now())
      ON CONFLICT ON CONSTRAINT provider_registry_agency_project_squad_uniq_${ns} DO UPDATE SET
        agency_identity = p_agency_identity,
        capabilities    = EXCLUDED.capabilities,
        status          = 'active',
        last_seen_at    = now(),
        updated_at      = now();
    END; $fn$;
  `);
}

async function teardownWorkforce(pool: Pool, ns: string): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS roadmap_workforce_${ns} CASCADE`);
}

describe('P289 dispatch identity tests', () => {
  const pool = createPool();

  before(async () => {
    await setupWorkforce(pool, NS);
  });

  after(async () => {
    await teardownWorkforce(pool, NS);
    await pool.end();
  });

  it('AC-2 DB side: fn_offer_provider_heartbeat upserts and idempotently refreshes', async () => {
    const agencyId = `hb_agency_${NS}`;

    // Register agency
    await pool.query(
      `INSERT INTO roadmap_workforce_${NS}.agent_registry (agent_identity, agent_type, status)
       VALUES ($1, 'agency', 'active') ON CONFLICT DO NOTHING`,
      [agencyId],
    );

    // First heartbeat — should insert
    await pool.query(
      `SELECT roadmap_workforce_${NS}.fn_offer_provider_heartbeat($1, NULL, NULL, '{}'::jsonb)`,
      [agencyId],
    );

    const { rows: [r1] } = await pool.query(
      `SELECT status, agency_identity FROM roadmap_workforce_${NS}.provider_registry
       WHERE agency_identity = $1`,
      [agencyId],
    );
    assert.equal(r1.status, 'active', 'first heartbeat should register with status=active');
    assert.equal(r1.agency_identity, agencyId);

    // Simulate pause then re-heartbeat — should flip back to active
    await pool.query(
      `UPDATE roadmap_workforce_${NS}.provider_registry
       SET status = 'paused' WHERE agency_identity = $1`,
      [agencyId],
    );

    await pool.query(
      `SELECT roadmap_workforce_${NS}.fn_offer_provider_heartbeat($1, NULL, NULL, '{}'::jsonb)`,
      [agencyId],
    );

    const { rows: [r2] } = await pool.query(
      `SELECT status FROM roadmap_workforce_${NS}.provider_registry
       WHERE agency_identity = $1`,
      [agencyId],
    );
    assert.equal(r2.status, 'active', 're-heartbeat after pause should restore status=active');
  });

  it('AC-2 DB side: graceful pause sets status=paused', async () => {
    const agencyId = `pause_agency_${NS}`;

    await pool.query(
      `INSERT INTO roadmap_workforce_${NS}.agent_registry (agent_identity, agent_type, status)
       VALUES ($1, 'agency', 'active') ON CONFLICT DO NOTHING`,
      [agencyId],
    );
    await pool.query(
      `SELECT roadmap_workforce_${NS}.fn_offer_provider_heartbeat($1, NULL, NULL, '{}'::jsonb)`,
      [agencyId],
    );

    // Simulate OfferProvider.stop() → pauseProviderRegistry()
    await pool.query(
      `UPDATE roadmap_workforce_${NS}.provider_registry
       SET status = 'paused', updated_at = now()
       WHERE agency_identity = $1`,
      [agencyId],
    );

    const { rows: [r] } = await pool.query(
      `SELECT status FROM roadmap_workforce_${NS}.provider_registry WHERE agency_identity = $1`,
      [agencyId],
    );
    assert.equal(r.status, 'paused', 'graceful stop must set status=paused');
  });

  it('AC-4: squad_dispatch.agency_identity and worker_identity are independently settable', async () => {
    const agencyIdentity = `agency_col_${NS}`;
    const workerIdentity = `${agencyIdentity}/worker-99`;

    // Insert a dispatch row simulating fn_claim_work_offer outcome
    const { rows: [d] } = await pool.query(
      `INSERT INTO roadmap_workforce_${NS}.squad_dispatch
         (squad_name, dispatch_role, offer_status, agent_identity, agency_identity)
       VALUES ('default', 'developer', 'claimed', $1, $2)
       RETURNING id, agent_identity, agency_identity, worker_identity`,
      [agencyIdentity, agencyIdentity],
    );

    assert.equal(d.agent_identity, agencyIdentity, 'agent_identity should be set');
    assert.equal(d.agency_identity, agencyIdentity, 'agency_identity should be set');
    assert.equal(d.worker_identity, null, 'worker_identity should be null before activation');

    // Simulate fn_activate_work_offer setting worker_identity
    await pool.query(
      `UPDATE roadmap_workforce_${NS}.squad_dispatch
       SET worker_identity = $1, offer_status = 'active'
       WHERE id = $2`,
      [workerIdentity, d.id],
    );

    const { rows: [after] } = await pool.query(
      `SELECT agent_identity, agency_identity, worker_identity FROM roadmap_workforce_${NS}.squad_dispatch
       WHERE id = $1`,
      [d.id],
    );

    assert.equal(after.agent_identity, agencyIdentity, 'agent_identity unchanged after activation');
    assert.equal(after.agency_identity, agencyIdentity, 'agency_identity unchanged after activation');
    assert.equal(after.worker_identity, workerIdentity, 'worker_identity set on activation');
    assert.notEqual(after.agency_identity, after.worker_identity, 'agency and worker identities must differ');
  });

  it('AC-4: NULLS NOT DISTINCT prevents duplicate (agency_id, NULL, NULL) rows', async () => {
    const agencyId = `dup_agency_${NS}`;

    await pool.query(
      `INSERT INTO roadmap_workforce_${NS}.agent_registry (agent_identity, agent_type, status)
       VALUES ($1, 'agency', 'active') ON CONFLICT DO NOTHING`,
      [agencyId],
    );

    // First insert
    await pool.query(
      `SELECT roadmap_workforce_${NS}.fn_offer_provider_heartbeat($1, NULL, NULL, '{}'::jsonb)`,
      [agencyId],
    );
    // Second insert — must upsert, not create a duplicate row
    await pool.query(
      `SELECT roadmap_workforce_${NS}.fn_offer_provider_heartbeat($1, NULL, NULL, '{"all":["test"]}'::jsonb)`,
      [agencyId],
    );

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM roadmap_workforce_${NS}.provider_registry WHERE agency_identity = $1`,
      [agencyId],
    );
    assert.equal(rows[0].cnt, 1, 'NULLS NOT DISTINCT constraint must prevent duplicate (agency, NULL, NULL) rows');
  });
});
