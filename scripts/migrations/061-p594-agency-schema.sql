-- ============================================================
-- Migration 061 — P594: agency schema data migration
-- Migrates roadmap.agency + roadmap.agency_liaison_session
-- into hiveCentral.agency.* tables.
-- Seeds liaison_message_kind_catalog with all 21 kinds.
-- ============================================================
-- Idempotent: all INSERTs use ON CONFLICT DO NOTHING.
-- Run AFTER applying 003-agency.sql (hiveCentral DDL).
-- Run AFTER applying P593 (002-identity.sql).
-- ============================================================

-- ── Step 0: Pre-seed core.host ────────────────────────────────
-- core.host.role and owner_did are NOT NULL with no DEFAULT (verified:
-- 001-core.sql lines 54–61). The plain INSERT INTO core.host (host_name)
-- form fails at runtime. Both required fields must be supplied.
INSERT INTO core.host (host_name, role, owner_did)
  SELECT DISTINCT
    a.host_id,
    'agency',
    'system:migration'
  FROM roadmap.agency a
  WHERE a.host_id IS NOT NULL
    AND a.host_id NOT IN (SELECT host_name FROM core.host)
ON CONFLICT (host_name) DO NOTHING;

-- ── Step 1: Bootstrap providers ──────────────────────────────
INSERT INTO agency.agency_provider (provider_id, display_name, owner_did)
  SELECT DISTINCT
    a.provider,
    a.provider,
    'system:migration'
  FROM roadmap.agency a
  WHERE a.provider IS NOT NULL
ON CONFLICT (provider_id) DO NOTHING;

-- ── Step 1.5: Seed placeholder identity.principal rows ───────
-- Legacy agencies have no identity.principal rows. Each agency gets a
-- placeholder DID so Step 2's INNER JOIN resolves without orphans.
-- public_key BYTEA NOT NULL requires a placeholder value.
-- Operators must rebind principal_did to real identity-issued DIDs
-- post-migration and add a signing_key_id when available.
INSERT INTO identity.principal (did, public_key, lifecycle_status, owner_did)
  SELECT
    'did:agenthive:spawn:' || a.agency_id,
    '\x'::bytea,
    'active',
    'system:migration'
  FROM roadmap.agency a
  WHERE NOT EXISTS (
    SELECT 1 FROM identity.principal p
    WHERE p.did = 'did:agenthive:spawn:' || a.agency_id
  )
ON CONFLICT (did) DO NOTHING;

-- ── Step 2: Migrate agency rows ───────────────────────────────
-- F1 final (gate-hold 276): identity.principal PK is did TEXT PRIMARY KEY.
-- INNER JOIN on p.did (seeded in Step 1.5); selects p.did (TEXT).
-- All agencies resolve because Step 1.5 seeded every missing DID.
INSERT INTO agency.agency
  (agency_id, display_name, provider_id, principal_did, host_id,
   capabilities, status_reason, last_heartbeat_at, registered_at, metadata, owner_did)
  SELECT
    a.agency_id,
    a.display_name,
    a.provider,
    p.did,
    h.host_id,
    COALESCE(a.capability_tags, '{}'),
    a.status_reason,
    a.last_heartbeat_at,
    a.registered_at,
    COALESCE(a.metadata, '{}'),
    'system:migration'
  FROM roadmap.agency a
  INNER JOIN identity.principal p
    ON p.did = 'did:agenthive:spawn:' || a.agency_id
  JOIN core.host h ON h.host_name = a.host_id
ON CONFLICT (agency_id) DO NOTHING;

-- ── Step 2b: Seed default agency_capacity ────────────────────
-- All migrated agencies get max_concurrent=1 so is_dispatchable()
-- returns TRUE immediately post-migration. Operators adjust max_concurrent
-- for high-throughput agencies after migration.
INSERT INTO agency.agency_capacity
  (agency_id, max_concurrent, current_load, accepted_tags, rejected_tags, owner_did)
  SELECT
    a.agency_id,
    1,
    0,
    '{}',
    '{}',
    'system:migration'
  FROM agency.agency a
  WHERE NOT EXISTS (
    SELECT 1 FROM agency.agency_capacity c
    WHERE c.agency_id = a.agency_id AND c.lifecycle_status = 'active'
  )
ON CONFLICT DO NOTHING;

