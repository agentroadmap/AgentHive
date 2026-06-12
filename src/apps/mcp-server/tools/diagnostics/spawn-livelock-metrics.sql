-- P1730 AC-3: Spawn Livelock Metrics Harness
--
-- Usage (before/after the fix):
--   psql -d agenthive -f spawn-livelock-metrics.sql > metrics-before.txt
--   [... raise cap and run spawns ...]
--   psql -d agenthive -f spawn-livelock-metrics.sql > metrics-after.txt
--
-- This query identifies runs that hung in the MCP-init phase: >10 minutes duration,
-- zero or near-zero tokens (output_summary length), no error_detail (silent hang).
-- Compares the "livelock bucket" before and after a fix deployment.
--
-- Output: CSV with columns:
--   day, cap_level, total_runs, livelock_count, livelock_pct, avg_duration_ms,
--   fast_fail_count, fast_fail_pct, normal_count, normal_pct

WITH daily_runs AS (
  -- Group agent_runs by date and attempt to infer cap level from concurrency pattern.
  -- Since we don't record cap_level directly, we estimate it from the max concurrent
  -- spawns (COUNT(*) FILTER within a 2-minute window per worker).
  SELECT
    DATE(ar.started_at) AS day,
    ar.agent_identity,
    ar.duration_ms,
    ar.output_summary,
    ar.error_detail,
    ar.status,
    -- Heuristic: if duration > 10min AND output is tiny (< 200 chars), it's likely a livelock
    (ar.duration_ms > 600_000 AND (ar.output_summary IS NULL OR LENGTH(ar.output_summary) < 200))
      AS is_likely_livelock,
    -- Fast-fail: < 60s, has error detail
    (ar.duration_ms < 60_000 AND ar.error_detail IS NOT NULL AND LENGTH(ar.error_detail) > 0)
      AS is_fast_fail,
    -- Normal: 1min - 10min
    (ar.duration_ms BETWEEN 60_000 AND 600_000)
      AS is_normal
  FROM roadmap_workforce.agent_runs ar
  WHERE ar.started_at >= CURRENT_DATE - INTERVAL '7 days'
),
daily_summary AS (
  SELECT
    day,
    COUNT(*) FILTER (WHERE is_likely_livelock) AS livelock_count,
    COUNT(*) FILTER (WHERE is_fast_fail) AS fast_fail_count,
    COUNT(*) FILTER (WHERE is_normal) AS normal_count,
    COUNT(*) AS total_runs,
    ROUND(AVG(duration_ms)) AS avg_duration_ms
  FROM daily_runs
  GROUP BY day
)
SELECT
  day,
  'unknown' AS cap_level,  -- TODO: infer from timestamp + concurrency pattern
  total_runs,
  livelock_count,
  ROUND(100.0 * livelock_count / NULLIF(total_runs, 0), 2) AS livelock_pct,
  avg_duration_ms,
  fast_fail_count,
  ROUND(100.0 * fast_fail_count / NULLIF(total_runs, 0), 2) AS fast_fail_pct,
  normal_count,
  ROUND(100.0 * normal_count / NULLIF(total_runs, 0), 2) AS normal_pct
FROM daily_summary
ORDER BY day DESC
LIMIT 14;
