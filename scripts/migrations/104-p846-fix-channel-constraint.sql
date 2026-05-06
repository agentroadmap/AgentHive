-- Migration 104: P846 — Widen message_ledger channel constraint
--
-- The original CHECK constraint ^(direct|team:.+|broadcast|system)$ only allows the
-- bare "system" value. P846 uses "system:operator" as the channel for operator A2A
-- notify messages, which fails the constraint and prevents trigger from firing.
--
-- New pattern: ^(direct|team:.+|broadcast|system(:.+)?)$
-- Allows: direct | team:<n> | broadcast | system | system:<suffix>

BEGIN;

ALTER TABLE roadmap.message_ledger
  DROP CONSTRAINT IF EXISTS message_ledger_channel_check;

ALTER TABLE roadmap.message_ledger
  ADD CONSTRAINT message_ledger_channel_check
  CHECK (
    channel IS NULL
    OR channel ~ '^(direct|team:.+|broadcast|system(:.+)?)$'
  );

COMMENT ON COLUMN roadmap.message_ledger.channel IS
  'direct, team:<n>, broadcast, system, or system:<qualifier>';

COMMIT;
