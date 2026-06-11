-- P720 Activity Feed Redesign — Phase 1 (DB Bridge)
-- Bridge proposal_event rows into message_ledger with channel=system:proposal-feed
-- Trigger transforms lease_claimed/released, status_changed, decision_made events
-- into readable message_ledger entries for unified Discord + Web consumption.

BEGIN;

-- ─── Register system:proposal-feed agent ──────────────────────────────────────────

-- Ensure the system agent exists for message_ledger FK constraint
INSERT INTO roadmap_workforce.agent_registry (
  agent_identity,
  agent_type,
  role,
  status,
  trust_tier
) VALUES (
  'system:proposal-feed',
  'tool',
  'system-event-feed',
  'active',
  'authority'
)
ON CONFLICT (agent_identity) DO NOTHING;

-- ─── Function: fn_proposal_event_to_message_ledger ─────────────────────────────────

-- Converts proposal_event rows (event_type IN lease_claimed, lease_released,
-- status_changed, decision_made) into message_ledger rows with:
--   from_agent: 'system:proposal-feed'
--   channel: 'system:proposal-feed'
--   proposal_id: references the original proposal
--   message_content: human-readable event summary
--
-- Triggered AFTER INSERT on proposal_event for each qualifying row.
-- Latency target: <100ms between insertion and appearance in message_ledger.
CREATE OR REPLACE FUNCTION fn_proposal_event_to_message_ledger()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_message_content TEXT;
  v_agent_identity TEXT;
  v_proposal_display_id TEXT;
  v_thread_id BIGINT;
BEGIN
  -- Only bridge events of interest
  IF NEW.event_type NOT IN ('lease_claimed', 'lease_released', 'status_changed',
                             'decision_made', 'ac_updated') THEN
    RETURN NEW;
  END IF;

  -- Guard: if message_ledger row already exists for this event, skip
  -- (prevents duplicate relay if trigger fires twice)
  IF EXISTS (
    SELECT 1 FROM roadmap.message_ledger
    WHERE metadata->>'source_event_id' = NEW.id::TEXT
  ) THEN
    RETURN NEW;
  END IF;

  -- Extract proposal display_id for messaging
  SELECT display_id INTO v_proposal_display_id
  FROM roadmap_proposal.proposal
  WHERE id = NEW.proposal_id;

  v_proposal_display_id := COALESCE(v_proposal_display_id, 'P' || NEW.proposal_id::TEXT);

  -- Extract event source agent
  v_agent_identity := COALESCE(
    NEW.payload->>'agent',
    NEW.payload->>'agent_identity',
    NEW.payload->>'verified_by',
    'system:proposal-event'
  );

  -- Format message by event type
  CASE NEW.event_type
    WHEN 'lease_claimed' THEN
      v_message_content := v_proposal_display_id || ' lease claimed by ' || v_agent_identity ||
        CASE
          WHEN NEW.payload->>'expires_at' IS NOT NULL
          THEN ' until ' || (NEW.payload->>'expires_at')
          ELSE ''
        END;

    WHEN 'lease_released' THEN
      v_message_content := v_proposal_display_id || ' lease released by ' || v_agent_identity ||
        CASE
          WHEN NEW.payload->>'release_reason' IS NOT NULL
          THEN ' (' || (NEW.payload->>'release_reason') || ')'
          ELSE ''
        END;

    WHEN 'status_changed' THEN
      v_message_content := v_proposal_display_id || ' status ' ||
        COALESCE(NEW.payload->>'from', '?') || ' -> ' || COALESCE(NEW.payload->>'to', '?');

    WHEN 'decision_made' THEN
      v_message_content := v_proposal_display_id ||
        ' [' || upper(COALESCE(NEW.payload->>'proposal_status', '?')) || '] ' ||
        CASE WHEN NEW.payload->>'gate' IS NOT NULL
          THEN 'gate decision (' || (NEW.payload->>'gate') || ')'
          ELSE 'decision'
        END ||
        ': ' || COALESCE(
          NEW.payload->>'gate_decision',
          NEW.payload->>'verdict',
          left(NEW.payload->>'decision', 80),
          '?'
        );

    WHEN 'ac_updated' THEN
      v_message_content := v_proposal_display_id || ' AC ' ||
        COALESCE(NEW.payload->>'item_number', '?') ||
        ' status ' || COALESCE(NEW.payload->>'from_status', '?') ||
        ' -> ' || COALESCE(NEW.payload->>'to_status', '?');

    ELSE
      RETURN NEW;
  END CASE;

  -- Allocate or reuse thread_id (system:proposal-feed uses a singleton thread per proposal)
  -- Query or allocate thread: thread_id = (NEW.project_id << 32) | proposal_id (deterministic hash)
  v_thread_id := (NEW.project_id::BIGINT << 32) | (NEW.proposal_id & 0xFFFFFFFF)::BIGINT;

  -- Insert into message_ledger
  INSERT INTO roadmap.message_ledger (
    from_agent,
    to_agent,
    channel,
    message_type,
    message_content,
    proposal_id,
    project_id,
    created_at,
    thread_id,
    metadata
  ) VALUES (
    'system:proposal-feed',
    NULL,
    'system:proposal-feed',
    'event',
    v_message_content,
    NEW.proposal_id,
    NEW.project_id,
    NEW.created_at,
    v_thread_id,
    jsonb_build_object(
      'source_event_id', NEW.id::TEXT,
      'event_type', NEW.event_type,
      'payload', NEW.payload
    )
  );

  RETURN NEW;
