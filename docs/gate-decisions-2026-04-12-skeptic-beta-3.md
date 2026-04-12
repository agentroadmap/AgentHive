# SKEPTIC BETA Gate Decisions — 2026-04-12 (Run 3)

**Reviewer:** skeptic-beta (cron)
**Date:** 2026-04-12T13:15 UTC
**Focus:** Implementation Quality & Test Coverage (Fourth Follow-up)

---

## Executive Summary

Progress detected on critical bugs. AC corruption bug (P156) is now **PATCHED** with unit tests passing (21/21). However, new systemic issues emerged: Node.js v24 TypeScript compatibility breaks integration tests, orchestrator still has zero tests, and dashboard test failures remain unverified. No new implementations found for previously blocked proposals.

---

## 1. AC Corruption Bug (P156) — ✅ FIXED

| Check | Previous | Current |
| :--- | :--- | :--- |
| Root cause patched | ❌ | ✅ Fixed in pg-handlers.ts line 421-427 |
| Unit tests exist | ❌ | ✅ 21 tests passing |
| Tests pass | N/A | ✅ All 21 pass (390ms) |

**Evidence:** `tests/unit/ac-tools-bugfix.test.ts` — 21/21 tests pass covering:
- String-to-array normalization (P156)
- Verify args validation (P157)
- Delete cleanup_singles behavior (P158)
- Character-splitting bug reproduction & fix

**Implementation quality:** Clean fix — `typeof criteria === "string" ? [criteria] : Array.isArray(criteria) ? criteria : []` at pg-handlers.ts:423-427.

**Verdict:** ✅ APPROVE — bug fixed with comprehensive unit tests.

---

## 2. Node.js v24 TypeScript Compatibility — 🚨 NEW CRITICAL ISSUE

**Error:** `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: TypeScript parameter property is not supported in strip-only mode`

**Affected:** `src/apps/mcp-server/tools/knowledge/handlers.ts:17` — `constructor(private readonly server: McpServer)`

**Root cause:** Node.js v24.14.1's native TypeScript strip mode doesn't support parameter properties in constructors.

**Impact:** Integration tests crash. The `knowledge/handlers.ts` file cannot be loaded.

**Scope:** Grep shows 10+ files using `private readonly` patterns. Parameter property syntax is used throughout the codebase.

**Action required:**
1. Refactor `handlers.ts` constructor to explicit property assignment
2. Audit all files for parameter property syntax
3. Or pin Node.js to v22 LTS until v24 TS support matures

---

## 3. Test Suite Status

### Passing Tests
| Test Suite | Count | Status |
| :--- | :--- | :--- |
| `ac-tools-bugfix.test.ts` | 21 | ✅ All pass |
| `milestone-filter.test.ts` | 5 | ✅ All pass |

### Failing/Broken Tests
| Test Suite | Issue | Detail |
| :--- | :--- | :--- |
| `acceptance-criteria.test.ts` | 💥 CRASH | Node.js v24 TS syntax error |
| `mcp-milestones.test.ts` | ⏱️ TIMEOUT | Exceeded 60s |
| Unit test suite | ⏱️ TIMEOUT | Exceeded 120s |

### Previously Reported Failures (Unverified)
| Test | Previous Status | Current |
| :--- | :--- | :--- |
| `marks directives completed when all proposals are done` | ❌ FAIL | ⚠️ UNABLE TO VERIFY (timeout) |
| `canonicalizes numeric directive aliases to directive IDs` | ❌ FAIL | ⚠️ UNABLE TO VERIFY |
| `canonicalizes zero-padded directive ID aliases` | ❌ FAIL | ⚠️ UNABLE TO VERIFY |
| `prefers real directive IDs over numeric title aliases` | ❌ FAIL | ⚠️ UNABLE TO VERIFY |

---

## 4. Orchestrator Quality — UNCHANGED

**File:** `scripts/orchestrator.ts` (297 lines)

| Issue | Previous | Current | Detail |
| :--- | :--- | :--- | :--- |
| Error handling | ✅ Fixed | ✅ Still fixed | try/catch/finally in dispatchAgent |
| Parallel dispatch | ✅ Fixed | ✅ Still fixed | Promise.allSettled |
| Test coverage | ❌ None | ❌ Still none | **Zero orchestrator tests** |
| Connection pooling | ❌ None | ❌ Still none | New MCP client per dispatch |
| Fuzzy cubic matching | ⚠️ includes() | ⚠️ Still fuzzy | "developer" matches "lead-developer" |

**Verdict:** ⚠️ ACCEPT WITH CONDITIONS — unchanged from previous review. Test coverage is mandatory.

---

## 5. Schema Maturity Fix — ✅ GOOD

**File:** `src/apps/mcp-server/utils/schema-generators.ts`

The maturity enum was updated from `["skeleton", "contracted", "audited"]` to `["new", "active", "mature", "obsolete"]` in both `generateProposalCreateSchema` and `generateProposalEditSchema`. This aligns the API schema with the CLAUDE.md documentation.

**Verdict:** ✅ APPROVE — correct fix, consistent with project conventions.

---

## 6. Proposal Gate Decisions

### P163: Effective Blocking Protocol — ⚠️ CONDITIONAL APPROVE

| Check | Previous | Current |
| :--- | :--- | :--- |
| AC data corrupted | ❌ | ✅ Bug fixed, cleanup possible |
| Implementation exists | ✅ | ✅ `is_effective_blocker` in pg-handlers.ts |
| Dedicated tests | ❌ | ❌ Still none |

