-- 012-maturity-redesign.sql
-- Implements the PUML-designed maturity model per rfc_state_machine.puml legend:
--
--   1. Add maturity_state TEXT enum (new|active|mature|obsolete) — decoupled from status
--   2. Backfill maturity_state from current status
--   3. Data remediation — alien states: PROPOSAL→DRAFT, DEPLOYED→COMPLETE, DEFERRED→DRAFT
--   4. Remove alien states from CHECK constraints
--   5. Drop the backwards trigger (was deriving maturity FROM status, not the reverse)
--   6. Add gate-ready pg_notify trigger (fires when maturity_state → 'mature')
--   7. Add 'decision:' context prefix for gate decision notes
--   8. Fix transition_reason trigger default ('manual' is not a valid reason)
--   9. Fix v_mature_queue — broken column refs (priority_score, updated_at → modified_at)
--  10. Add v_proposal_full — full document JSONB view for markdown rendering
--  11. Drop dead rfc_state column
--
-- Rollback: see bottom of file for manual reversal steps
-- ============================================================

BEGIN;

-- ─── 1. Add maturity_state column ────────────────────────────────────────────

ALTER TABLE roadmap.proposal
  ADD COLUMN IF NOT EXISTS maturity_state TEXT
    DEFAULT 'new'
    CHECK (maturity_state IN ('new','active','mature','obsolete'));

COMMENT ON COLUMN roadmap.proposal.maturity_state IS
  'Universal proposal maturity: new → active → mature → obsolete. '
  'Set explicitly by agents via prop_set_maturity. '
  'Reaching ''mature'' fires pg_notify(''proposal_gate_ready'') to queue a D* gating review.';

-- ─── 2. Backfill maturity_state from current status ──────────────────────────

UPDATE roadmap.proposal
SET maturity_state = CASE
  WHEN status IN ('COMPLETE','MERGE')               THEN 'mature'
  WHEN status IN ('REJECTED','DISCARDED','REPLACED') THEN 'obsolete'
  WHEN status IN ('DEVELOP','REVIEW','MERGE')        THEN 'active'
  ELSE 'new'
END;

-- ─── 3. Data remediation — alien states ──────────────────────────────────────

-- 3a. PROPOSAL (pre-DRAFT intake state, not in state machine design) → DRAFT
UPDATE roadmap.proposal
  SET status = 'DRAFT'
  WHERE status = 'PROPOSAL';

UPDATE roadmap.proposal_state_transitions
  SET from_state = 'DRAFT' WHERE from_state = 'PROPOSAL';
UPDATE roadmap.proposal_state_transitions
  SET to_state   = 'DRAFT' WHERE to_state   = 'PROPOSAL';

-- 3b. DEPLOYED (not in state machine) → COMPLETE
UPDATE roadmap.proposal
  SET status = 'COMPLETE', maturity_state = 'mature'
  WHERE status = 'DEPLOYED';

-- proposal_state_transitions CHECK does not include DEPLOYED so no rows to fix there

-- 3c. DEFERRED (not in state machine; DRAFT + blocked dep covers this) → DRAFT
UPDATE roadmap.proposal
  SET status = 'DRAFT', blocked_by_dependencies = true
  WHERE status = 'DEFERRED';

UPDATE roadmap.proposal_state_transitions
  SET from_state = 'DRAFT' WHERE from_state = 'DEFERRED';
UPDATE roadmap.proposal_state_transitions
  SET to_state   = 'DRAFT' WHERE to_state   = 'DEFERRED';

-- 3d. Fix any transition_reason = 'manual' or 'system' (not in enum)
UPDATE roadmap.proposal_state_transitions
  SET transition_reason = 'submit'
  WHERE transition_reason NOT IN
    ('mature','decision','iteration','depend','discard','rejected','research','division','submit');

-- ─── 4. Remove alien states from CHECK constraints ───────────────────────────

-- proposal_valid_transitions — named constraint
ALTER TABLE roadmap.proposal_valid_transitions
  DROP CONSTRAINT IF EXISTS valid_transitions_states;
ALTER TABLE roadmap.proposal_valid_transitions
  ADD CONSTRAINT valid_transitions_states CHECK (
    from_state IN ('DRAFT','REVIEW','DEVELOP','MERGE','COMPLETE','DISCARDED','REJECTED','REPLACED')
    AND to_state IN ('DRAFT','REVIEW','DEVELOP','MERGE','COMPLETE','DISCARDED','REJECTED','REPLACED')
  );

DELETE FROM roadmap.proposal_valid_transitions
  WHERE from_state IN ('PROPOSAL','DEFERRED')
     OR to_state   IN ('PROPOSAL','DEFERRED');

