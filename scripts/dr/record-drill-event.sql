-- scripts/dr/record-drill-event.sql
-- Record a DR drill or backup restore-test event in governance.decision_log.
-- Used by: drill-runbook.md §2.7/§3.5 and backup-restore-test.sh step 6.
--
-- Required psql -v variables:
--   -v event_kind='dr_drill'               (or 'backup_verified', 'backup_broken')
--   -v operator='firstname.lastname'
--   -v rpo_seconds='45'
--   -v rto_seconds='187'
--   -v decision_seconds='28'
--   -v clock_skew_max='2'
--   -v notes='"clean failover drill; no active leases"'
--
-- Unlike record-dr-event.sql (which handles production failover events and
-- requires failover_time/old_primary/new_primary), this file handles drill and
-- restore-test outcomes where those fields do not apply.

\set ON_ERROR_STOP on

\if :{?event_kind}
\else
  \echo 'ERROR: -v event_kind=<kind> is required (e.g. dr_drill, backup_verified, backup_broken)'
  \quit
\endif
\if :{?operator}
\else
  \echo 'ERROR: -v operator=<name> is required'
  \quit
\endif
\if :{?rpo_seconds}
\else
  \echo 'ERROR: -v rpo_seconds=<N> is required'
  \quit
\endif
\if :{?rto_seconds}
\else
  \echo 'ERROR: -v rto_seconds=<N> is required'
  \quit
\endif
\if :{?decision_seconds}
\else
  \echo 'ERROR: -v decision_seconds=<N> is required'
  \quit
\endif
\if :{?clock_skew_max}
\else
  \echo 'ERROR: -v clock_skew_max=<N> is required'
  \quit
\endif
\if :{?notes}
\else
  \echo 'ERROR: -v notes=<text> is required'
  \quit
\endif

WITH last_chain AS (
  SELECT this_hash
    FROM roadmap.governance_decision_log
   ORDER BY entry_id DESC
   LIMIT 1
),
prev AS (
  SELECT COALESCE((SELECT this_hash FROM last_chain), repeat('0', 64)) AS prev_hash
),
payload AS (
  SELECT jsonb_build_object(
           'event_kind',       :'event_kind',
           'operator',         :'operator',
           'rpo_seconds',      (:'rpo_seconds')::int,
           'rto_seconds',      (:'rto_seconds')::int,
           'decision_seconds', (:'decision_seconds')::int,
           'clock_skew_max',   (:'clock_skew_max')::int,
           'notes',            :'notes'
         ) AS body
)
INSERT INTO roadmap.governance_decision_log
  (entry_kind, actor_did, payload, prev_hash, this_hash, occurred_at)
SELECT
  :'event_kind',
  'did:hive:dr-operator',
  payload.body,
  prev.prev_hash,
  encode(digest(prev.prev_hash || payload.body::text, 'sha256'), 'hex'),
  now()
FROM prev, payload;

\echo 'DR drill/restore event recorded in governance.decision_log'