-- ── Step 3: Migrate sessions ──────────────────────────────────
-- liaison_host TEXT → INET cast; liaison_pid dropped (ephemeral).
INSERT INTO agency.agency_session
  (session_id, agency_id, liaison_host, started_at, ended_at, end_reason,
   last_heartbeat_at, dormancy_state, owner_did)
  SELECT
    s.session_id,
    s.agency_id,
    NULLIF(s.liaison_host, '')::INET,
    s.started_at,
    s.ended_at,
    s.end_reason,
    COALESCE(s.ended_at, s.started_at),
    CASE WHEN s.ended_at IS NOT NULL THEN 'dormant' ELSE 'active' END,
    'system:migration'
  FROM roadmap.agency_liaison_session s
  WHERE s.agency_id IN (SELECT agency_id FROM agency.agency)
ON CONFLICT (session_id) DO NOTHING;

-- ── Step 4: Seed open session from agency.status ─────────────
-- Any agency without an open session gets one with dormancy_state
-- derived from roadmap.agency.status.
-- 'throttled' and 'retired' both → 'dormant' via ELSE.
INSERT INTO agency.agency_session
  (agency_id, dormancy_state, started_at, last_heartbeat_at, owner_did)
  SELECT
    a.agency_id,
    CASE a_src.status
      WHEN 'active' THEN 'active'
      WHEN 'paused' THEN 'paused'
      ELSE 'dormant'
    END,
    COALESCE(a.registered_at, now()),
    COALESCE(a.last_heartbeat_at, now()),
    'system:migration'
  FROM agency.agency a
  JOIN roadmap.agency a_src ON a_src.agency_id = a.agency_id
  WHERE NOT EXISTS (
    SELECT 1 FROM agency.agency_session s
    WHERE s.agency_id = a.agency_id AND s.ended_at IS NULL
  );

-- ── Step 5: Orphan + capacity validation ─────────────────────
DO $$
DECLARE
  v_orphans INT;
BEGIN
  SELECT COUNT(*) INTO v_orphans
  FROM roadmap.agency
  WHERE agency_id NOT IN (SELECT agency_id FROM agency.agency);
  IF v_orphans > 0 THEN
    RAISE EXCEPTION 'P594 migration: % agency row(s) not migrated', v_orphans;
  END IF;

  SELECT COUNT(*) INTO v_orphans
  FROM agency.agency
  WHERE agency_id NOT IN (
    SELECT agency_id FROM agency.agency_capacity WHERE lifecycle_status = 'active'
  );
  IF v_orphans > 0 THEN
    RAISE EXCEPTION 'P594 migration: % agency row(s) have no active capacity row', v_orphans;
  END IF;

  SELECT COUNT(*) INTO v_orphans
  FROM agency.agency
  WHERE agency_id NOT IN (
    SELECT agency_id FROM agency.agency_session WHERE ended_at IS NULL
  );
  IF v_orphans > 0 THEN
    RAISE EXCEPTION 'P594 migration: % agency row(s) have no open session', v_orphans;
  END IF;
END $$;

-- ── Step 6: Seed liaison_message_kind_catalog (21 kinds) ─────
-- Derived from src/infra/agency/liaison-message-types.ts Zod schemas.
-- ON CONFLICT updates payload_schema so re-running refreshes if Zod changes.
-- protocol_resync is the 21st kind (AC-19): Zod ProtocolResyncPayloadSchema
-- at src/infra/agency/liaison-message-types.ts lines 168-173.
INSERT INTO agency.liaison_message_kind_catalog
  (kind_id, category, direction, payload_schema, owner_did)
VALUES

-- Orchestrator → Liaison: lifecycle control
('liaison_pause', 'lifecycle', 'orchestrator->liaison',
 '{"type":"object","properties":{"until_iso":{"type":"string","format":"date-time","nullable":true}},"required":[]}',
 'system:migration'),

('liaison_resume', 'lifecycle', 'orchestrator->liaison',
 '{"type":"object","properties":{}}',
 'system:migration'),

('liaison_drain', 'lifecycle', 'orchestrator->liaison',
 '{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]}',
 'system:migration'),

('agency_retire', 'lifecycle', 'orchestrator->liaison',
 '{"type":"object","properties":{"reason":{"type":"string"}},"required":["reason"]}',
 'system:migration'),

('protocol_ping', 'lifecycle', 'orchestrator->liaison',
 '{"type":"object","properties":{"nonce":{"type":"string"}},"required":["nonce"]}',
 'system:migration'),

-- Orchestrator → Liaison: workflow control
('offer_dispatch', 'workflow', 'orchestrator->liaison',
 '{"type":"object","properties":{"offer_id":{"type":"string","format":"uuid"},"role":{"type":"string"},"required_capabilities":{"type":"array","items":{"type":"string"}},"route_hint":{"type":"string"}},"required":["offer_id","role","required_capabilities","route_hint"]}',
 'system:migration'),

