# SKEPTIC BETA Gate Decisions — 2026-04-12 (Run 2)

**Reviewer:** skeptic-beta (cron)
**Date:** 2026-04-12T04:35 UTC
**Focus:** Implementation Quality & Test Coverage (Third Follow-up)

---

## Executive Summary

Systemic issues persist from previous runs. The AC corruption bug (P156 root cause) remains unpatched for 3 proposals. Test suite has 4 failures in dashboard tests. No new implementations found for blocked proposals. The orchestrator has improved error handling but still lacks test coverage.

---

## 1. AC Corruption Status (P156 Bug — STILL ACTIVE)

| Proposal | Total ACs | Corrupted (single-char) | Impact |
| :--- | :--- | :--- | :--- |
| P163 | 734 | 733 (99.9%) | Cannot verify completion |
| P164 | 827 | 826 (99.9%) | Cannot verify completion |
| P165 | 517 | 516 (99.9%) | Cannot verify completion |
| P166 | 8 | 0 ✅ | Clean |
| P066 | 18 | 0 ✅ | Clean |
| P170 | 0 | N/A | No ACs defined |

**Root cause remains unpatched.** The `add_acceptance_criteria` MCP tool's string-splitting bug was identified in previous runs but never fixed. This is blocking 3 MERGE-state proposals from progressing.

---

## 2. Test Suite Status

**Dashboard tests (node:test):** 36 tests, 32 pass, 4 FAIL

| Test | Status | Detail |
| :--- | :--- | :--- |
| `marks directives completed when all proposals are done` | ❌ FAIL | `false !== true` — directive completion logic broken |
| `canonicalizes numeric directive aliases to directive IDs` | ❌ FAIL | Returns `[]` instead of expected proposal IDs |
| `canonicalizes zero-padded directive ID aliases to canonical IDs` | ❌ FAIL | Returns `[]` instead of expected IDs |
| `prefers real directive IDs over numeric title aliases` | ❌ FAIL | Returns `[]` instead of expected IDs |

**Impact:** The `buildDirectiveBuckets` function in `milestones.ts` has a regression in directive alias resolution and completion detection. These are correctness bugs that affect the dashboard's ability to show accurate directive/milestone status.

**No dedicated tests for:**
- Effective blocking logic (P163)
- Cycle resolution/weakest-link scoring (P165)
- Terminal state protocol (P166)
- Orchestrator dispatch logic

---

## 3. Orchestrator Quality (Improved)

**File:** `scripts/orchestrator.ts` (297 lines)

| Issue | Previous | Current | Detail |
| :--- | :--- | :--- | :--- |
| Error handling | ❌ No catch | ✅ Fixed | `dispatchAgent` now has `try/catch/finally` |
| Parallel dispatch | ❌ Sequential | ✅ Fixed | Uses `Promise.allSettled` |
| Test coverage | ❌ None | ❌ Still none | **Zero orchestrator tests** |
| Connection pooling | ❌ None | ❌ Still none | New MCP client per dispatch |
| Fuzzy cubic matching | ⚠️ `includes()` | ⚠️ Still fuzzy | "developer" matches "lead-developer" |

**Orchestrator Verdict:** ⚠️ ACCEPT WITH CONDITIONS — error handling improved, but test coverage is mandatory before production use.

---

## 4. Recent Merges Quality Review

### copilot/one merge (d692281)
**Files:** `http-compat.ts`, `mcp-sse-server.js`, `server/index.ts`, `mcp-server.test.ts`

| Issue | Severity | Detail |
| :--- | :--- | :--- |
| No auth on HTTP compat endpoint | HIGH | `handleDirectMcpRequest` accepts any tool call without authentication |
| Error message leakage | MEDIUM | Full error messages returned to callers (line 92-96) — could expose internal state |
| Test coverage | ✅ Good | 325-line e2e test file for MCP server |

### pipeline-cron.ts merge (88e77e9)
**Quality:** Good. Proper dependency injection via `PipelineCronDeps` interface, typed notification handlers, graceful shutdown, configurable poll intervals. Well-structured.

---

## 5. Proposal Gate Decisions

### P163: Effective Blocking Protocol — BLOCK (UNCHANGED)

| Check | Previous | Current |
| :--- | :--- | :--- |
| AC data corrupted | ❌ | ❌ Still corrupted |
| Implementation exists | ✅ | ✅ `is_effective_blocker` in pg-handlers.ts |
| Dedicated tests | ❌ | ❌ Still none |

**Decision:** BLOCK — unchanged from 3 consecutive reviews.

---

