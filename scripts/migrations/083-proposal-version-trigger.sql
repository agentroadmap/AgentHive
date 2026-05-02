-- 083: trigger-based proposal versioning (replaces app-layer snapshot in updateProposal)
--
-- Drop broken FK on author_identity: constraint references roadmap_proposal.agent_registry
-- which does not exist (registry lives in roadmap / roadmap_workforce schemas).
-- Version history is an audit log; author is informational text.
ALTER TABLE roadmap_proposal.proposal_version
  DROP CONSTRAINT IF EXISTS proposal_version_author_fkey;
--
-- Fires AFTER UPDATE on roadmap_proposal.proposal for every write path — MCP,
-- direct psql, migrations, future REST surfaces.  Actor identity is passed via
-- SET LOCAL app.current_actor = '<name>' before the UPDATE; falls back to
-- current_user when the session variable is absent.

CREATE OR REPLACE FUNCTION roadmap_proposal.fn_version_on_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  next_v  int;
  delta   jsonb := '{}';
  fields  text[] := '{}';
  actor   text;
BEGIN
  -- Build body_delta for changed text fields only
  IF OLD.title            IS DISTINCT FROM NEW.title            THEN delta := delta || jsonb_build_object('title',         jsonb_build_array(OLD.title,            NEW.title));            fields := array_append(fields, 'title'); END IF;
  IF OLD.summary          IS DISTINCT FROM NEW.summary          THEN delta := delta || jsonb_build_object('summary',       jsonb_build_array(OLD.summary,          NEW.summary));          fields := array_append(fields, 'summary'); END IF;
  IF OLD.motivation       IS DISTINCT FROM NEW.motivation       THEN delta := delta || jsonb_build_object('motivation',    jsonb_build_array(OLD.motivation,       NEW.motivation));       fields := array_append(fields, 'motivation'); END IF;
  IF OLD.design           IS DISTINCT FROM NEW.design           THEN delta := delta || jsonb_build_object('design',        jsonb_build_array(OLD.design,           NEW.design));           fields := array_append(fields, 'design'); END IF;
  IF OLD.drawbacks        IS DISTINCT FROM NEW.drawbacks        THEN delta := delta || jsonb_build_object('drawbacks',     jsonb_build_array(OLD.drawbacks,        NEW.drawbacks));        fields := array_append(fields, 'drawbacks'); END IF;
  IF OLD.alternatives     IS DISTINCT FROM NEW.alternatives     THEN delta := delta || jsonb_build_object('alternatives',  jsonb_build_array(OLD.alternatives,     NEW.alternatives));     fields := array_append(fields, 'alternatives'); END IF;
  IF OLD.dependency_note  IS DISTINCT FROM NEW.dependency_note  THEN delta := delta || jsonb_build_object('dependency_note', jsonb_build_array(OLD.dependency_note, NEW.dependency_note)); fields := array_append(fields, 'dependency_note'); END IF;

  -- Nothing changed in tracked fields — skip
  IF array_length(fields, 1) IS NULL THEN RETURN NEW; END IF;

  actor := COALESCE(
    NULLIF(current_setting('app.current_actor', true), ''),
    current_user
  );

  SELECT COALESCE(MAX(version_number), 0) + 1 INTO next_v
    FROM roadmap_proposal.proposal_version
   WHERE proposal_id = OLD.id;

  INSERT INTO roadmap_proposal.proposal_version
    (proposal_id, version_number, author_identity, change_summary, body_delta, metadata_delta_json)
  VALUES (
    OLD.id,
    next_v,
    actor,
    'Updated: ' || array_to_string(fields, ', '),
    delta::text,
    jsonb_build_object('changed_fields', to_jsonb(fields))
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_proposal_version ON roadmap_proposal.proposal;

CREATE TRIGGER trg_proposal_version
  AFTER UPDATE ON roadmap_proposal.proposal
  FOR EACH ROW EXECUTE FUNCTION roadmap_proposal.fn_version_on_update();
