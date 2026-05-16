-- P1104: Add presence_state column to agency table
-- AC-6: presence_state TEXT column with CHECK constraint

ALTER TABLE roadmap.agency
  ADD COLUMN IF NOT EXISTS presence_state TEXT NOT NULL DEFAULT 'offline'
  CHECK (presence_state IN ('online','busy','away','offline'));

COMMENT ON COLUMN roadmap.agency.presence_state IS
  'Agency presence state: online (heartbeat fresh, no active dispatch), busy (active dispatch or running agents), away (poke timeout), offline (dormancy)';
