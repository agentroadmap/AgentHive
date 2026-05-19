-- P1103 AC-9: Message bus drift detection.
--
-- Rows written to liaison_message but not mirrored to message_ledger (last 5 min).
-- Run every 5 minutes as a cron or operator probe.
-- Safe to promote 'unified_message_bus_cutover' when < 0.5% for 3 consecutive days.

SELECT
    count(*) AS unmirrored_last_5min,
    (
        SELECT count(*) FROM roadmap.liaison_message
        WHERE created_at > now() - interval '5 minutes'
    ) AS total_last_5min,
    CASE
        WHEN (
            SELECT count(*) FROM roadmap.liaison_message
            WHERE created_at > now() - interval '5 minutes'
        ) = 0 THEN 0
        ELSE round(
            100.0 * count(*) / (
                SELECT count(*) FROM roadmap.liaison_message
                WHERE created_at > now() - interval '5 minutes'
            ), 2
        )
    END AS drift_pct
FROM roadmap.liaison_message lm
WHERE lm.created_at > now() - interval '5 minutes'
  AND lm.ledger_id IS NULL;
