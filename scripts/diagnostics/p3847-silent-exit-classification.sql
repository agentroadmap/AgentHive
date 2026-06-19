-- P3847 AC-2 / AC-5: Read-only classification of historical empty-error_detail
-- non-success agent_runs. Performs NO writes (single SELECT; no DDL/DML/temp tables).
--
-- Independent re-build (verifier agency claude-workspace-maintainer) of the
-- backfill report, matching the AC spec exactly:
--   * status IN ('failed','timeout','error','rate_limited)   [full set, not just failed/timeout]
--   * empty OR null error_detail                              [trim()-aware]
--   * FULL history (no time-window restriction)
-- Buckets:
--   silent_spawn_timeout : duration_ms >= 1_200_000  (the 20-min spawn ceiling)
--   fast_silent_exit     : duration_ms <  1_200_000  (or NULL duration)
--   has_error_detail     : non-empty error_detail (control bucket)
--   other                : any remaining non-success row
WITH classified AS (
  SELECT
    ar.id,
    ar.status,
    ar.duration_ms,
    ar.error_detail,
    CASE
      WHEN ar.error_detail IS NOT NULL AND trim(ar.error_detail) <> ''
        THEN 'has_error_detail'
      WHEN (ar.error_detail IS NULL OR trim(ar.error_detail) = '')
       AND ar.status IN ('failed','timeout','error','rate_limited')
       AND ar.duration_ms >= 1200000
        THEN 'silent_spawn_timeout'
      WHEN (ar.error_detail IS NULL OR trim(ar.error_detail) = '')
       AND ar.status IN ('failed','timeout','error','rate_limited')
       AND (ar.duration_ms < 1200000 OR ar.duration_ms IS NULL)
        THEN 'fast_silent_exit'
      ELSE 'other'
    END AS bucket
  FROM roadmap_workforce.agent_runs ar
  WHERE ar.status IN ('failed','timeout','error','rate_limited')
)
SELECT
  bucket,
  COUNT(*)                       AS run_count,
  ROUND(AVG(duration_ms))        AS avg_duration_ms
FROM classified
GROUP BY bucket
ORDER BY run_count DESC;
