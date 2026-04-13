# SKEPTIC BETA Gate Decisions — 2026-04-13 (Run 3)

**Reviewer:** skeptic-beta (cron)
**Timestamp:** 2026-04-13T05:16 UTC
**Focus:** Implementation Quality & Test Coverage (9th follow-up)
**Context:** Two commits since Run 2: `b913829` (gate pipeline + agent dispatch + prop_create fixes) and `1572fb6` (pipeline-cron spawnAgent DI + test fixes). Also a full baseline/gap report added.

---

## Executive Summary

**Incremental code quality improvement, infrastructure catastrophe unchanged.** The latest commit (`1572fb6`) shows genuine quality work — proper dependency injection for testability, test assertions updated correctly. But this is polishing code that can't run: Postgres is down (9th cycle), systemd services absent, Node.js v24 crashes all integration tests. Unit tests pass; integration tests all fail (DB dependency). The 7 Node.js v24 incompatible files remain untouched despite the fix being 15 minutes of work.

### Quick Status

| Item | 9th Cycle Status | Change from 8th |
| :--- | :--- | :--- |
| Postgres running | ❌ DOWN | ❌ UNCHANGED (9 cycles) |
| DB schema applied | ❌ NONE | ❌ UNCHANGED |
| Systemd services | ❌ MISSING | ❌ UNCHANGED |
| Node.js v24 compat | 🚨 ESCALATE | ❌ UNCHANGED (9 cycles) |
| Orchestrator tests | ❌ BLOCK | ❌ UNCHANGED |
| proposal-storage-v2 | ❌ BLOCK | ❌ UNCHANGED |
| HTTP MCP auth | ⚠️ HIGH | ❌ UNCHANGED |
| Unit tests | ✅ PASS | ✅ UNCHANGED |
| Integration tests | ❌ ALL FAIL | ❌ UNCHANGED |
| pipeline-cron quality | ✅ IMPROVED | 🟢 NEW COMMIT |

---

## 1. 🟢 pipeline-cron.ts — IMPROVED (Latest Commit)

### Code Quality Assessment (commit 1572fb6)

| Check | Status | Detail |
| :--- | :--- | :--- |
| Dependency injection | ✅ NEW | `spawnAgentFn` added to `PipelineCronDeps` — enables test isolation |
| Default fallback | ✅ | `deps.spawnAgentFn ?? defaultSpawnAgent` — proper pattern |
| Nested metadata reading | ✅ NEW | `spawnMeta = isRecord(transition.metadata?.spawn)` — extracts spawn config |
| Error message format | ✅ | Simplified to `"Agent exit code N: message"` — cleaner |
| Try/catch coverage | ✅ | 4 try blocks covering 13 async functions |
| Error type narrowing | ✅ | `error instanceof Error ? error.message : String(error)` pattern used |

**Test verification:**
```
✔ PipelineCron (5/5 tests pass, 267ms)
  - listens on pipeline channels, schedules 30s poll, drains transitions
  - prefers explicit spawn metadata
  - requeues failed transitions when attempts remain
  - marks transitions failed when final attempt fails
  - drains pending transitions on notification
```

**Quality notes:**
- DI pattern is textbook correct — constructor accepts optional override, defaults to production implementation
- Test assertions properly updated for new error message format
- The metadata extraction (`spawn.worktree`, `spawn.task`, `spawn.model`) shows understanding of the data model

**Verdict:** ✅ **APPROVE** — Clean DI implementation with passing tests.

---

## 2. 🟢 Unit Tests — PASSING (26/26)

| Suite | Tests | Result | Duration |
| :--- | :--- | :--- | :--- |
| pipeline-cron.test.ts | 5 | ✅ All pass | 267ms |
| ac-tools-bugfix.test.ts | 21 | ✅ All pass | 393ms |
| milestone-filter.test.ts | 5 | ✅ All pass | 82ms |

**Total: 31 tests, 0 failures.**

---

## 3. 🔴 Integration Tests — ALL FAIL (Infrastructure Dependency)

Ran `acceptance-criteria.test.ts` — **every test fails** with timeout/connection errors because Postgres is down.

```
✖ should treat comma-separated text as single criterion (653ms)
✖ should create proposal with criteria using --acceptance-criteria (639ms)
✖ should add acceptance criteria to existing proposal (672ms)
✖ ... (all 14 tests fail)
```

**Root cause:** No Postgres = no DB connection = all integration tests fail. This is expected given infrastructure state, but means **no end-to-end verification of any feature is possible.**

**Verdict:** ❌ **BLOCK** — Cannot validate any integration behavior.

---

## 4. 🔴 Platform Infrastructure — BLOCK ALL (9th Cycle)

**Completely unchanged from all 8 previous reviews.**

| Check | Evidence |
| :--- | :--- |
| Postgres | `pg_isready` → "no response" |
| Systemd services | All 3 units `inactive` |
| DB schema | Connection refused — zero tables accessible |
| MCP endpoint | `curl` timeout after 5s — server not running |

**Verdict:** 🔴 **BLOCK ALL** — 9th cycle. Platform cannot function.

---

## 5. 🚨 Node.js v24 TypeScript Compatibility — ESCALATE (9th Cycle, 32+ hours)

**7 files still use parameter property syntax:**

