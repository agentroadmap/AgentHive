-- ============================================================
-- project-init/001-proposal.sql
-- Proposal tables: root table + p_version (with trigger),
-- p_dependency, p_criteria, p_review, p_decision, p_discussion,
-- p_activity, p_tag.
-- Run with: psql -v schema_name=agentHive -f 001-proposal.sql
-- ============================================================

\set ON_ERROR_STOP on

-- ============================================================
-- proposal — root proposal table
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.proposal (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  display_id       TEXT         NOT NULL UNIQUE,          -- 'P001', 'P190', etc.
  title            TEXT         NOT NULL,
  type             TEXT         NOT NULL,                 -- 'feature', 'bugfix', 'refactor', 'infra', 'research'
  status           TEXT         NOT NULL DEFAULT 'Draft'
                               CHECK (status IN ('Draft','Review','Develop','Merge','Complete','Deployed','Recycled')),
  maturity         TEXT         NOT NULL DEFAULT 'new'
                               CHECK (maturity IN ('new','active','mature','obsolete')),
  priority         TEXT         NOT NULL DEFAULT 'normal'
                               CHECK (priority IN ('critical','high','normal','low')),
  tier             TEXT         NOT NULL DEFAULT 'B'
                               CHECK (tier IN ('A','B','C')),
  parent_id        BIGINT       REFERENCES :schema_name.proposal (id) ON DELETE SET NULL,
  summary          TEXT,
  motivation       TEXT,
  design           TEXT,
  drawbacks        TEXT,
  alternatives     TEXT,
  dependency_note  TEXT,
  body_markdown    TEXT,
  author           TEXT,
  tags_jsonb       JSONB        NOT NULL DEFAULT '[]',
  metadata_jsonb   JSONB        NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS proposal_status ON :schema_name.proposal (status);
CREATE INDEX IF NOT EXISTS proposal_type ON :schema_name.proposal (type);
CREATE INDEX IF NOT EXISTS proposal_maturity ON :schema_name.proposal (maturity);
CREATE INDEX IF NOT EXISTS proposal_parent ON :schema_name.proposal (parent_id);

CREATE OR REPLACE TRIGGER set_updated_at_proposal
  BEFORE UPDATE ON :schema_name.proposal
  FOR EACH ROW EXECUTE FUNCTION :schema_name.set_updated_at();

COMMENT ON TABLE :schema_name.proposal IS
  'Root proposal table. One row per proposal. Children (version, criteria, etc.) reference this by id.';

-- ============================================================
-- p_version — proposal version history (trigger-populated)
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.p_version (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id      BIGINT       NOT NULL REFERENCES :schema_name.proposal (id) ON DELETE CASCADE,
  version_number   INT          NOT NULL,
  author_identity  TEXT         NOT NULL,
  change_summary   TEXT         NOT NULL,
  body_delta       TEXT,                                  -- field-level diff as JSON text
  metadata_jsonb   JSONB        NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (proposal_id, version_number)
);

CREATE INDEX IF NOT EXISTS pversion_proposal_desc
  ON :schema_name.p_version (proposal_id, version_number DESC);

COMMENT ON TABLE :schema_name.p_version IS
  'Append-only version history for proposals. Populated by trg_p_version trigger on proposal UPDATE.';

-- Trigger function: capture field-level delta on proposal UPDATE.
-- SET search_path pins this function to the owning project schema so the
-- body can reference pversion without schema qualification.
-- `:schema_name` is outside $$, so psql variable substitution works here.
CREATE OR REPLACE FUNCTION :schema_name.fn_version_on_update()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = :schema_name
AS $$
DECLARE
  next_v  int;
  delta   jsonb := '{}';
  fields  text[] := '{}';
  actor   text;
BEGIN
  IF OLD.title           IS DISTINCT FROM NEW.title           THEN delta := delta || jsonb_build_object('title',          jsonb_build_array(OLD.title,           NEW.title));           fields := array_append(fields, 'title');          END IF;
  IF OLD.summary         IS DISTINCT FROM NEW.summary         THEN delta := delta || jsonb_build_object('summary',        jsonb_build_array(OLD.summary,         NEW.summary));         fields := array_append(fields, 'summary');        END IF;
  IF OLD.motivation      IS DISTINCT FROM NEW.motivation      THEN delta := delta || jsonb_build_object('motivation',     jsonb_build_array(OLD.motivation,      NEW.motivation));      fields := array_append(fields, 'motivation');     END IF;
  IF OLD.design          IS DISTINCT FROM NEW.design          THEN delta := delta || jsonb_build_object('design',         jsonb_build_array(OLD.design,          NEW.design));          fields := array_append(fields, 'design');         END IF;
  IF OLD.drawbacks       IS DISTINCT FROM NEW.drawbacks       THEN delta := delta || jsonb_build_object('drawbacks',      jsonb_build_array(OLD.drawbacks,       NEW.drawbacks));       fields := array_append(fields, 'drawbacks');      END IF;
  IF OLD.alternatives    IS DISTINCT FROM NEW.alternatives    THEN delta := delta || jsonb_build_object('alternatives',   jsonb_build_array(OLD.alternatives,    NEW.alternatives));    fields := array_append(fields, 'alternatives');   END IF;
  IF OLD.dependency_note IS DISTINCT FROM NEW.dependency_note THEN delta := delta || jsonb_build_object('dependency_note',jsonb_build_array(OLD.dependency_note, NEW.dependency_note)); fields := array_append(fields, 'dependency_note'); END IF;

  IF array_length(fields, 1) IS NULL THEN RETURN NEW; END IF;

  actor := COALESCE(NULLIF(current_setting('app.current_actor', true), ''), current_user);

  SELECT COALESCE(MAX(version_number), 0) + 1 INTO next_v
    FROM pversion
   WHERE proposal_id = OLD.id;

  INSERT INTO pversion
    (proposal_id, version_number, author_identity, change_summary, body_delta, metadata_jsonb)
  VALUES (
    OLD.id, next_v, actor,
    'Updated: ' || array_to_string(fields, ', '),
    delta::text,
    jsonb_build_object('changed_fields', to_jsonb(fields))
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_p_version ON :schema_name.proposal;
CREATE TRIGGER trg_p_version
  AFTER UPDATE ON :schema_name.proposal
  FOR EACH ROW EXECUTE FUNCTION :schema_name.fn_version_on_update();

-- ============================================================
-- p_dependency — proposal dependency graph
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.p_dependency (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id      BIGINT       NOT NULL REFERENCES :schema_name.proposal (id) ON DELETE CASCADE,
  depends_on_id    BIGINT       REFERENCES :schema_name.proposal (id) ON DELETE SET NULL,
  depends_on_ref   TEXT,                                  -- display_id fallback for cross-project deps
  dep_type         TEXT         NOT NULL DEFAULT 'blocks'
                               CHECK (dep_type IN ('blocks','informs','relates','supersedes')),
  notes            TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pdependency_proposal ON :schema_name.p_dependency (proposal_id);
CREATE INDEX IF NOT EXISTS pdependency_depends_on ON :schema_name.p_dependency (depends_on_id);

COMMENT ON TABLE :schema_name.p_dependency IS
  'Proposal dependency edges. depends_on_id is NULL for cross-project deps; use depends_on_ref then.';

-- ============================================================
-- p_criteria — acceptance criteria
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.p_criteria (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id      BIGINT       NOT NULL REFERENCES :schema_name.proposal (id) ON DELETE CASCADE,
  ordinal          INT          NOT NULL DEFAULT 0,
  description      TEXT         NOT NULL,
  status           TEXT         NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','met','failed','skipped')),
  verified_by      TEXT,
  verified_at      TIMESTAMPTZ,
  notes            TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pcriteria_proposal ON :schema_name.p_criteria (proposal_id);

CREATE OR REPLACE TRIGGER set_updated_at_pcriteria
  BEFORE UPDATE ON :schema_name.p_criteria
  FOR EACH ROW EXECUTE FUNCTION :schema_name.set_updated_at();

COMMENT ON TABLE :schema_name.p_criteria IS
  'Acceptance criteria rows for a proposal. ordinal controls display order.';

-- ============================================================
-- p_review — review comments
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.p_review (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id      BIGINT       NOT NULL REFERENCES :schema_name.proposal (id) ON DELETE CASCADE,
  reviewer         TEXT         NOT NULL,
  verdict          TEXT
                               CHECK (verdict IN ('approve','reject','request_changes','comment', NULL)),
  body             TEXT         NOT NULL,
  metadata_jsonb   JSONB        NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS preview_proposal ON :schema_name.p_review (proposal_id);

COMMENT ON TABLE :schema_name.p_review IS
  'Review comments. verdict NULL = informational comment, non-null = formal decision input.';

-- ============================================================
-- p_decision — gate transition decisions
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.p_decision (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id      BIGINT       NOT NULL REFERENCES :schema_name.proposal (id) ON DELETE CASCADE,
  from_status      TEXT         NOT NULL,
  to_status        TEXT         NOT NULL,
  outcome          TEXT         NOT NULL
                               CHECK (outcome IN ('advance','reject','defer','split','archive')),
  actor            TEXT         NOT NULL,
  reason           TEXT,
  notes            TEXT,
  metadata_jsonb   JSONB        NOT NULL DEFAULT '{}',
  decided_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pdecision_proposal ON :schema_name.p_decision (proposal_id);

COMMENT ON TABLE :schema_name.p_decision IS
  'Gate transition decisions. One row per state machine transition event.';

-- ============================================================
-- p_discussion — threaded discussion on proposals
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.p_discussion (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id      BIGINT       NOT NULL REFERENCES :schema_name.proposal (id) ON DELETE CASCADE,
  parent_id        BIGINT       REFERENCES :schema_name.p_discussion (id) ON DELETE SET NULL,
  author           TEXT         NOT NULL,
  body             TEXT         NOT NULL,
  metadata_jsonb   JSONB        NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pdiscussion_proposal ON :schema_name.p_discussion (proposal_id);
CREATE INDEX IF NOT EXISTS pdiscussion_parent ON :schema_name.p_discussion (parent_id);

CREATE OR REPLACE TRIGGER set_updated_at_pdiscussion
  BEFORE UPDATE ON :schema_name.p_discussion
  FOR EACH ROW EXECUTE FUNCTION :schema_name.set_updated_at();

COMMENT ON TABLE :schema_name.p_discussion IS
  'Threaded discussion threads on proposals. parent_id = NULL means top-level thread.';

-- ============================================================
-- p_activity — audit log of all proposal mutations
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.p_activity (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id      BIGINT       NOT NULL REFERENCES :schema_name.proposal (id) ON DELETE CASCADE,
  actor            TEXT         NOT NULL,
  action           TEXT         NOT NULL,                 -- 'status_changed', 'field_updated', 'lease_claimed', etc.
  from_value       TEXT,
  to_value         TEXT,
  notes            TEXT,
  metadata_jsonb   JSONB        NOT NULL DEFAULT '{}',
  occurred_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pactivity_proposal ON :schema_name.p_activity (proposal_id);
CREATE INDEX IF NOT EXISTS pactivity_actor ON :schema_name.p_activity (actor);

COMMENT ON TABLE :schema_name.p_activity IS
  'Append-only activity log for a proposal. Every significant mutation produces a row.';

-- ============================================================
-- p_tag — proposal tags (denormalized for fast tag filtering)
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.p_tag (
  proposal_id      BIGINT       NOT NULL REFERENCES :schema_name.proposal (id) ON DELETE CASCADE,
  tag              TEXT         NOT NULL,
  PRIMARY KEY (proposal_id, tag)
);

CREATE INDEX IF NOT EXISTS ptag_tag ON :schema_name.p_tag (tag);

COMMENT ON TABLE :schema_name.p_tag IS
  'Proposal tag index. Kept in sync with proposal.tags_jsonb by application layer or trigger.';

-- ============================================================
-- Idempotent ALTER for existing deployments (P897)
-- Adds proposal.tier if the table was created before this
-- migration was applied.
-- ============================================================
ALTER TABLE :schema_name.proposal
  ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'B';
ALTER TABLE :schema_name.proposal
  DROP CONSTRAINT IF EXISTS proposal_tier_check;
ALTER TABLE :schema_name.proposal
  ADD CONSTRAINT proposal_tier_check CHECK (tier IN ('A','B','C'));