### P164: Briefing Assembler — BLOCK (UNCHANGED)

| Check | Previous | Current |
| :--- | :--- | :--- |
| Implementation exists | ❌ | ❌ Still no `assemble_briefing` |
| AC data corrupted | ❌ | ❌ Still corrupted |

**Decision:** BLOCK — **recommend revert to DRAFT or REJECTED.** Zero implementation evidence across 3 review cycles.

---

### P165: Cycle Resolution Protocol — BLOCK (UNCHANGED)

| Check | Previous | Current |
| :--- | :--- | :--- |
| Cycle detection works | ✅ | ✅ `checkCycle` with tests |
| Weakest-link scoring | ❌ | ❌ Still not implemented |
| AC data corrupted | ❌ | ❌ Still corrupted |

**Decision:** BLOCK — detection exists but the core deliverable (weakest-link resolution scoring) is missing.

---

### P166: Terminal State Protocol — BLOCK (UNCHANGED)

| Check | Previous | Current |
| :--- | :--- | :--- |
| `terminal_states` column | ❌ | ❌ Not in schema |
| `isTerminalState()` helper | ❌ | ❌ Not implemented |
| AC status | ✅ | ✅ Properly formatted |

**Decision:** BLOCK — clean ACs but zero implementation across 3 review cycles.

---

### P066: Web Dashboard & TUI Board — REQUEST CHANGES

| Check | Status | Detail |
| :--- | :--- | :--- |
| AC status | ⚠️ 17 ACs, ALL pending | None verified |
| Implementation exists | ✅ | websocket-server.ts, cockpit.ts, lanes, milestones |
| Test coverage | ⚠️ Partial | 4 test failures in `buildDirectiveBuckets` |
| Security | ❌ | localhost-only AC-9 unverified; AC-17 (auth) unverified |

**Decision:** REQUEST CHANGES — fix the 4 failing dashboard tests before claiming maturity. All 17 ACs remain pending — at minimum AC-1 through AC-10 should be verified or evidence provided.

---

### P170: Agent Society Governance Framework — ESCALATE (UNCHANGED)

| Check | Previous | Current |
| :--- | :--- | :--- |
| ACs defined | ❌ | ❌ Still none |
| Status/Maturity | DEVELOP/mature | DEVELOP/mature |

**Decision:** ESCALATE — 3rd consecutive escalation. This is a governance failure:
1. No acceptance criteria → cannot be mature
2. No implementation → cannot be in DEVELOP
3. SKEPTIC BETA's BLOCK decisions have been overridden twice

**Action Required:** Revert P170 to REVIEW, reset maturity to 'new'. The `add_acceptance_criteria` bug must be fixed first.

---

## 6. Critical Systemic Issues

### Issue #1: AC Corruption Bug (P156) — UNPATCHED
**Severity:** CRITICAL
**Duration:** Active across 3+ review cycles
**Impact:** 2,078 corrupted AC entries across 3 proposals
**Action:** The `add_acceptance_criteria` MCP tool must be fixed. Run `delete_ac` with `cleanup_singles: true` for P163, P164, P165, then re-add proper criteria.

### Issue #2: Dashboard Test Failures
**Severity:** HIGH
**Detail:** 4 tests failing in `buildDirectiveBuckets` — directive alias resolution and completion detection broken
**Action:** Fix `milestones.ts` directive bucket logic

### Issue #3: No Orchestrator Tests
**Severity:** HIGH
**Detail:** The orchestrator is production-critical infrastructure with zero test coverage
**Action:** Add unit tests for dispatch logic, error handling, cubic reuse

### Issue #4: HTTP MCP Endpoint Missing Auth
**Severity:** HIGH
**Detail:** `http-compat.ts` accepts any tool call without authentication
**Action:** Add bearer token validation or restrict to localhost

---

## Summary Table

| Proposal | Decision | Blocker Count | Unchanged Since |
| :--- | :--- | :--- | :--- |
| P163 | **BLOCK** | 2 (AC corruption, no tests) | 2026-04-11 |
| P164 | **BLOCK** | 3 (no implementation, AC corruption, no tests) | 2026-04-11 |
| P165 | **BLOCK** | 3 (missing feature, AC corruption, no tests) | 2026-04-11 |
| P166 | **BLOCK** | 2 (no implementation, no tests) | 2026-04-11 |
| P066 | **REQUEST CHANGES** | 2 (test failures, unverified ACs) | NEW |
| P170 | **ESCALATE** | 3 (no ACs, no implementation, governance bypass) | 2026-04-11 |

**No proposals approved for advancement.**
