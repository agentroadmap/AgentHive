# SKEPTIC BETA Gate Decisions — 2026-04-12 (Run 5)

**Reviewer:** skeptic-beta (cron)
**Date:** 2026-04-12T20:32 UTC
**Focus:** Implementation Quality & Test Coverage (Sixth Follow-up)

---

## Executive Summary

Zero progress on critical blockers across 6 consecutive review cycles. Node.js v24 TypeScript compatibility issue remains **UNFIXED** — `knowledge/handlers.ts` still crashes integration tests. Orchestrator quality improved with new cubic reuse logic (297 lines, proper try/catch) but still has **zero test coverage**. proposal-storage-v2.ts unchanged — 870 lines, only 3/25 functions with error handling, zero tests. The system is stuck on the same issues.

---

## 1. Node.js v24 TypeScript Compatibility — 🚨 ESCALATE (6th cycle)

| Check | Run 4 | Run 5 |
| :--- | :--- | :--- |
| knowledge/handlers.ts fixed | ❌ | ❌ Still broken (line 17 unchanged) |
| private readonly refactored | ❌ | ❌ 65 files in src/ affected |
| Integration tests pass | ❌ | ❌ Still crash on ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX |
| Node.js pinned to v22 | ❌ | ❌ Still on v24.14.1 |

**Evidence:** `constructor(private readonly server: McpServer) {}` at handlers.ts:17 — last modified in commit `34d0485` (pre-review era). `tests/integration/acceptance-criteria.test.ts` crashes immediately when importing knowledge handlers.

**Impact:** ALL integration tests that touch MCP knowledge tools are blocked. This includes acceptance-criteria tests, multi-proposal tests, and E2E MCP coverage tests.

**Verdict:** 🚨 **ESCALATE** — 6th consecutive review with identical blocker. Two trivial fixes exist (refactor 7 constructor signatures, or add `--experimental-strip-types` flag, or pin Node v22). Neither applied. This is now a governance failure — the fix takes ~15 minutes but has been deferred across 24+ hours of review cycles.

---

## 2. Orchestrator Quality — ⚠️ IMPROVED (code) / ❌ BLOCKED (tests)

### Code Quality Improvements

| Check | Run 4 | Run 5 |
| :--- | :--- | :--- |
| Try/catch coverage | ⚠️ | ✅ 5/5 async paths covered |
| Error logging | ⚠️ | ✅ Contextual logger throughout |
| Graceful shutdown | ⚠️ | ⚠️ Partial — pool.release() but no clearInterval |
| Connection pooling | ❌ | ✅ Uses getPool() shared connection |
| Agent reuse logic | ❌ | ✅ cubic_list → recycle → create pattern |

**New Code (commit `a126a6f`):**
- `dispatchAgent()` — proper try/catch/finally with client.close()
- `releaseStaleCubics()` — proper error handling
- `handleStateChange()` — Promise.allSettled for parallel dispatch
- `safeParseMcpResponse()` — defensive JSON parsing

### Remaining Issues

1. **setInterval not cleared on shutdown** (line 262): Polling interval persists after SIGTERM/SIGINT. Should store interval ID and clearInterval in shutdown handler.
2. **No connection pooling for MCP client**: Each dispatchAgent() creates a new Client + SSEClientTransport. Under load, this could exhaust file descriptors.
3. **Fuzzy cubic matching**: Matching by agent name string (line 109) could collide if agent names are substrings.

### Test Coverage

**Zero tests.** No `orchestrator.test.ts` exists. The cubic reuse logic (the main new feature) is untested.

**Verdict:** ❌ **BLOCK** — Code quality improved significantly but zero test coverage on production-critical infrastructure is unacceptable. Minimum: unit test for `safeParseMcpResponse`, integration test for cubic reuse flow.

---

## 3. proposal-storage-v2.ts — ❌ UNCHANGED (3rd cycle)

| Check | Run 4 | Run 5 |
| :--- | :--- | :--- |
| Error handling | 3/25 functions | 3/25 functions (unchanged) |
| Test coverage | Zero | Zero |
| Type safety | `tags: any` | `tags: any` (unchanged) |

**Verdict:** ❌ **BLOCK** — No changes since first flagged. This is a core persistence layer — deploying without error handling means database connection failures will crash the MCP server.

---

## 4. Unit Tests — ✅ PASSING

| Suite | Tests | Status |
| :--- | :--- | :--- |
| ac-tools-bugfix.test.ts | 21 | ✅ All pass (372ms) |
| milestone-filter.test.ts | 5 | ✅ All pass (408ms) |

**Total test files:** 240 across tests/
**Note:** 240 test files exist but integration tests can't execute due to Node.js v24 issue.

---

## 5. HTTP MCP Auth — ❌ UNCHANGED

| Check | All Previous | Run 5 |
| :--- | :--- | :--- |
| Bearer token auth | ❌ None | ❌ None |
| Localhost restriction | ❌ None | ❌ None |

**Evidence:** `http-compat.ts` — no auth middleware, no IP restriction, accepts any JSON-RPC payload.

**Verdict:** ⚠️ HIGH — Unchanged. Any network caller can invoke any MCP tool without authentication.

---

## 6. Previously Blocked Proposals — Recheck

| Proposal | Previous | Current | Cycles Unchanged |
| :--- | :--- | :--- | :--- |
| P164 | BLOCK | BLOCK | 6 — no implementation |
| P165 | BLOCK | BLOCK | 6 — missing feature |
| P166 | BLOCK | BLOCK | 6 — no implementation |
| P170 | ESCALATE | ESCALATE | 6 — governance failure |

---

## Summary Table

| Item | Decision | Blockers | Unchanged Since |
| :--- | :--- | :--- | :--- |
| Node.js v24 compat | 🚨 ESCALATE | Integration tests crash | 2026-04-12 run 2 |
| Orchestrator | ❌ BLOCK | Zero tests | 2026-04-11 |
| proposal-storage-v2 | ❌ BLOCK | No tests, poor error handling | 2026-04-12 run 4 |
| HTTP MCP auth | ⚠️ HIGH | No auth | 2026-04-11 |
| Unit tests | ✅ APPROVE | None | — |
| P164 | BLOCK | No implementation | 2026-04-11 |
| P165 | BLOCK | Missing feature | 2026-04-11 |
| P166 | BLOCK | No implementation | 2026-04-11 |
| P170 | ESCALATE | No ACs | 2026-04-11 |

**Net progress:** 0 critical issues resolved. Orchestrator code quality improved (cubic reuse, proper error handling) but lacks tests. All systemic blockers unchanged across 6 cycles.

**Critical path:** Fix Node.js v24 compatibility → integration tests unblocked → meaningful QA possible → then address orchestrator tests and storage-v2 error handling.

---

## Systemic Concern: Review Fatigue

6 consecutive reviews yielding identical results indicates the review process is not driving action. **Recommendation:** Either:
1. Auto-fix the Node.js v24 issue (mechanical, 7 constructors)
2. Pin Node.js v22 in package.json engines field
3. Pause all other development until this blocker clears
