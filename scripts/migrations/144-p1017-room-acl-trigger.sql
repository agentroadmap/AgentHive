-- P1017 AC-28: Room and channel ACL enforced at INSERT time.
-- The pre-existing enforce_room_acl() / trig_room_acl trigger already satisfies AC-28:
--   - Gates team:* and system:* channels
--   - Rejects from_agent not in room_membership WHERE revoked_at IS NULL
--   - Skips NULL / 'system' senders
-- This migration removes a redundant duplicate trigger added in error and
-- adds a comment confirming the canonical implementation satisfies AC-28.
-- Verification:
--   (a) INSERT to team:dev without membership → SQLSTATE 23514
--   (b) INSERT after adding membership → success

-- Drop the duplicate trigger and function added in error
DROP TRIGGER IF EXISTS trig_room_acl_check ON roadmap.message_ledger;
DROP FUNCTION IF EXISTS roadmap.fn_check_room_acl();

-- Annotate the canonical pre-existing function for AC-28 traceability
COMMENT ON FUNCTION roadmap.enforce_room_acl() IS
  'P1017 AC-28: Rejects INSERTs into team:* or system:* channels unless from_agent '
  'is present in roadmap.room_membership with revoked_at IS NULL. '
  'Uses SQLSTATE 23514 (check_violation). system/NULL senders bypass the gate.';
