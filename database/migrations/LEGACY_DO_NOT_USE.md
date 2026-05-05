# LEGACY — DO NOT USE

This directory is the **inactive** legacy migration runner path.

The **active** migration runner is `scripts/run-migration.ts`, which reads from `scripts/migrations/`.

## Why this directory exists

This directory was used by an earlier runner (`database/migrations/runner.ts`). It contains
migrations 039–051. Those migrations were applied to the production database via the legacy runner
at some point, but the runner itself is no longer invoked by the deployment pipeline.

**Do not place new migration files here.** They will silently never be applied.

All new migrations must go in `scripts/migrations/`.

## Root cause of P690

Migration `051-p251-poke-pong-liveness.sql` was placed here instead of `scripts/migrations/`.
Because the active runner never reads this directory, `roadmap.agent_lifecycle_log` and
`roadmap.liaison_poke_attempt` were never created in the production database, causing persistent
`42P01 relation does not exist` errors in `agenthive-gate-pipeline` and `agenthive-claude-agency`.

The fix (migration `065-p686-create-liaison-poke-attempt.sql`) was placed in `scripts/migrations/`.

## Sentinel date

This file was created on 2026-04-28. Any `.sql` file in this directory with a modification date
after this sentinel is a misrouted migration and must be moved to `scripts/migrations/`.