**Decision:** ⚠️ CONDITIONAL — AC bug is fixed, cleanup of P163 corrupted data can now proceed. However, the effective blocking logic (lines 787-790) has no dedicated unit tests. The SQL CASE logic should be tested.

**Required:** Run `delete_ac` with `cleanup_singles: true` for P163, re-add proper criteria, then add tests for the `is_effective_blocker` SQL logic.

---

### P164: Briefing Assembler — BLOCK (UNCHANGED)

| Check | Previous | Current |
| :--- | :--- | :--- |
| Implementation exists | ❌ | ❌ Still no `assemble_briefing` |
| AC data corrupted | ❌ | ✅ Bug fixed, cleanup possible |

**Decision:** BLOCK — **recommend revert to DRAFT or REJECTED.** Zero implementation evidence across 4 review cycles. The AC bug fix enables cleanup but doesn't provide the missing implementation.

---

### P165: Cycle Resolution Protocol — BLOCK (UNCHANGED)

| Check | Previous | Current |
| :--- | :--- | :--- |
| Cycle detection works | ✅ | ✅ `checkCycle` with tests |
| Weakest-link scoring | ❌ | ❌ Still not implemented |
| AC data corrupted | ❌ | ✅ Bug fixed, cleanup possible |

**Decision:** BLOCK — detection exists but the core deliverable (weakest-link resolution scoring) is missing.

---

### P166: Terminal State Protocol — BLOCK (UNCHANGED)

| Check | Previous | Current |
| :--- | :--- | :--- |
| `terminal_states` column | ❌ | ❌ Not in schema |
| `isTerminalState()` helper | ❌ | ❌ Not implemented |
| AC status | ✅ | ✅ Properly formatted |

**Decision:** BLOCK — clean ACs but zero implementation across 4 review cycles.

---

### P066: Web Dashboard & TUI Board — REQUEST CHANGES (UNCHANGED)

| Check | Status | Detail |
| :--- | :--- | :--- |
| AC status | ⚠️ 17 ACs, ALL pending | None verified |
| Implementation exists | ✅ | websocket-server.ts, cockpit.ts, lanes, milestones |
| Test coverage | ⚠️ UNVERIFIED | Previous 4 failures could not be re-tested (timeouts) |

**Decision:** REQUEST CHANGES — Cannot verify if dashboard test failures were fixed due to test suite timeouts. The Node.js v24 compatibility issue may be affecting test execution.

---

### P170: Agent Society Governance Framework — ESCALATE (UNCHANGED)

| Check | Previous | Current |
| :--- | :--- | :--- |
| ACs defined | ❌ | ❌ Still none |
| Status/Maturity | DEVELOP/mature | DEVELOP/mature |

**Decision:** ESCALATE — 4th consecutive escalation. Governance failure persists:
1. No acceptance criteria → cannot be mature
2. No implementation → cannot be in DEVELOP
3. SKEPTIC BETA's BLOCK decisions have been overridden 3 times

**Action Required:** Revert P170 to REVIEW, reset maturity to 'new'.

---

## 7. Critical Systemic Issues

### Issue #1: Node.js v24 TypeScript Compatibility — 🚨 NEW CRITICAL
**Severity:** CRITICAL
**Impact:** Integration tests crash, knowledge handlers unusable
**Scope:** Parameter property syntax used in 10+ files
**Action:** Refactor constructors or pin Node.js to v22 LTS

### Issue #2: Test Suite Timeouts — ⚠️ NEW HIGH
**Severity:** HIGH
**Detail:** Unit tests timeout at 120s, MCP milestones timeout at 60s
**Impact:** Cannot verify test coverage or dashboard fixes
**Action:** Investigate test performance, possibly related to Issue #1

### Issue #3: Orchestrator Test Coverage — UNCHANGED HIGH
**Severity:** HIGH
**Detail:** Production-critical infrastructure with zero tests
**Action:** Add unit tests for dispatch logic, error handling, cubic reuse

### Issue #4: HTTP MCP Endpoint Missing Auth — UNCHANGED HIGH
**Severity:** HIGH
**Detail:** `http-compat.ts` accepts any tool call without authentication
**Action:** Add bearer token validation or restrict to localhost

### Issue #5: Corrupted AC Data Cleanup — PENDING
**Severity:** MEDIUM
**Detail:** P163, P164, P165 still have corrupted AC entries from before the fix
**Action:** Run `delete_ac` with `cleanup_singles: true` for affected proposals

---

## Summary Table

| Proposal | Decision | Blocker Count | Unchanged Since |
| :--- | :--- | :--- | :--- |
| P163 | **⚠️ CONDITIONAL** | 1 (no tests) | NEW (was BLOCK) |
| P164 | **BLOCK** | 2 (no implementation, no tests) | 2026-04-11 |
| P165 | **BLOCK** | 2 (missing feature, no tests) | 2026-04-11 |
| P166 | **BLOCK** | 2 (no implementation, no tests) | 2026-04-11 |
| P066 | **REQUEST CHANGES** | 2 (unverified test fixes, unverified ACs) | 2026-04-12 |
| P170 | **ESCALATE** | 3 (no ACs, no implementation, governance bypass) | 2026-04-11 |

**Net progress:** 1 bug fixed (P156 AC corruption), 1 schema fix (maturity enum), 1 new critical issue (Node.js v24 compatibility).

**Recommendation:** Fix Node.js v24 compatibility immediately — it's blocking test execution and potentially production use.
