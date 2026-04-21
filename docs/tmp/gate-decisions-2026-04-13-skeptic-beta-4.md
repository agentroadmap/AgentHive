# SKEPTIC BETA Gate Decisions — 2026-04-13 (Run 4)

**Reviewer:** skeptic-beta (cron)
**Timestamp:** 2026-04-13T20:31 UTC
**Focus:** Implementation Quality & Test Coverage (10th follow-up)
**Context:** 11 commits since Run 3 — P167/P168/P169 fixes, agent dispatch refactor, infinite re-enqueue fix, schema grants.

---

## Executive Summary

**Meaningful code quality progress in agent dispatch layer; infrastructure catastrophe enters 10th cycle.** The latest commits show a well-executed refactor: agent dispatch now uses Hermes CLI with subscription auth (no API keys), the infinite re-enqueue loop is properly fixed, and audit/gate logging has correct column mapping. Unit tests pass (26/26). But Postgres remains down (10th cycle), Node.js v24 compat has persisted for 36+ hours despite a 15-minute fix, and integration tests remain unverifiable.

### Quick Status

| Item | 10th Cycle Status | Change from 9th |
| :--- | :--- | :--- |
| Postgres running | ❌ DOWN | ❌ UNCHANGED (10 cycles) |
| DB schema applied | ❌ NONE | ❌ UNCHANGED |
| Node.js v24 compat | 🚨 ESCALATE | ❌ UNCHANGED (10 cycles, 36+ hours) |
| Orchestrator tests | ❌ BLOCK | ❌ UNCHANGED |
| proposal-storage-v2 | ❌ BLOCK | ❌ UNCHANGED (5th cycle) |
| HTTP MCP auth | ⚠️ HIGH | ❌ UNCHANGED |
| Unit tests (26) | ✅ PASS | ✅ UNCHANGED |
| Integration tests | ❌ ALL FAIL | ❌ UNCHANGED |
| Agent dispatch quality | ✅ IMPROVED | 🟢 NEW COMMITS |
| Gate/audit logging | ✅ IMPROVED | 🟢 NEW COMMITS |
| Infinite re-enqueue | ✅ FIXED | 🟢 NEW COMMIT |

---

## 1. 🟢 agent-spawner.ts — IMPROVED (3 commits)

### Code Quality Assessment (commits 5038c0f, 75ac11e, 6ec0818)

| Check | Status | Detail |
| :--- | :--- | :--- |
| Provider abstraction | ✅ CLEAN | All dispatch through `buildHermesArgs()` — single code path |
| Auth model | ✅ IMPROVED | Uses `~/.hermes/auth.json` subscription, no API keys |
| PATH resolution | ✅ FIXED | `/home/andy/.local/bin` prepended to PATH |
| Schema routing | ✅ FIXED | Explicit `roadmap_workforce.agent_runs` (bypasses VIEW) |
| Error handling | ✅ | `runProcess` catches spawn errors, timeout kills child |
| Resource cleanup | ✅ | `clearTimeout` on both close and error events |
| Escalation ladder | ⚠️ STALE | Still references Claude models but dispatch uses Hermes/Nous |

**Evidence:** `src/core/orchestration/agent-spawner.ts` — `buildHermesArgs()` constructs `hermes chat -q 'task' -Q --provider nous --yolo`. Clean single-path dispatch.

**Concern:** The `escalateOrNotify()` function (lines 331-364) still has a ladder of Claude models (`claude-haiku`, `claude-sonnet`, `claude-opus`) but all dispatch now goes through Hermes. The escalation would retry with a different model hint that `buildHermesArgs` may ignore unless it differs from `xiaomi/mimo-v2-pro`. This is a latent logic inconsistency — not blocking but should be reconciled.

**Verdict:** ✅ **APPROVE** — Clean refactor, proper auth model, good resource management.

---

## 2. 🟢 pipeline-cron.ts — Infinite Re-enqueue FIXED

### Code Quality Assessment (commit 2ee0089)

| Check | Status | Detail |
| :--- | :--- | :--- |
| Loop prevention | ✅ FIXED | `reason !== "coalesced"` guard on fn_enqueue_mature_proposals |
| Logic correctness | ✅ | Only initial drains enqueue; coalesced re-drains skip |
| Side effect isolation | ✅ | Enqueue and claim loops are separate concerns |

**Evidence:** `src/core/pipeline/pipeline-cron.ts` line 314:
```typescript
if (reason !== "coalesced") {
    // Only call fn_enqueue_mature_proposals on initial drains
}
```

This is the correct fix. The previous version would: drain → process → create new transition → NOTIFY → drain → process → create new transition → infinite loop. The `reason` parameter now acts as a proper discriminator.

**Verdict:** ✅ **APPROVE** — Clean fix, correct logic.

---

## 3. 🟢 orchestrator-with-skeptic.ts — Logging IMPROVED (P167/P168)

### Code Quality Assessment (commits 72ac457, f270574)

| Check | Status | Detail |
| :--- | :--- | :--- |
| Column mapping | ✅ FIXED | `actor→changed_by`, `resource_type→entity_type`, etc. |
| Action value | ✅ FIXED | Uses `update` (passes CHECK constraint, not `gate_blocked`) |
| Advance logging | ✅ NEW | Both reject AND advance decisions logged to gate_decision_log |
| Gate mapping | ✅ | `gateMap` correctly maps transitions to D1-D4 |
| Structured rationale | ✅ | JSON includes blockers, challenges, alternatives |

