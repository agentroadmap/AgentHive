-- P3847: Add briefing_id to agent_runs for silent-spawn progress detection.
-- The watchdog (AC-3) joins agent_runs → tool_call_log via this column to
-- distinguish genuinely silent runs from legitimately progressing ones.

ALTER TABLE roadmap_workforce.agent_runs
  ADD COLUMN IF NOT EXISTS briefing_id UUID NULL;

COMMENT ON COLUMN roadmap_workforce.agent_runs.briefing_id
  IS 'P3847 AC-3: Briefing used by this spawn. Joins roadmap.tool_call_log for no-progress detection.';

CREATE INDEX IF NOT EXISTS idx_agent_runs_briefing_id
  ON roadmap_workforce.agent_runs (briefing_id)
  WHERE briefing_id IS NOT NULL;

-- Partial index to speed up watchdog scan: running rows started > 5 min ago.
CREATE INDEX IF NOT EXISTS idx_agent_runs_running_old
  ON roadmap_workforce.agent_runs (started_at)
  WHERE status = 'running';