-- proposal_state_transitions — inline column CHECKs (auto-named by Postgres)
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT constraint_name
    FROM information_schema.table_constraints
    WHERE table_schema = 'roadmap'
      AND table_name   = 'proposal_state_transitions'
      AND constraint_type = 'CHECK'
  LOOP
    EXECUTE format(
      'ALTER TABLE roadmap.proposal_state_transitions DROP CONSTRAINT IF EXISTS %I',
      r.constraint_name
    );
  END LOOP;
END $$;

ALTER TABLE roadmap.proposal_state_transitions
  ADD CONSTRAINT state_transitions_states CHECK (
    from_state IN ('DRAFT','REVIEW','DEVELOP','MERGE','COMPLETE','DISCARDED','REJECTED','REPLACED')
    AND to_state IN ('DRAFT','REVIEW','DEVELOP','MERGE','COMPLETE','DISCARDED','REJECTED','REPLACED')
  ),
  ADD CONSTRAINT state_transitions_reason CHECK (
    transition_reason IN
      ('mature','decision','iteration','depend','discard','rejected','research','division','submit')
  );

-- ─── 5. Drop the backwards maturity-from-status trigger ──────────────────────
-- This trigger derived maturity FROM status — the reverse of the intended design.
-- maturity_state is now set explicitly by agents via prop_set_maturity.

DROP TRIGGER IF EXISTS trg_proposal_maturity_sync ON roadmap.proposal;
DROP FUNCTION IF EXISTS roadmap.fn_sync_proposal_maturity();

-- Keep trg_proposal_maturity_init but fix it to initialise maturity_state = 'new'
CREATE OR REPLACE FUNCTION roadmap.fn_init_proposal_maturity()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Initialise the legacy JSONB column (kept for transition period)
  IF NEW.maturity IS NULL THEN
    NEW.maturity := jsonb_build_object(NEW.status, 'new');
  END IF;
  -- Initialise the new text column
  IF NEW.maturity_state IS NULL THEN
    NEW.maturity_state := 'new';
  END IF;
  RETURN NEW;
END;
$$;

-- ─── 6. Fix the audit trigger default reason ─────────────────────────────────
-- The existing trigger inserts transition_reason = 'manual' which is not in the
-- allowed enum. Replace with 'submit' as the system-initiated default.

CREATE OR REPLACE FUNCTION roadmap.log_proposal_state_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_agent text;
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    -- Read agent identity set by application layer (transitionProposal sets this)
    v_agent := current_setting('app.agent_identity', true);
    INSERT INTO roadmap.proposal_state_transitions (
      proposal_id, from_state, to_state,
      transition_reason, transitioned_by, notes
    ) VALUES (
      NEW.id,
      OLD.status,
      NEW.status,
      'submit',    -- application layer will UPDATE this with the real reason
      v_agent,
      'Status changed from ' || OLD.status || ' to ' || NEW.status
    );
  END IF;
  NEW.modified_at := NOW();
  RETURN NEW;
END;
$$;

-- Recreate the trigger targeting the roadmap schema table
DROP TRIGGER IF EXISTS trg_proposal_state_change ON roadmap.proposal;
CREATE TRIGGER trg_proposal_state_change
  BEFORE UPDATE OF status ON roadmap.proposal
  FOR EACH ROW EXECUTE FUNCTION roadmap.log_proposal_state_change();

-- ─── 7. Gate-ready notification trigger ──────────────────────────────────────
-- Fires pg_notify('proposal_gate_ready', ...) when an agent sets maturity_state
-- to 'mature'. The pipeline listens and queues the appropriate D* gating review.