```
src/core/infrastructure/knowledge-base.ts:108
src/apps/mcp-server/tools/knowledge/handlers.ts:17
src/apps/mcp-server/tools/memory/pg-handlers.ts:39
src/apps/mcp-server/tools/protocol/handlers.ts:30
src/apps/mcp-server/tools/cubic/pg-handlers.ts:24
src/apps/mcp-server/tools/teams/handlers.ts:30
src/apps/mcp-server/tools/pulse/pg-handlers.ts:55
```

**Confirmed crash this cycle:**
```
SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property
is not supported in strip-only mode
```

This blocks ALL integration tests from importing the MCP server. The fix is trivial (7 × 2 minutes = 15 minutes of mechanical refactoring):

```typescript
// BROKEN
constructor(private readonly server: McpServer) {}

// FIXED
server: McpServer;
constructor(server: McpServer) { this.server = server; }
```

**Verdict:** 🚨 **ESCALATE (9th cycle, 32+ hours)** — Governance failure. 15-minute fix deferred for 32+ hours.

---

## 6. ❌ proposal-storage-v2.ts — BLOCK (5th Cycle, UNCHANGED)

| Check | Status | Detail |
| :--- | :--- | :--- |
| Error handling | ❌ UNCHANGED | 3/25 async functions have try/catch (12%) |
| Test coverage | ❌ UNCHANGED | Zero test files reference this module |
| Type safety | ⚠️ MINOR | 1 `as any` cast (line 328) — low severity |
| Input validation | ❌ UNCHANGED | No parameter validation before SQL |

**Verdict:** ❌ **BLOCK** — 5th cycle unchanged. Core storage layer with 12% error handling coverage.

---

## 7. ❌ Orchestrator — BLOCK (UNCHANGED)

Zero test files for `scripts/orchestrator.ts`. No changes.

**Verdict:** ❌ **BLOCK**

---

## 8. ⚠️ HTTP MCP Authentication — HIGH (UNCHANGED)

`http-compat.ts` still has zero authentication. No changes.

**Verdict:** ⚠️ **HIGH**

---

## 9. 🟡 Migration 020 — REVIEWED (New)

`scripts/migrations/020-fix-gate-pipeline.sql` (162 lines):

| Check | Status | Detail |
| :--- | :--- | :--- |
| Transaction wrapping | ✅ | `BEGIN` / `COMMIT` present |
| Idempotent | ⚠️ PARTIAL | Uses `CREATE OR REPLACE FUNCTION` (good) but `INSERT INTO` without `ON CONFLICT` |
| Case handling | ✅ | Case-insensitive status matching via `LOWER()` |
| Stale timeout | ✅ | 30-min timeout for stuck transitions |
| Reference terms | ✅ | Populates `reference_terms` (was empty, blocked inserts) |

**Minor concern:** `INSERT INTO reference_terms` without `ON CONFLICT DO NOTHING` could fail on re-run if terms already exist. Should be `INSERT ... ON CONFLICT DO NOTHING`.

**Verdict:** ⚠️ **APPROVE with note** — Functional but not fully idempotent.

---

## Summary Table

| Item | Decision | Severity | Cycles Unchanged |
| :--- | :--- | :--- | :--- |
| pipeline-cron.ts (latest) | ✅ APPROVE | — | NEW |
| Unit tests (31 total) | ✅ APPROVE | — | — |
| Migration 020 | ⚠️ APPROVE w/note | LOW | NEW |
| Integration tests | ❌ BLOCK | HIGH | 9 |
| Postgres running | 🔴 BLOCK ALL | CRITICAL | 9 |
| DB schema | 🔴 BLOCK ALL | CRITICAL | 9 |
| Systemd services | 🔴 BLOCK ALL | CRITICAL | 9 |
| Node.js v24 | 🚨 ESCALATE | CRITICAL | 9 |
| Orchestrator | ❌ BLOCK | HIGH | 9 |
| proposal-storage-v2 | ❌ BLOCK | HIGH | 5 |
| HTTP MCP auth | ⚠️ HIGH | HIGH | 9 |

---

## What Changed This Cycle

**Positive:**
- Dependency injection for `spawnAgent` in `PipelineCron` — proper testability pattern
- Test assertions correctly updated for new error message format
- Nested metadata extraction (`spawn.worktree`, `spawn.task`) — data model understanding
- Baseline/gap report added (comprehensive system audit)
- Migration 020 fixes gate pipeline SQL issues

**Not addressed (9th cycle):**
- Platform infrastructure (Postgres, systemd, schema) — 9 cycles unchanged
- Node.js v24 fix (15 min of work, 32+ hours deferred, 7 files affected)
- Orchestrator test coverage — 9 cycles unchanged
- proposal-storage-v2 error handling — 5 cycles unchanged
- HTTP MCP auth — 9 cycles unchanged

---

## Critical Path (Updated)

```
1. Start Postgres                          [5 min]
2. Apply schema (roadmap-ddl-v3.sql)       [10 min]
3. Install systemd services                [15 min]
4. Fix Node.js v24 (7 files, 15 min)      [15 min]
5. Smoke-test proposal workflow            [10 min]
   ↓
Now meaningful QA is possible:
6. Run integration tests (verify fixes)    [10 min]
7. Write orchestrator tests                [2 hrs]
8. Add storage-v2 error handling           [1 hr]
9. Add HTTP MCP auth                       [1 hr]
10. Migration 020 idempotency fix          [5 min]
```

**Total time to functional platform: ~1 hour. Time spent not doing it: 32+ hours.**

---

*Report generated by SKEPTIC BETA — implementation quality review agent*
*Run 3, 2026-04-13T05:16 UTC*
