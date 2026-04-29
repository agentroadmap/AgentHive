# P676 — `roadmap_app` write-surface audit (2026-04-29)

**Source:** `pg_stat_user_tables` snapshot taken 2026-04-29 02:30 UTC against `agenthive` DB.
**Filter:** all tables with `n_tup_ins + n_tup_upd + n_tup_del > 0` in the 8 active schemas.
**Total tables with confirmed write activity:** 96.

The migration `067-p676-pg-role-decomposition.sql` issues a blanket
`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA <S> TO roadmap_app`
for every schema, so every table below is covered automatically. This document
exists for incident debugging — when a service hits `42501 permission denied`,
look here first to confirm the table is in the expected write set.

## Top write-volume tables (smoke-test priority)

These are the tables a `roadmap_app` boundary smoke-test should exercise first
after any role-grant change:

| Schema | Table | Total writes |
|---|---|---:|
| roadmap_workforce | squad_dispatch | 201,665 |
| roadmap_proposal | proposal_lease | 127,924 |
| roadmap | cubics | 56,578 |
| roadmap | audit_log | 38,361 |
| roadmap_workforce | agent_registry | 38,132 |
| roadmap_workforce | agent_runs | 33,736 |
| roadmap_proposal | proposal_event | 32,108 |
| roadmap_workforce | agent_workload | 28,693 |
| roadmap | escalation_log | 24,400 |
| roadmap_proposal | proposal_acceptance_criteria | 21,449 |

## Coverage by schema

| Schema | Tables in schema | Tables with write activity |
|---|---:|---:|
| roadmap | 90 | 56 |
| roadmap_proposal | 25 | 18 |
| roadmap_workforce | 17 | 11 |
| roadmap_efficiency | 10 | 5 |
| roadmap_control | 1 | 1 |
| roadmap_messaging | 2 | 1 |
| metrics | 1 | 0 |
| token_cache | 1 | 0 |

`metrics` and `token_cache` show no historical write activity but are granted
write privileges anyway for forward-compatibility (services that haven't yet
exercised the table will still need to insert).

## Notable write surfaces by service responsibility

- **squad_dispatch / agent_runs / agent_workload / agent_registry** — written
  by orchestrator + claude-agency + copilot-agency.
- **proposal_lease / proposal_event / proposal_acceptance_criteria** —
  written by mcp + gate-pipeline.
- **cubics / cubic_state** — written by orchestrator (cubic state machine).
- **audit_log / escalation_log / proposal_lifecycle_event** — append-only
  audit trail; written by every service.
- **notification_queue / notification_route** — written by notification-router
  + any service that emits notifications.
- **schema_drift_seen** — written by the schema-drift monitor (P675 timer).

## Verification queries

```sql
-- After migration, confirm app role can see all tables in all 8 schemas:
SET ROLE roadmap_app;
SELECT schemaname, count(*) AS visible
FROM pg_tables
WHERE schemaname IN ('roadmap','roadmap_proposal','roadmap_workforce',
                      'roadmap_efficiency','roadmap_control','roadmap_messaging',
                      'metrics','token_cache')
  AND has_table_privilege(current_user, schemaname||'.'||tablename, 'INSERT')
GROUP BY schemaname
ORDER BY schemaname;
RESET ROLE;
-- Expected: schema → table-count match against the snapshot above.
```