CREATE OR REPLACE FUNCTION roadmap.fn_notify_gate_ready()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.maturity_state = 'mature'
     AND (OLD.maturity_state IS DISTINCT FROM 'mature')
     AND NEW.status NOT IN ('COMPLETE','REJECTED','DISCARDED','REPLACED')
  THEN
    PERFORM pg_notify(
      'proposal_gate_ready',
      json_build_object(
        'display_id', NEW.display_id,
        'id',         NEW.id,
        'title',      NEW.title,
        'status',     NEW.status,
        'gate',       CASE NEW.status
                        WHEN 'DRAFT'   THEN 'D1'  -- → Review
                        WHEN 'REVIEW'  THEN 'D2'  -- → Develop
                        WHEN 'DEVELOP' THEN 'D3'  -- → Merge
                        WHEN 'MERGE'   THEN 'D4'  -- → Complete
                        ELSE 'D?'
                      END
      )::text
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_gate_ready ON roadmap.proposal;
CREATE TRIGGER trg_gate_ready
  AFTER UPDATE OF maturity_state ON roadmap.proposal
  FOR EACH ROW EXECUTE FUNCTION roadmap.fn_notify_gate_ready();

-- ─── 8. Add 'decision:' context prefix ───────────────────────────────────────
-- Required for D* gate decision records in proposal_discussions.

ALTER TABLE roadmap.proposal_discussions
  DROP CONSTRAINT IF EXISTS proposal_discussions_context_prefix_check;
ALTER TABLE roadmap.proposal_discussions
  ADD CONSTRAINT proposal_discussions_context_prefix_check
    CHECK (context_prefix IN (
      'arch:','team:','critical:','security:',
      'general:','feedback:','concern:','poc:','decision:'
    ));

-- ─── 9. Fix v_mature_queue ────────────────────────────────────────────────────

DROP VIEW IF EXISTS roadmap.v_mature_queue;
CREATE VIEW roadmap.v_mature_queue AS
SELECT
    p.display_id,
    p.title,
    p.status           AS current_state,
    p.maturity_state,
    p.priority,
    pvt.to_state       AS recommended_next_state,
    pvt.requires_ac,
    COALESCE(ac.total,  0)::int AS total_ac,
    COALESCE(ac.passed, 0)::int AS passed_ac,
    CASE
        WHEN pvt.requires_ac = 'all'  AND ac.passed < ac.total THEN 'ac_incomplete'
        WHEN ac.total = 0                                       THEN 'no_ac_defined'
        ELSE 'ready'
    END AS readiness
FROM roadmap.proposal p
JOIN LATERAL (
    SELECT to_state, requires_ac
    FROM roadmap.proposal_valid_transitions
    WHERE from_state = p.status
    ORDER BY id
    LIMIT 1
) pvt ON true
LEFT JOIN LATERAL (
    SELECT
        COUNT(*)                                         AS total,
        COUNT(*) FILTER (WHERE status = 'pass')         AS passed
    FROM roadmap.proposal_acceptance_criteria
    WHERE proposal_id = p.id
) ac ON true
WHERE p.maturity_state = 'mature'
  AND p.status NOT IN ('COMPLETE','DISCARDED','REJECTED','REPLACED')
ORDER BY p.priority DESC NULLS LAST, p.modified_at ASC;

-- ─── 10. v_proposal_full — full document JSONB for markdown rendering ─────────

DROP VIEW IF EXISTS roadmap.v_proposal_full;
CREATE VIEW roadmap.v_proposal_full AS
WITH
  ac_agg AS (
    SELECT
      proposal_id,
      jsonb_agg(
        jsonb_build_object(
          'item',    item_number,
          'text',    criterion_text,
          'status',  status,
          'by',      verified_by,
          'notes',   verification_notes,
          'at',      verified_at
        ) ORDER BY item_number
      )                                               AS items,
      COUNT(*)::int                                   AS total,
      COUNT(*) FILTER (WHERE status = 'pass')::int    AS passed,
      COUNT(*) FILTER (WHERE status = 'fail')::int    AS failed,
      COUNT(*) FILTER (WHERE status = 'pending')::int AS pending
    FROM roadmap.proposal_acceptance_criteria
    GROUP BY proposal_id
  ),
  deps_agg AS (
    SELECT
      d.from_proposal_id AS proposal_id,
      jsonb_agg(
        jsonb_build_object(
          'type',     d.dependency_type,
          'id',       p2.display_id,
          'title',    p2.title,
          'status',   p2.status,
          'maturity', p2.maturity_state,
          'resolved', d.resolved
        ) ORDER BY p2.display_id
      ) AS items
    FROM roadmap.proposal_dependencies d
    JOIN roadmap.proposal p2 ON p2.id = d.to_proposal_id
    GROUP BY d.from_proposal_id
  ),
  disc_agg AS (
    SELECT
      proposal_id,
      jsonb_agg(
        jsonb_build_object(
          'id',     id,
          'author', author_identity,
          'prefix', context_prefix,
          'body',   body,
          'at',     created_at
        ) ORDER BY created_at
      ) AS items
    FROM roadmap.proposal_discussions
    WHERE parent_id IS NULL
    GROUP BY proposal_id
  ),
  review_agg AS (
    SELECT
      proposal_id,
      jsonb_agg(
        jsonb_build_object(
          'reviewer', reviewer_identity,
          'verdict',  verdict,
          'notes',    notes,
          'blocking', is_blocking,
          'at',       reviewed_at
        ) ORDER BY reviewed_at
      )                                                        AS items,
      bool_or(verdict = 'approve')                            AS any_approve,
      bool_or(verdict = 'reject' AND is_blocking = true)      AS has_blocker
    FROM roadmap.proposal_reviews
    GROUP BY proposal_id
  ),
  timeline_agg AS (
    SELECT
      proposal_id,
      jsonb_agg(
        jsonb_build_object(
          'from',   from_state,
          'to',     to_state,
          'reason', transition_reason,
          'by',     transitioned_by,
          'notes',  notes,
          'at',     transitioned_at
        ) ORDER BY transitioned_at
      ) AS items
    FROM roadmap.proposal_state_transitions
    GROUP BY proposal_id
  )
SELECT
  p.id,
  p.display_id,
  p.type,
  p.status,
  p.maturity_state,
  p.maturity,           -- legacy JSONB kept during transition period
  p.priority,
  p.tags,
  p.created_at,
  p.modified_at,
  -- Flat columns for fast WHERE / ORDER BY without unpacking JSONB
  COALESCE(ac.total,   0) AS ac_total,
  COALESCE(ac.passed,  0) AS ac_passed,
  COALESCE(ac.failed,  0) AS ac_failed,
  COALESCE(ac.pending, 0) AS ac_pending,
  COALESCE(rev.any_approve, false) AS review_approved,
  COALESCE(rev.has_blocker,  false) AS review_blocked,
  -- Full document for markdown rendering
  jsonb_build_object(
    'meta', jsonb_build_object(
      'id',          p.display_id,
      'type',        p.type,
      'status',      p.status,
      'maturity',    p.maturity_state,
      'priority',    p.priority,
      'tags',        COALESCE(p.tags, '[]'::jsonb),
      'parent',      par.display_id,
      'created_at',  p.created_at,
      'modified_at', p.modified_at,
      'ac_summary',  jsonb_build_object(
        'total',   COALESCE(ac.total,   0),
        'passed',  COALESCE(ac.passed,  0),
        'failed',  COALESCE(ac.failed,  0),
        'pending', COALESCE(ac.pending, 0)
      )
    ),
    'title',               p.title,
    'summary',             p.summary,
    'motivation',          p.motivation,
    'design',              p.design,
    'drawbacks',           p.drawbacks,
    'alternatives',        p.alternatives,
    'dependency',          p.dependency,
    'acceptance_criteria', COALESCE(ac.items,   '[]'::jsonb),
    'dependencies',        COALESCE(deps.items, '[]'::jsonb),
    'discussions',         COALESCE(disc.items, '[]'::jsonb),
    'reviews', jsonb_build_object(
      'items',       COALESCE(rev.items,      '[]'::jsonb),
      'approved',    COALESCE(rev.any_approve, false),
      'has_blocker', COALESCE(rev.has_blocker, false)
    ),
    'timeline', COALESCE(tl.items,  '[]'::jsonb),
    'audit',    COALESCE(p.audit,   '[]'::jsonb)
  ) AS full_document
FROM roadmap.proposal p
LEFT JOIN roadmap.proposal     par  ON par.id  = p.parent_id
LEFT JOIN ac_agg               ac   ON ac.proposal_id   = p.id
LEFT JOIN deps_agg             deps ON deps.proposal_id = p.id
LEFT JOIN disc_agg             disc ON disc.proposal_id = p.id
LEFT JOIN review_agg           rev  ON rev.proposal_id  = p.id
LEFT JOIN timeline_agg         tl   ON tl.proposal_id   = p.id;

COMMENT ON VIEW roadmap.v_proposal_full IS
  'Full proposal document joining all child tables as JSONB. '
  'Use full_document for markdown rendering. '
  'Use flat columns (ac_total, review_approved, etc.) for filtering and sorting.';

-- ─── 11. Drop dead rfc_state column ──────────────────────────────────────────
-- Was defined in rfc-schema-live.sql but never used by application code.

ALTER TABLE roadmap.proposal DROP COLUMN IF EXISTS rfc_state;

-- ─── Grant views to agent users ──────────────────────────────────────────────
-- Mirrors the pattern in migration 009 for roadmap schema grants.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT rolname FROM pg_roles
    WHERE rolname LIKE 'agent_%' OR rolname LIKE 'worktree_%'
  LOOP
    EXECUTE format('GRANT SELECT ON roadmap.v_mature_queue TO %I', r.rolname);
    EXECUTE format('GRANT SELECT ON roadmap.v_proposal_full TO %I', r.rolname);
  END LOOP;
END $$;

COMMIT;

-- ============================================================
-- ROLLBACK (manual — run these if something goes wrong BEFORE COMMIT)
-- ============================================================
-- ROLLBACK;
-- ALTER TABLE roadmap.proposal DROP COLUMN IF EXISTS maturity_state;
-- (restore data from backup before running this migration)
-- ============================================================
