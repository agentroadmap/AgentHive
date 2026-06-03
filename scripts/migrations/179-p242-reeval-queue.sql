-- P242: Complete Mature Re-Evaluation Loop
-- Implements proposal_reeval_queue, proposal_reeval_lease, proposal column
-- extensions, updated dependency_type CHECK, config seeds, SQL detection
-- functions, and system:reeval agent registration.

-- ────────────────────────────────────────────────────────────────
-- 0. Register system:reeval agent (needed for proposal_discussions FK)
-- ────────────────────────────────────────────────────────────────
INSERT INTO roadmap_workforce.agent_registry
       (agent_identity, agent_type, role, status, trust_tier)
VALUES ('system:reeval', 'coordinator', 'reeval-loop', 'active', 'trusted')
ON CONFLICT (agent_identity) DO NOTHING;

-- ────────────────────────────────────────────────────────────────
-- 1. Proposal table extensions
-- ────────────────────────────────────────────────────────────────
ALTER TABLE roadmap_proposal.proposal
  ADD COLUMN IF NOT EXISTS reeval_exempt_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reeval_count         INT NOT NULL DEFAULT 0;

-- ────────────────────────────────────────────────────────────────
-- 2. Extend proposal_dependencies dependency_type CHECK ('derived_from')
-- ────────────────────────────────────────────────────────────────
ALTER TABLE roadmap_proposal.proposal_dependencies
  DROP CONSTRAINT IF EXISTS proposal_deps_type_check,
  ADD  CONSTRAINT proposal_deps_type_check
    CHECK (dependency_type = ANY (ARRAY[
      'blocks'::text, 'depended_by'::text,
      'supersedes'::text, 'relates'::text, 'derived_from'::text
    ]));

-- ────────────────────────────────────────────────────────────────
-- 3. proposal_reeval_queue
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roadmap_proposal.proposal_reeval_queue (
  id                  BIGSERIAL PRIMARY KEY,
  proposal_id         BIGINT      NOT NULL REFERENCES roadmap_proposal.proposal(id) ON DELETE CASCADE,
  reeval_type         TEXT        NOT NULL DEFAULT 'staleness'
    CHECK (reeval_type IN ('staleness', 'optimization')),
  flagged_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  staleness_reason    TEXT        NOT NULL
    CHECK (staleness_reason IN ('time_based', 'unblocked_unpicked', 'superseded')),
  outcome             TEXT
    CHECK (outcome IS NULL OR outcome IN (
      'keep', 'revise', 'obsolete',
      'spawn_optimization', 'spawn_transformation'
    )),
  decided_by          TEXT,
  decision_notes      TEXT,
  spawned_proposal_id BIGINT REFERENCES roadmap_proposal.proposal(id) ON DELETE SET NULL,
  resolved_at         TIMESTAMPTZ
);

-- One open reeval per proposal at a time; allows re-flagging after resolution.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reeval_queue_one_open
  ON roadmap_proposal.proposal_reeval_queue(proposal_id)
  WHERE outcome IS NULL;

CREATE INDEX IF NOT EXISTS idx_reeval_queue_proposal_id
  ON roadmap_proposal.proposal_reeval_queue(proposal_id);

CREATE INDEX IF NOT EXISTS idx_reeval_queue_open_flagged
  ON roadmap_proposal.proposal_reeval_queue(flagged_at)
  WHERE outcome IS NULL;

