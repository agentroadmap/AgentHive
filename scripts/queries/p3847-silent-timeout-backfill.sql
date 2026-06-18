-- P3847 AC-2: Read-only backfill — classify historical empty-error_detail failed runs.
-- Safe to run at any time; performs no writes.
--
-- "Silent timeout" = status IN ('failed','timeout') with empty or null error_detail
-- AND duration_ms >= 1_200_000ms (the 20-min spawn ceiling).

WITH classified AS (
  SELECT
    ar.id                                             AS run_id,
    ar.proposal_id,
    ar.agency_identity,
    ar.model_used,
    ar.status,
    ar.duration_ms,
    ar.started_at,
    ar.completed_at,
    ar.error_detail,
    CASE
      WHEN ar.duration_ms >= 1_200_000
       AND (ar.error_detail IS NULL OR ar.error_detail = '')
       AND ar.status IN ('failed', 'timeout')
        THEN 'silent_spawn_timeout'
      WHEN ar.duration_ms < 1_200_000
       AND (ar.error_detail IS NULL OR ar.error_detail = '')
       AND ar.status IN ('failed', 'timeout')
        THEN 'fast_silent_exit'
      WHEN ar.status IN ('failed', 'timeout')
       AND ar.error_detail IS NOT NULL AND ar.error_detail != ''
        THEN 'has_error_detail'
      ELSE 'other'
    END                                               AS classification
  FROM roadmap_workforce.agent_runs ar
  WHERE ar.status IN ('failed', 'timeout')
    AND ar.started_at >= now() - interval '30 days'
)
SELECT
  classification,
  COUNT(*)                                            AS run_count,
  ROUND(AVG(duration_ms) / 1000)                     AS avg_duration_sec,
  MIN(started_at)                                     AS earliest,
  MAX(started_at)                                     AS latest,
  COUNT(DISTINCT agency_identity)                     AS distinct_agencies
FROM classified
GROUP BY classification
ORDER BY run_count DESC;