('claim_revoke', 'workflow', 'orchestrator->liaison',
 '{"type":"object","properties":{"claim_id":{"type":"string","format":"uuid"},"reason":{"type":"string"}},"required":["claim_id","reason"]}',
 'system:migration'),

('query_capacity', 'workflow', 'orchestrator->liaison',
 '{"type":"object","properties":{}}',
 'system:migration'),

-- Liaison → Orchestrator: lifecycle
('liaison_register', 'lifecycle', 'liaison->orchestrator',
 '{"type":"object","properties":{"agency_id":{"type":"string"},"provider":{"type":"string"},"host_id":{"type":"string"},"capabilities":{"type":"array","items":{"type":"string"}},"public_key":{"type":"string"}},"required":["agency_id","provider","host_id","capabilities","public_key"]}',
 'system:migration'),

('agency_active', 'lifecycle', 'liaison->orchestrator',
 '{"type":"object","properties":{}}',
 'system:migration'),

('agency_throttle', 'lifecycle', 'liaison->orchestrator',
 '{"type":"object","properties":{"until_iso":{"type":"string","format":"date-time"},"reason":{"type":"string"}},"required":["until_iso","reason"]}',
 'system:migration'),

('protocol_pong', 'lifecycle', 'liaison->orchestrator',
 '{"type":"object","properties":{"nonce":{"type":"string"}},"required":["nonce"]}',
 'system:migration'),

-- Liaison → Orchestrator: workflow
('claim_offer', 'workflow', 'liaison->orchestrator',
 '{"type":"object","properties":{"offer_id":{"type":"string","format":"uuid"},"agent_identity":{"type":"string"},"briefing_id":{"type":"string","format":"uuid"}},"required":["offer_id","agent_identity","briefing_id"]}',
 'system:migration'),

('claim_release', 'workflow', 'liaison->orchestrator',
 '{"type":"object","properties":{"claim_id":{"type":"string","format":"uuid"},"reason":{"type":"string"}},"required":["claim_id","reason"]}',
 'system:migration'),

('claim_paused', 'workflow', 'liaison->orchestrator',
 '{"type":"object","properties":{"claim_id":{"type":"string","format":"uuid"},"reason":{"type":"string"},"resume_eligible_at":{"type":"string","format":"date-time"}},"required":["claim_id","reason","resume_eligible_at"]}',
 'system:migration'),

-- Liaison → Orchestrator: telemetry
('heartbeat', 'telemetry', 'liaison->orchestrator',
 '{"type":"object","properties":{"capacity_envelope":{"type":"object"},"in_flight_count":{"type":"integer","minimum":0},"last_error":{"type":"string","nullable":true}},"required":["capacity_envelope","in_flight_count"]}',
 'system:migration'),

('progress_note', 'telemetry', 'liaison->orchestrator',
 '{"type":"object","properties":{"briefing_id":{"type":"string","format":"uuid"},"summary":{"type":"string"},"confidence":{"type":"number","minimum":0,"maximum":1}},"required":["briefing_id","summary","confidence"]}',
 'system:migration'),

('claim_status', 'telemetry', 'liaison->orchestrator',
 '{"type":"object","properties":{"claim_id":{"type":"string","format":"uuid"},"ac_progress":{"type":"object"},"eta_minutes":{"type":"integer","minimum":0,"nullable":true}},"required":["claim_id","ac_progress"]}',
 'system:migration'),

-- Liaison → Orchestrator: error
('assistance_request', 'error', 'liaison->orchestrator',
 '{"type":"object","properties":{"briefing_id":{"type":"string","format":"uuid"},"task_id":{"type":"string","format":"uuid"},"error_signature":{"type":"string"},"payload":{"type":"object"}},"required":["briefing_id","task_id","error_signature","payload"]}',
 'system:migration'),

('escalate', 'error', 'liaison->orchestrator',
 '{"type":"object","properties":{"kind":{"type":"string"},"severity":{"type":"string"},"payload":{"type":"object"}},"required":["kind","severity","payload"]}',
 'system:migration'),

-- Any direction: protocol error (21st kind — AC-19)
-- Derived from ProtocolResyncPayloadSchema (liaison-message-types.ts lines 168-173).
('protocol_resync', 'error', 'any',
 '{"type":"object","properties":{"max_buffered_sequence":{"type":"integer"},"dropped_count":{"type":"integer","minimum":0}},"required":["max_buffered_sequence","dropped_count"]}',
 'system:migration')

ON CONFLICT (kind_id) DO UPDATE
  SET payload_schema = EXCLUDED.payload_schema,
      category       = EXCLUDED.category,
      direction      = EXCLUDED.direction;