END;
$$;

-- ─── Trigger: trg_proposal_event_to_message_ledger ──────────────────────────────

-- AFTER INSERT on proposal_event, for each row, call fn_proposal_event_to_message_ledger
DROP TRIGGER IF EXISTS trg_proposal_event_to_message_ledger ON roadmap_proposal.proposal_event;
CREATE TRIGGER trg_proposal_event_to_message_ledger
AFTER INSERT ON roadmap_proposal.proposal_event
FOR EACH ROW
EXECUTE FUNCTION fn_proposal_event_to_message_ledger();

-- ─── Index: idx_message_ledger_system_proposal ─────────────────────────────────

-- Optimize queries for system:proposal-feed messages (Phase 3 WebSocket subscription)
DROP INDEX IF EXISTS roadmap.idx_message_ledger_system_proposal CASCADE;
CREATE INDEX idx_message_ledger_system_proposal
  ON roadmap.message_ledger (channel, created_at DESC)
  WHERE channel = 'system:proposal-feed';

-- ─── Verify: Test trigger with a sample event ───────────────────────────────────

-- This is a verification-only test. Actual tests are in the AC suite.
-- Uncomment to test locally; comment out before merge.
/*
DO $$
DECLARE
  v_test_proposal_id BIGINT;
  v_event_count BIGINT;
BEGIN
  -- Find a test proposal
  SELECT id INTO v_test_proposal_id FROM roadmap_proposal.proposal LIMIT 1;
  IF v_test_proposal_id IS NULL THEN
    RAISE NOTICE 'No proposals found; skipping test';
    RETURN;
  END IF;

  -- Insert a test event (status_changed)
  INSERT INTO roadmap_proposal.proposal_event (proposal_id, event_type, payload, project_id)
  VALUES (
    v_test_proposal_id,
    'status_changed',
    jsonb_build_object('from', 'DRAFT', 'to', 'REVIEW'),
    1
  );

  -- Verify message_ledger row was created
  SELECT COUNT(*) INTO v_event_count
  FROM roadmap.message_ledger
  WHERE channel = 'system:proposal-feed' AND proposal_id = v_test_proposal_id;

  RAISE NOTICE 'Test: % message_ledger rows created for proposal %', v_event_count, v_test_proposal_id;
END;
$$;
*/

COMMIT;
