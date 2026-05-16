-- Migration 168: P1121 forensic snapshot table for pre-cutover stuck pile
-- Freezes the identity of unread messages at cutover for postmortem verification

CREATE TABLE IF NOT EXISTS roadmap.pre_cutover_stuck_snapshot (
  message_id BIGINT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT,
  message_type TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  read_at TIMESTAMPTZ,
  acked_at TIMESTAMPTZ,
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for diagnostic queries by recipient
CREATE INDEX IF NOT EXISTS idx_pre_cutover_snapshot_to_agent
  ON roadmap.pre_cutover_stuck_snapshot(to_agent);

-- Index for snapshots taken after cutover (daily cron queries)
CREATE INDEX IF NOT EXISTS idx_pre_cutover_snapshot_at
  ON roadmap.pre_cutover_stuck_snapshot(snapshot_at DESC);