-- ────────────────────────────────────────────────────────────────
-- 4. proposal_reeval_lease
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roadmap_proposal.proposal_reeval_lease (
  id              BIGSERIAL PRIMARY KEY,
  reeval_queue_id BIGINT      NOT NULL
    REFERENCES roadmap_proposal.proposal_reeval_queue(id) ON DELETE CASCADE,
  agent_identity  TEXT        NOT NULL,
  claimed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 minutes',
  released_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reeval_lease_one_active
  ON roadmap_proposal.proposal_reeval_lease(reeval_queue_id)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_reeval_lease_queue_id
  ON roadmap_proposal.proposal_reeval_lease(reeval_queue_id);

-- ────────────────────────────────────────────────────────────────
-- 5. Performance indexes on proposal
-- ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_proposal_reeval_exempt
  ON roadmap_proposal.proposal(reeval_exempt_until)
  WHERE reeval_exempt_until IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_proposal_status_modified
  ON roadmap_proposal.proposal(status, modified_at);

-- ────────────────────────────────────────────────────────────────
-- 6. Config seeds
-- ────────────────────────────────────────────────────────────────
INSERT INTO roadmap.config (key, value, description) VALUES
  ('reeval_stale_days',              '21',   'Loop A: days since modified_at before time-based flag triggers'),
  ('reeval_unblocked_pickup_days',   '7',    'Loop A: days after dep resolution before unblocked-unpicked flag'),
  ('reeval_superseded_auto_obsolete','false','Loop A: auto-obsolete superseded proposals without reeval agent'),
  ('reeval_complete_cadence_days',   '90',   'Loop B: days since modified_at before COMPLETE+mature is flagged'),
  ('reeval_daily_budget_usd',        '1.00', 'A+B: daily USD cap for all spawned reeval agents'),
  ('reeval_max_count',               '3',    'A+B: max reevals per proposal before mandatory human escalation')
ON CONFLICT (key) DO NOTHING;

-- ────────────────────────────────────────────────────────────────
-- 7. Loop A: fn_flag_stale_proposals()
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION roadmap.fn_flag_stale_proposals()
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
  v_stale_days    INT  := COALESCE((SELECT value::int  FROM roadmap.config WHERE key = 'reeval_stale_days'), 21);
  v_pickup_days   INT  := COALESCE((SELECT value::int  FROM roadmap.config WHERE key = 'reeval_unblocked_pickup_days'), 7);
  v_auto_obsolete BOOL := COALESCE((SELECT value::bool FROM roadmap.config WHERE key = 'reeval_superseded_auto_obsolete'), false);
  v_max_count     INT  := COALESCE((SELECT value::int  FROM roadmap.config WHERE key = 'reeval_max_count'), 3);
  v_flagged       INT  := 0;
  v_delta         INT  := 0;
BEGIN
  -- Time-based: DEVELOP, no active lease, not exempt, not paused
  INSERT INTO roadmap_proposal.proposal_reeval_queue (proposal_id, reeval_type, staleness_reason)
  SELECT p.id, 'staleness', 'time_based'
  FROM   roadmap_proposal.proposal p
  WHERE  p.status = 'DEVELOP'
    AND  p.gate_scanner_paused = false
    AND  p.modified_at < now() - (v_stale_days || ' days')::interval
    AND  (p.reeval_exempt_until IS NULL OR p.reeval_exempt_until < now())
    AND  p.reeval_count < v_max_count
    AND  NOT EXISTS (SELECT 1 FROM roadmap_proposal.proposal_lease pl
                     WHERE pl.proposal_id = p.id AND pl.released_at IS NULL)
    AND  NOT EXISTS (SELECT 1 FROM roadmap_proposal.proposal_reeval_queue q
                     WHERE q.proposal_id = p.id AND q.outcome IS NULL)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_delta = ROW_COUNT;
  v_flagged := v_flagged + v_delta;

  -- Unblocked-but-unpicked
  INSERT INTO roadmap_proposal.proposal_reeval_queue (proposal_id, reeval_type, staleness_reason)
  SELECT p.id, 'staleness', 'unblocked_unpicked'
  FROM   roadmap_proposal.proposal p
  WHERE  p.status = 'DEVELOP'
    AND  p.gate_scanner_paused = false
    AND  NOT EXISTS (
           SELECT 1 FROM roadmap_proposal.proposal_dependencies d
           WHERE  d.to_proposal_id = p.id
             AND  d.dependency_type = 'blocks'
             AND  d.resolved = false)
    AND  p.modified_at < now() - (v_pickup_days || ' days')::interval
    AND  (p.reeval_exempt_until IS NULL OR p.reeval_exempt_until < now())
    AND  p.reeval_count < v_max_count
    AND  NOT EXISTS (SELECT 1 FROM roadmap_proposal.proposal_reeval_queue q
                     WHERE q.proposal_id = p.id AND q.outcome IS NULL)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_delta = ROW_COUNT;
  v_flagged := v_flagged + v_delta;

  -- Superseded: auto-obsolete OR enqueue
  IF v_auto_obsolete THEN
    WITH obsoleted AS (
      UPDATE roadmap_proposal.proposal p
         SET status = 'COMPLETE', maturity = 'obsolete', modified_at = now()
       WHERE p.status = 'DEVELOP'
         AND p.gate_scanner_paused = false
         AND (p.reeval_exempt_until IS NULL OR p.reeval_exempt_until < now())
         AND EXISTS (
               SELECT 1 FROM roadmap_proposal.proposal_dependencies d
               WHERE  d.to_proposal_id = p.id
                 AND  d.dependency_type = 'supersedes'
                 AND  d.resolved = false)
      RETURNING p.id AS proposal_id, p.maturity AS old_maturity
    )
    INSERT INTO roadmap_proposal.proposal_maturity_transitions
           (proposal_id, from_maturity, to_maturity, transition_reason, transitioned_by, decision_notes)
    SELECT o.proposal_id, o.old_maturity, 'obsolete', 'system', 'system:reeval',
           'auto-obsoleted: superseded by newer proposal'
    FROM   obsoleted o;
  ELSE
    INSERT INTO roadmap_proposal.proposal_reeval_queue (proposal_id, reeval_type, staleness_reason)
    SELECT p.id, 'staleness', 'superseded'
    FROM   roadmap_proposal.proposal p
    WHERE  p.status = 'DEVELOP'
      AND  p.gate_scanner_paused = false
      AND  EXISTS (
             SELECT 1 FROM roadmap_proposal.proposal_dependencies d
             WHERE  d.to_proposal_id = p.id
               AND  d.dependency_type = 'supersedes'
               AND  d.resolved = false)
      AND  (p.reeval_exempt_until IS NULL OR p.reeval_exempt_until < now())
      AND  p.reeval_count < v_max_count
      AND  NOT EXISTS (SELECT 1 FROM roadmap_proposal.proposal_reeval_queue q
                       WHERE q.proposal_id = p.id AND q.outcome IS NULL)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_delta = ROW_COUNT;
    v_flagged := v_flagged + v_delta;
  END IF;

  RETURN v_flagged;
END;
$$;

-- ────────────────────────────────────────────────────────────────
-- 8. Loop B: fn_flag_complete_mature_proposals()
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION roadmap.fn_flag_complete_mature_proposals()
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
  v_cadence_days INT := COALESCE((SELECT value::int FROM roadmap.config WHERE key = 'reeval_complete_cadence_days'), 90);
  v_max_count    INT := COALESCE((SELECT value::int FROM roadmap.config WHERE key = 'reeval_max_count'), 3);
  v_flagged      INT := 0;
BEGIN
  INSERT INTO roadmap_proposal.proposal_reeval_queue (proposal_id, reeval_type, staleness_reason)
  SELECT p.id, 'optimization', 'time_based'
  FROM   roadmap_proposal.proposal p
  WHERE  p.status = 'COMPLETE'
    AND  p.maturity = 'mature'
    AND  p.gate_scanner_paused = false
    AND  (p.reeval_exempt_until IS NULL OR p.reeval_exempt_until < now())
    AND  p.reeval_count < v_max_count
    AND  p.modified_at < now() - (v_cadence_days || ' days')::interval
    AND  NOT EXISTS (
           SELECT 1 FROM roadmap_proposal.proposal_reeval_queue q
           WHERE  q.proposal_id = p.id AND q.outcome IS NULL)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_flagged = ROW_COUNT;
  RETURN v_flagged;
END;
$$;
