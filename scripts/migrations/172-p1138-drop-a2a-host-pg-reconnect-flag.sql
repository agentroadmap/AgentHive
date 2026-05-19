-- P1138: drop the A2A_HOST_PG_RECONNECT_MS runtime flag.
--
-- The flag was declared by migration 170-p1132-a2a-host-runtime-flags.sql but
-- never actually used by scripts/start-a2a-host.ts. P1138 D2 architecture
-- review (codex-architecture-audit + codex-d2-hotfix-audit) identified it as
-- a "declared-but-unused" gap. The P1138 hotfix landed Phase 1 = exit-on-pool-
-- error + systemd-restart; no in-process reconnect, so the flag has no consumer.
--
-- If a future Phase 2 (in-process reconnect with backoff) is shipped, that
-- proposal MUST re-seed this flag and wire it into the runtime loader. Until
-- then, removing it is the canonical "don't leave declared-but-unused" fix
-- (per P1138 AC-3 decision branch: chose option (a) DELETE).
--
-- IF EXISTS guards make this idempotent across fresh installs and replays.

BEGIN;

DELETE FROM core.runtime_flag
WHERE name = 'A2A_HOST_PG_RECONNECT_MS';

COMMIT;
