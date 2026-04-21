# SKEPTIC BETA Gate Decisions — 2026-04-12 (Run 4)

**Reviewer:** skeptic-beta (cron)
**Date:** 2026-04-12T16:32 UTC
**Focus:** Implementation Quality & Test Coverage (Fifth Follow-up)

---

## Executive Summary

No progress on critical blockers. Node.js v24 TypeScript compatibility issue **STILL UNFIXED** across 5 consecutive review cycles — `knowledge/handlers.ts` crashes integration tests. A major new implementation appeared (proposal-storage-v2.ts, 425 lines) with **zero test coverage** and poor error handling (21/25 functions lack try/catch). MCP tools coverage test newly failing. Orchestrator still has zero tests after all reviews.

---

## 1. Node.js v24 TypeScript Compatibility — 🚨 ESCALATE (5th cycle)

| Check | Run 3 | Run 4 |
| :--- | :--- | :--- |
| knowledge/handlers.ts fixed | ❌ | ❌ Still broken |
| private readonly refactored | ❌ | ❌ 65 files affected |
| Integration tests pass | ❌ | ❌ Still crash |
| Node.js pinned to v22 | ❌ | ❌ Still on v24.14.1 |

**Evidence:** `constructor(private readonly server: McpServer) {}` at handlers.ts:17 unchanged. `tests/integration/acceptance-criteria.test.ts` crashes with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.

**Verdict:** 🚨 **ESCALATE** — 5th consecutive review with same blocker. This is blocking ALL integration test execution and potentially production MCP server operation. Two trivial fix options exist (refactor constructor or pin Node v22) but neither has been applied.

---

## 2. proposal-storage-v2.ts — 🚨 NEW QUALITY CONCERNS

**File:** `src/infra/postgres/proposal-storage-v2.ts` (23KB, 25 exported functions)
**Commit:** 882d2cc

### Error Handling Analysis

| Function | Error Handling |
| :--- | :--- |
| `listProposals` | ❌ None |
| `getProposal` | ❌ None |
| `createProposal` | ❌ None |
| `updateProposal` | ❌ None |
| `transitionProposal` | ✅ try/catch + throw |
| `setMaturity` | ❌ None (has throw but no catch) |
| `claimLease` | ✅ try/catch |
| `releaseLease` | ❌ None |
| `renewLease` | ❌ None |
| `replaceDependencies` | ✅ try/catch + transaction |
| `replaceAcceptanceCriteria` | ✅ try/catch + transaction |
| `deleteProposal` | ❌ None |
| 13 others | ❌ None |

**Result:** 21/25 functions have **NO error handling**. Database connection failures, constraint violations, and network errors will propagate as unhandled promise rejections.

### Type Safety

- 1 `as any` cast (minor, in jsonb field check)
- `tags: any | null` — loose typing on jsonb columns

### Test Coverage

**Zero dedicated tests.** No `proposal-storage-v2.test.ts` found anywhere in the codebase.

### Verdict: ⚠️ **REQUEST CHANGES**

1. Add try/catch with contextual error logging to all database functions
2. Add unit tests (mock the pool, test error paths)
3. Tighten `tags` type from `any` to `unknown` or specific interface

---

## 3. MCP Tools Coverage Test — 🚨 NEW FAILURE

**File:** `tests/e2e/mcp-tools-coverage.test.ts`

| Failure | Detail |
| :--- | :--- |
| `team_create` tool not found | Tool registered but schema mismatch |
| Heartbeat validation | Required fields changed: `agentId`, `load`, `claimsCount` expected; `name` sent |

**Verdict:** ❌ **BLOCK** — Test expectations are out of sync with current tool schemas. Either tests need updating or tool registrations regressed.

---

## 4. Unit Tests — ✅ PASSING

| Suite | Tests | Status |
| :--- | :--- | :--- |
| `ac-tools-bugfix.test.ts` | 21 | ✅ All pass |
| `milestone-filter.test.ts` | 5 | ✅ All pass |
| Other unit tests (sampled) | 5 | ✅ All pass |

**Total unit test files:** 38 in `tests/unit/`
**All sampled unit tests:** 26/26 pass (370ms average)

---

## 5. Orchestrator Quality — ❌ ESCALATE (Unchanged)

| Check | Run 3 | Run 4 |
| :--- | :--- | :--- |
| Test coverage | ❌ None | ❌ None |
| Connection pooling | ❌ None | ❌ None |
| Fuzzy cubic matching | ⚠️ | ⚠️ Unchanged |

**Verdict:** 🚨 **ESCALATE** — Production-critical infrastructure with zero test coverage across 5 review cycles. Recent commit `a126a6f` added cubic reuse logic with no tests.

---

## 6. HTTP MCP Auth — ❌ UNCHANGED

| Check | All Previous | Run 4 |
| :--- | :--- | :--- |
| Bearer token auth | ❌ None | ❌ None |
| Localhost restriction | ❌ None | ❌ None |

**Verdict:** ⚠️ HIGH — Any caller can invoke any MCP tool without authentication.

---

## 7. Previously Blocked Proposals — Recheck

| Proposal | Previous | Current | Status |
| :--- | :--- | :--- | :--- |
| P163 | CONDITIONAL | Not rechecked | AC cleanup needed |
| P164 | BLOCK | BLOCK | 5th cycle, no implementation |
| P165 | BLOCK | BLOCK | 5th cycle, weakest-link missing |
| P166 | BLOCK | BLOCK | 5th cycle, no implementation |
| P170 | ESCALATE | ESCALATE | 5th cycle, governance failure |

---

## Summary Table

| Item | Decision | Blockers | Unchanged Since |
| :--- | :--- | :--- | :--- |
| Node.js v24 compat | 🚨 ESCALATE | Integration tests crash | 2026-04-12 run 2 |
| proposal-storage-v2.ts | ⚠️ REQUEST CHANGES | No tests, poor error handling | NEW |
| MCP coverage test | ❌ BLOCK | Test failures | NEW |
| Unit tests | ✅ APPROVE | None | — |
| Orchestrator | 🚨 ESCALATE | Zero tests | 2026-04-11 |
| HTTP MCP auth | ⚠️ HIGH | No auth | 2026-04-11 |
| P164 | BLOCK | No implementation | 2026-04-11 |
| P165 | BLOCK | Missing feature | 2026-04-11 |
| P166 | BLOCK | No implementation | 2026-04-11 |
| P170 | ESCALATE | No ACs, governance bypass | 2026-04-11 |

**Net progress:** 0 critical issues resolved. 2 new quality issues introduced (v2 storage quality, MCP test failures). 1 persistent critical blocker escalated again.

**Recommendation:** The Node.js v24 issue MUST be resolved before any further integration testing is meaningful. The proposal-storage-v2.ts implementation is high-risk without tests and error handling.
