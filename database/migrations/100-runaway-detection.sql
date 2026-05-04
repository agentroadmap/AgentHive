-- P475: Per-call tool log for velocity and pattern-based runaway detection
-- Enables Liaison to detect repetitive execution BEFORE N-strikes threshold is hit.

CREATE TABLE IF NOT EXISTS roadmap.tool_call_log (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  briefing_id uuid NOT NULL,
  tool_name text NOT NULL,
  args_hash text,       -- SHA256 truncated to 16 chars of serialized args (for deduplication)
  called_at timestamptz NOT NULL DEFAULT now()
);

-- Index for velocity check (calls in last N minutes)
CREATE INDEX IF NOT EXISTS tool_call_log_briefing_time_idx
  ON roadmap.tool_call_log (briefing_id, called_at DESC);

-- Index for pattern deduplication check
CREATE INDEX IF NOT EXISTS tool_call_log_pattern_idx
  ON roadmap.tool_call_log (briefing_id, tool_name, args_hash);

COMMENT ON TABLE roadmap.tool_call_log IS
'Per-call log for runaway detection. Tracks tool_name + args_hash per call so Liaison
can detect velocity spikes (>15 calls/min), repetitive patterns (same tool+args ≥3 in 10),
and sequence loops (same tool sequence repeated). Rows expire after 7 days.';

-- Auto-cleanup trigger: purge rows older than 7 days on INSERT
-- (Prevents unbounded growth; runaway analysis only needs recent history)
CREATE OR REPLACE FUNCTION roadmap.fn_tool_call_log_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Probabilistic cleanup: run on ~1% of inserts to avoid overhead
  IF random() < 0.01 THEN
    DELETE FROM roadmap.tool_call_log WHERE called_at < now() - interval '7 days';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trig_tool_call_log_cleanup ON roadmap.tool_call_log;
CREATE TRIGGER trig_tool_call_log_cleanup
  AFTER INSERT ON roadmap.tool_call_log
  FOR EACH ROW EXECUTE FUNCTION roadmap.fn_tool_call_log_cleanup();
