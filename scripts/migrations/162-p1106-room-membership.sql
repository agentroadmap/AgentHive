-- P1106: Room/Channel Membership ACL
-- Tracks who is permitted to post to team: and system: channels.
-- AC-28: Room/channel ACL enforced at INSERT via roadmap.room_membership.

CREATE TABLE IF NOT EXISTS roadmap.room_membership (
  channel        TEXT NOT NULL,
  agent_identity TEXT NOT NULL,
  granted_by     TEXT NOT NULL,
  granted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at     TIMESTAMPTZ,
  PRIMARY KEY (channel, agent_identity)
);

CREATE INDEX IF NOT EXISTS idx_room_membership_active
  ON roadmap.room_membership(channel)
  WHERE revoked_at IS NULL;

-- BEFORE INSERT trigger on message_ledger:
-- Reject inserts to team:* and system:* channels where from_agent is not a member.
-- Exempt from_agent starting with 'system:' (orchestrator, watchdog, escalation).
CREATE OR REPLACE FUNCTION roadmap.enforce_room_acl()
RETURNS TRIGGER AS $$
BEGIN
  -- Skip ACL for system: agents (orchestrator, watchdog, escalation, reaper)
  IF NEW.from_agent LIKE 'system:%' THEN
    RETURN NEW;
  END IF;

  -- Check ACL for team:* and system:* channels
  IF (NEW.channel LIKE 'team:%' OR NEW.channel LIKE 'system:%') THEN
    -- Verify membership: active (revoked_at IS NULL) row must exist
    IF NOT EXISTS (
      SELECT 1 FROM roadmap.room_membership
      WHERE channel = NEW.channel
        AND agent_identity = NEW.from_agent
        AND revoked_at IS NULL
    ) THEN
      RAISE EXCEPTION
        'ROOM_ACL_DENIED: agent % not authorized to post to channel %',
        NEW.from_agent, NEW.channel;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trig_room_acl ON roadmap.message_ledger;
CREATE TRIGGER trig_room_acl
  BEFORE INSERT ON roadmap.message_ledger
  FOR EACH ROW
  EXECUTE FUNCTION roadmap.enforce_room_acl();
