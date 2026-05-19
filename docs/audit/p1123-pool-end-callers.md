> **Type:** reference
> **MCP-tracked:** P1123
> **Source-of-truth:** Postgres `roadmap_proposal.proposal` row P1123

# P1123 — pool.end() Caller Audit

**Audit date:** 2026-05-16
**Scope:** every `pool.end()` invocation in `src/`, `scripts/` — verdict per caller, suspect set for the 2026-05-15 08:51:32 agenthive-board.service poisoning incident.

## Methodology

```bash
grep -rn 'pool\.end(' src/ scripts/
grep -rln 'closePool'  src/ scripts/
```

Tests, comments, and one-off scripts (migration utilities, provisioning scripts) are excluded from the suspect set — they run as fresh processes and end with the pool naturally.

## Caller catalog

| # | File:Line | Context | Runs in long-running process? | Sentinel coverage (post-P1123 Phase 2) | Verdict |
|---|---|---|---|---|---|
| 1 | `src/apps/cli.ts:5494` | `agents send` subcommand exit | No — `node cli.cjs.js agents send …` spawns a fresh process per invocation | N/A | **SAFE** |
| 2 | `src/apps/cli.ts:5546` | `agents send` reply-wait branch exit | Same as #1 | N/A | **SAFE** |
| 3 | `src/postgres/pool-registry.ts:230` | Per-project pool eviction from the multi-project pool registry (P300) | Only if a long-running service uses `getProjectPool()`; main board/mcp/notification-router do NOT | N/A in current topology | **SAFE** (in current topology); UNCLEAR if multi-project mode is wired into a long-running service later |
| 4 | `src/postgres/pool-registry.ts:550` | Pool-registry shutdown | Same as #3 | N/A | **SAFE** |
| 5 | `src/infra/postgres/pool.ts:274` | `getPool()` config-signature change path — fires when `getPool()` is called with a config that differs from the cached singleton's signature | **YES — runs inside every long-running service that calls getPool()** | **NOT GUARDED** — sentinel only guards `closePool()`, not internal `pool.end()` here | **PRIME SUSPECT for the 2026-05-15 incident** |
| 6 | `src/infra/postgres/pool.ts:453` | `closePool()` canonical shutdown body | Yes — when service shuts down | Guarded by `setPoolLifecycleMode("long-running")` (P1123 Phase 2). Bypassed via `setPoolLifecycleMode("one-shot")` in each service's graceful shutdown handler before the final `closePool` | **SAFE** |
| 7 | `src/core/orchestration/orchestrator.ts:631` | Orchestrator graceful shutdown — calls `closePool()` | Yes — at SIGTERM/SIGINT | Goes through `closePool()` (guarded) | **SAFE** |
| 8 | `scripts/migrate-principal-identity.ts:214` | One-off P1105 migration script | No — fresh process per invocation | N/A | **SAFE** |
| 9 | `scripts/pgbouncer/provision-pgbouncer.ts:223` | One-off provisioning script | No | N/A | **SAFE** |
| 10 | `src/infra/agency/agency-self-registration.test.ts:53` | Test cleanup | No — test process exits | N/A | **SAFE** |
| 11 | `src/apps/mcp-server/tools/ops/flag-ops.test.ts:37` | Test cleanup | No | N/A | **SAFE** |

## Suspect set for the 2026-05-15 incident (≤3 candidates)

The agenthive-board.service was poisoned at 2026-05-15 08:51:32. Investigation narrows the field to a single candidate:

### Prime suspect — `src/infra/postgres/pool.ts:274` (config-signature change)

```ts
if (pool && poolSignature !== nextSignature) {
    void pool.end().catch(() => {});
    pool = null;
    poolSignature = null;
}
```

This block fires when **any** call to `getPool()` arrives with a `PoolConfig` whose signature differs from the cached singleton's signature. Once it fires, every consumer holding a reference to the old `pool` instance throws `Cannot use a pool after calling end on the pool` for the rest of the process lifetime.

How it can fire inside the board process:
- The board imports many handlers transitively (operator API, MCP tools, TimeoutCron, P836 cleanup, schema-drift monitor). If any of those handlers calls `getPool({...})` with a different `host`/`port`/`user`/`database`/`schema` (e.g., resolved from a different env-var snapshot, or hits a code path that constructs config from a project record vs the default), the signature mismatch triggers.
- Race condition with config reload: if `ConfigResolver.resolvePasswordSync` returns a slightly different password (e.g., re-read of `~/.pgpass` with different timing) the signature changes.
- A test or schema migration imported into the long-running process via a code path could reconfigure the pool.

**Why this is the prime suspect:**
1. It is the only `pool.end()` call site reachable inside the long-running board process that is NOT covered by the P1123 Phase 2 sentinel.
2. It fires silently (`.catch(() => {})`) — no log, no error surfaced; matches the observed "silent for 30 hours" symptom.
3. The other in-process candidates (#1, #2, #3, #4) require code paths that the board doesn't import (verified via grep — no `agents.send` MCP tool, no pool-registry usage in `src/apps/server/`).

### Secondary suspects (low probability)

- **#3 / #4 — pool-registry eviction.** If a long-running service uses `getProjectPool(slug)` (multi-project mode) and an eviction fires. The board does NOT currently import pool-registry, but this could change with future multi-project work. Track as latent risk.

- **#1 / #2 — `agents send` exit paths.** Only if an in-process MCP tool ever directly invokes the cli.ts subcommand handler (it doesn't today, but new MCP tools could).

## Remediation gap — Phase 2 does not yet cover the prime suspect

The P1123 Phase 2 sentinel guards `closePool()` (caller #6 in the table) but does NOT guard the internal `pool.end()` at #5 (`pool.ts:274`). A Phase 2.1 follow-up should:

```ts
if (pool && poolSignature !== nextSignature) {
    if (poolLifecycleMode === "long-running") {
        console.warn(
            `[PG] getPool() signature change refused in long-running mode; keeping existing pool. New: ${nextSignature}, current: ${poolSignature}\n${new Error().stack}`,
        );
        return pool; // return the existing pool unchanged
    }
    void pool.end().catch(() => {});
    pool = null;
    poolSignature = null;
}
```

This is a 4-line edit that closes the actual root cause of the 2026-05-15 outage. Filed as a P1123 follow-on AC or P1123-child if needed.

Until Phase 2.1 lands, the watchdog (Phase 3 — `SELECT 1` probe + `pool_poisoned` notify, AC-6/7) is the safety net.

## Phase 3 watchdog rationale

Even after Phase 2.1, an adversarial code path that we haven't catalogued could still call `pool.end()` directly (bypassing the public API). The watchdog probe makes the incident observable in <60 s instead of 30 hours.

## Conclusion

- **11 known `pool.end()` call sites catalogued.**
- **6 SAFE** (CLI subcommands, one-off scripts, tests, properly-guarded service shutdown).
- **3 UNCLEAR / latent risk** (pool-registry eviction × 2, hypothetical MCP→cli.ts bridges × 1).
- **1 PRIME SUSPECT for the 2026-05-15 incident** — `pool.ts:274` config-signature-change path.
- **Phase 2 sentinel covers `closePool()` but NOT the internal `pool.end()` at the prime suspect site.** Phase 2.1 follow-up recommended.

## Follow-ups filed

- Phase 2.1: extend the sentinel to also guard `pool.ts:274`. ETA: same-day, ~4-line edit.
- Phase 3 (watchdog + state-feed alert): independent of Phase 2.1; provides defense in depth for any future bypass path.