**Evidence:** `scripts/orchestrator-with-skeptic.ts` lines 157-169, 188-199 — dual INSERT for both reject and advance decisions with proper gate identification.

**Concern:** The `skepticReview()` function (lines 33-120) performs shallow checks:
- D2 gate: checks `acceptance_criteria?.length`, `data.design`, `data.motivation` exist but not their quality
- D3 gate: only checks `maturity_state !== "mature"`, rest are generic challenges
- No code review, no test verification, no actual implementation analysis

This is adequate for a first-pass automated gate but should not be trusted as the sole quality mechanism for complex proposals.

**Verdict:** ⚠️ **APPROVE with note** — Functional logging, but skeptic review logic is shallow.

---

## 4. 🟡 Unit Tests — PASSING (26/26)

| Suite | Tests | Result | Duration |
| :--- | :--- | :--- | :--- |
| pipeline-cron.test.ts | 5 | ✅ All pass | 376ms |
| ac-tools-bugfix.test.ts | 21 | ✅ All pass | 752ms |

**Total: 26 tests, 0 failures.**

Test quality notes:
- pipeline-cron tests use proper DI mocks with `spawnAgentFn`
- Tests verify SQL parameter assertions (error message format, requeue params)
- Listener harness correctly simulates PG NOTIFY emission
- Tests cover: happy path, retry with attempts remaining, final failure, notification re-drain

---

## 5. 🔴 Integration Tests — ALL FAIL (Infrastructure Dependency)

Still cannot run — Postgres is down. All integration tests require DB connection.

---

## 6. 🔴 Platform Infrastructure — BLOCK ALL (10th Cycle)

**Completely unchanged from all 9 previous reviews.**

| Check | Evidence |
| :--- | :--- |
| Postgres | `pg_isready` → "no response" |
| Systemd services | `agenthive-mcp.service` enabled but no other services |
| DB schema | Connection refused — zero tables accessible |

**Verdict:** 🔴 **BLOCK ALL** — 10th cycle. Platform cannot function.

---

## 7. 🚨 Node.js v24 TypeScript Compatibility — ESCALATE (10th Cycle, 36+ hours)

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

**Confirmed crash:** `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in strip-only mode`

**Fix:** 7 × 2 minutes = 15 minutes of mechanical refactoring. Pattern is the same for all files.

**Verdict:** 🚨 **ESCALATE (10th cycle, 36+ hours)** — Governance failure. Trivial fix, massive impact, zero action across 10 review cycles.

---

## 8. ❌ proposal-storage-v2 — BLOCK (5th Cycle, UNCHANGED)

No changes. 12% error handling coverage (3/25 async functions). No tests.

**Verdict:** ❌ **BLOCK** — 5th cycle unchanged.

---

## 9. ❌ Orchestrator — BLOCK (UNCHANGED)

Zero test files for `scripts/orchestrator-with-skeptic.ts` or `scripts/orchestrator.ts`.

**Verdict:** ❌ **BLOCK**

---

## 10. ⚠️ HTTP MCP Authentication — HIGH (UNCHANGED)

`http-compat.ts` still has zero authentication.

**Verdict:** ⚠️ **HIGH**

---

## 11. 🟡 getNextState() — NEW BUG FOUND

`scripts/orchestrator-with-skeptic.ts` line 267-275:

```typescript
const transitions: Record<string, string> = {
    DRAFT: "REVIEW",
    REVIEW: "DEVELOP",
    DEVELOP: "MERGE",
    MERGE: "COMPLETE",
    TRIAGE: "FIX",      // ← Should be "FIXING"
    FIX: "DEPLOYED"      // ← Should be "DONE"
};
```

Per CLAUDE.md, hotfix workflow is TRIAGE → FIXING → DONE. The function maps to `FIX` and `DEPLOYED` which are not valid states. This would cause the orchestrator to look for non-existent transitions.

**Verdict:** ⚠️ **MINOR BUG** — Non-blocking (hotfix path unlikely to be triggered) but should be fixed.

---

## Summary Table

| Item | Decision | Severity | Cycles Unchanged |
| :--- | :--- | :--- | :--- |
| agent-spawner.ts (refactor) | ✅ APPROVE | — | NEW |
| pipeline-cron.ts (re-enqueue fix) | ✅ APPROVE | — | NEW |
| orchestrator-with-skeptic.ts (logging) | ⚠️ APPROVE w/note | LOW | NEW |
| Unit tests (26 total) | ✅ APPROVE | — | — |
| getNextState() bug | ⚠️ MINOR BUG | LOW | NEW |
| Integration tests | ❌ BLOCK | HIGH | 10 |
| Postgres running | 🔴 BLOCK ALL | CRITICAL | 10 |
| Node.js v24 | 🚨 ESCALATE | CRITICAL | 10 |
| Orchestrator | ❌ BLOCK | HIGH | 10 |
| proposal-storage-v2 | ❌ BLOCK | HIGH | 5 |
| HTTP MCP auth | ⚠️ HIGH | HIGH | 10 |

---

## Critical Escalation: Node.js v24 Compatibility

**10 cycles. 36+ hours. 15-minute fix. Zero action.**

This is no longer a code quality issue — it is a governance failure. The fix is:
1. For each of the 7 files, change `constructor(private readonly x: Type) {}` to `x: Type; constructor(x: Type) { this.x = x; }`
2. Run `npx tsx --test tests/unit/pipeline-cron.test.ts` to verify
3. Commit

At this point, SKEPTIC BETA recommends this be assigned directly to a human operator or escalated to the orchestrator as a HOTFIX proposal with CRITICAL priority.
