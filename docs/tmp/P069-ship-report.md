# P069 Ship Report — Roadmap board hangs indefinitely on "Loading roadmap data from Postgres..."

**Status:** COMPLETE
**Type:** issue
**Created:** 2026-04-07
**Ship Date:** 2026-04-21
**Verified By:** worker-8848 (documenter)

---

## Problem

Running `roadmap board` (scripts/roadmap-board.ts) from a worktree directory (e.g. `/data/code/worktree/claude-one/`) caused the terminal to hang indefinitely on:

```
┌─ ⠋ Loading ──────────────────────────────────────────────┐
│  Loading proposals                                       │
│  Loading roadmap data...                                 │
│  Loading roadmap data from Postgres...                   │
└──────────────────────────────────────────────────────────┘
```

No error shown. Process had to be killed manually (Ctrl+C).

## Root Cause

pool.ts searched two files for PGPASSWORD in order:
1. `{cwd}/.env` — doesn't exist in worktrees
2. `~/.agenthive.env` — not populated for worktree contexts

Worktrees only have `.env.agent`. With PGPASSWORD never loaded, the Pool was created with `password=undefined`, and the Postgres connection silently blocked forever — no timeout configured, no error surfaced to the TUI.

The MCP server worked fine because it runs from `/data/code/AgentHive/` which has a valid `.env` file with PGPASSWORD.

## Fix — Two Commits

### Commit e1a7114 (2026-04-07) — Pool .env.agent search
Added `.env.agent` to the PGPASSWORD candidate list in pool.ts loadPGPassword():
```ts
const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), ".env.agent"),    // NEW
    join(process.env.HOME || "", ".agenthive.env"),
];
```
This fixed the immediate password loading issue. Related proposal: P070.

### Commit 2f70f8c (2026-04-15) — Timeout safeguards + board source resolution
Three defensive improvements:
1. **Connection timeout** — `connectionTimeoutMillis: 5000` (configurable via `PG_CONNECTION_TIMEOUT_MS`)
2. **Query/statement timeout** — `query_timeout: 30000`, `statement_timeout: 30000` (configurable)
3. **`allowExitOnIdle: true`** — prevents Node process from hanging on idle pool
4. **`DEBUG_PG` env var** — logs pool connection details to stderr when set
5. **board-source.ts** — explicit `BoardDataSource` resolution ("auto" | "file" | "postgres") with validation

## Acceptance Criteria

| AC | Description | Status |
|----|-------------|--------|
| AC-1 | Board no longer hangs in worktree context | **PASS** — PGPASSWORD loaded from .env.agent |
| AC-2 | Connection failures surface as errors, not silent hangs | **PASS** — 5s connection timeout + 30s query/statement timeout |
| AC-3 | Board works from both main repo and worktrees | **PASS** — candidate list covers all three paths |

**3/3 ACs PASS**

## Related Work

- **P070** — Sibling issue: "pool.ts ignores .env.agent — board hangs silently in worktree context" (COMPLETE)
- **P071** — Same deployment: schema grants missing for `roadmap` schema in migrations 007/008 (COMPLETE)
- **P307** — Follow-up: pool.ts sentinel loading fix + port NaN fallback

## Files Changed

| File | Change |
|------|--------|
| `src/infra/postgres/pool.ts` | Added `.env.agent` to candidate list; added connection/query/statement timeouts; DEBUG_PG logging |
| `src/apps/board-source.ts` | NEW — BoardDataSource resolution with auto/file/postgres |
| `src/apps/cli.ts` | Refactored to use board-source.ts for data source selection |
| `src/core/orchestration/agent-spawner.ts` | 48 lines added (board data source integration) |
| `tests/unit/board-source.test.ts` | NEW — 36 lines, tests for resolveBoardDataSource() |

## Git History

- `e1a7114` — fix: four critical runtime bugs (P069/P070 pool .env.agent fix)
- `2f70f8c` — Fix Postgres board TUI loading hang (timeouts + board-source)
- `0b80d5f` — fix(pool.ts): fix B7 sentinel loading, B8 truncated variable
- `2bcf273` — fix(pool): PGPASSWORD sentinel assignment + port NaN fallback (P307)

## Lessons Learned

1. **Silent connection failures are worse than errors** — no timeout on the pool meant a missing password caused an infinite hang instead of a clear "authentication failed" message. Every Postgres pool MUST have connect_timeout.

2. **Worktree env file strategy** — CLI tools that work from worktrees must search `.env.agent` alongside `.env`. The candidate list pattern (cwd/.env → cwd/.env.agent → ~/.agenthive.env) is the correct fallback chain.

3. **TUI error swallowing** — the board's loading spinner had no error boundary. Any query failure in the loading state should surface as a visible error, not an infinite spinner. Consider wrapping all DB calls in try/catch with TUI error display.
