-- P1017 AC-26: Backfill migration_history for 119, 120, 132
--
-- Background: P888 deployed A2A foundation (migrations 119 & 120) and P993
-- deployed liaison task tracker (migration 132) to production, but these
-- were never recorded in roadmap.migration_history. Fresh tenants would skip
-- them. This migration backfills the history rows.
--
-- Idempotent: Uses ON CONFLICT DO NOTHING so re-running is safe.

BEGIN;

INSERT INTO roadmap.migration_history (
    filename,
    checksum_sha256,
    applied_at,
    applied_by,
    environment,
    status
) VALUES
    (
        '119-p888-a2a-notify-deploy.sql',
        'ae5f5ec08a83ec6567194b0bd2c8e6f7744d02a6f61e792ae425b4850287e624',
        now(),
        'backfill-p1017',
        'production',
        'applied'
    ),
    (
        '120-p907-message-ledger-thread-id.sql',
        '37ed2c7f2ce0c46add034df6797d1d16575d03c37c9903aa1e80ee455a063455',
        now(),
        'backfill-p1017',
        'production',
        'applied'
    ),
    (
        '132-p993-liaison-task-tracker.sql',
        '3be2bd16b596d2d83870e42cee7001b98a743443ae26859d0940c9f00690ffe8',
        now(),
        'backfill-p1017',
        'production',
        'applied'
    )
ON CONFLICT DO NOTHING;

COMMIT;
