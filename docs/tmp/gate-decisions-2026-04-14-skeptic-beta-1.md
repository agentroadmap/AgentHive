# SKEPTIC BETA Gate Decisions — 2026-04-14 (Run 1)

**Reviewer:** skeptic-beta (cron)
**Timestamp:** 2026-04-14T00:32 UTC
**Focus:** Implementation Quality & Test Coverage (11th cycle)
**Context:** 5 substantial commits since Run 4 (Apr 13) — roadmap board fix, heartbeat liveness, hermes fallback. **22 files with uncommitted changes** — pipeline-cron refactored on-disk but never committed.

---

## Executive Summary

**Code quality shows real improvement in committed work, but critical progress is TRAPPED in uncommitted working tree changes.** The roadmap board fix, heartbeat liveness, and hermes fallback are all solid implementations. However, the most important change — pipeline-cron.ts refactored from spawnAgent subprocess to pure cubic dispatch with proper AC-3 notification wiring — exists only on disk, invisible to gate reviews and deployment. P169 is blocked for a 3rd consecutive time because gate reviewers evaluated the committed code (which still has spawnAgentFn), not the uncommitted fix.

### Quick Status

| Item | 11th Cycle Status | Change from 10th |
| :--- | :--- | :--- |
| Postgres running | ❌ DOWN | ❌ UNCHANGED (11 cycles) |
| Node.js v24 compat | 🚨 ESCALATE | ❌ UNCHANGED (11 cycles) |
| Orchestrator tests | ❌ BLOCK | ❌ UNCHANGED |
| proposal-storage-v2 | ❌ BLOCK | ❌ UNCHANGED (6th cycle) |
| HTTP MCP auth | ⚠️ HIGH | ❌ UNCHANGED |
| Unit tests (26) | ✅ PASS | ✅ UNCHANGED |
| Integration tests | ❌ ALL FAIL | ❌ UNCHANGED |
| Roadmap board | ✅ FIXED | 🟢 NEW COMMIT |
| Heartbeat liveness | ✅ IMPROVED | 🟢 NEW COMMIT |
| Hermes fallback | ✅ IMPROVED | 🟢 NEW COMMITS |
| Uncommitted changes | 🚨 NEW FINDING | 🟡 22 files diverged |
| P169 on-disk fix | ⚠️ TRAPPED | 🟡 Code exists, not committed |

---

## 1. 🟢 Roadmap Board Fix (59db0cb) — APPROVE

### Code Quality Assessment

| Check | Status | Detail |
| :--- | :--- | :--- |
| Stub replacement | ✅ CLEAN | `ws-bridge-standalone.js` reduced from ~140 lines to 10-line delegation |
| Wire format mapper | ✅ | `toWireProposal()` handles 15 field mappings with null safety |
| Maturity enum mapping | ✅ | `MATURITY_LEVEL` covers all 7 values including skeleton/contracted/audited |
| Error handling | ✅ | `safeStringify` handles BigInt serialization |
| Parallel loading | ✅ | `Promise.all` for proposals, agents, channels, messages |

**Evidence:** `src/apps/dashboard-web/websocket-server.ts` — clean toWireProposal() mapper at lines 30-50.

**Concern:** The `toWireProposal` function returns `Record<string, unknown>` rather than a typed interface — loses compile-time safety. Acceptable for a wire bridge but should be typed if the interface is stable.

**Verdict:** ✅ **APPROVE**

---

## 2. 🟢 Heartbeat Liveness (8705f1e) — APPROVE

### Code Quality Assessment

| Check | Status | Detail |
| :--- | :--- | :--- |
| Heartbeat mechanism | ✅ | stdout/stderr output resets liveness timer |
| Kill threshold | ✅ | 2 minutes silence → kill (reasonable for stuck agents) |
| Absolute timeout | ✅ | 600s safety net for runaway processes |
| Resource cleanup | ✅ | clearTimeout on both close and error events |
| Timeout handling | ✅ | Separate liveness and absolute timeout timers |

**Evidence:** `src/core/orchestration/agent-spawner.ts` — dual-timer approach with heartbeat reset.

**Verdict:** ✅ **APPROVE** — Well-designed improvement. No agents killed mid-work on complex gate reviews.

---

## 3. 🟢 Hermes Fallback (8f54846, 0a72818) — APPROVE

### Code Quality Assessment

| Check | Status | Detail |
| :--- | :--- | :--- |
| Provider detection | ✅ | `resolveAvailableProvider()` checks claude auth before dispatch |
| Fallback chain | ✅ | claude → hermes (Nous subscription) |
| Auth model | ✅ | HOME=/home/andy, no API keys passed |
| PATH resolution | ✅ | `/home/andy/.local/bin` prepended |

**Concern (carried from Run 4):** The `escalateOrNotify()` LADDER still references Claude models (`claude-haiku`, `claude-sonnet`, `claude-opus`) but dispatch uses Hermes/Nous. The escalation would retry with a different model hint that `buildHermesArgs` may ignore. Latent logic inconsistency.

**Verdict:** ✅ **APPROVE** — Functional fallback, good auth model. Escalation ladder concern is non-blocking.

---

## 4. 🚨 UNCOMMITTED PIPELINE-CRON REFACTOR — CRITICAL FINDING

### The Problem

`src/core/pipeline/pipeline-cron.ts` has **136 lines of uncommitted changes** that fundamentally change the dispatch architecture:

**Committed (75ac11e):** cubic_create → cubic_focus → **spawnAgent subprocess** → markTransitionDone
**On-disk (uncommitted):** cubic_create → cubic_focus → **mcpClientFactory** → markTransitionDone

Key uncommitted changes:
- ❌ Removed `spawnAgentFn` dependency injection (the thing D3 gate keeps blocking on)
- ❌ Removed `defaultWorktree` property
- ❌ Removed `readNumber` utility
- ✅ Added `mcpClientFactory` for clean MCP client DI
- ✅ Pure cubic dispatch — no subprocess spawning
- ✅ AC-3 notification_queue INSERT present (lines 473-483)
- ✅ All 5 unit tests pass on on-disk code

**This uncommitted code SATISFIES BOTH P169 ACs:**
- **AC-1:** No spawnAgentFn — dispatches via cubic_create + cubic_focus only ✅
- **AC-3:** notification_queue INSERT with CRITICAL severity + discord channel ✅

**But it's invisible.** Gate reviews (including today's D3 block at `25b53a6`) evaluate committed code. The fix exists but is trapped in the working tree.

**Verdict:** 🚨 **BLOCK — Code must be committed.** The fix is real but undeployable and unrecoverable if the working tree is lost.

---

## 5. 🔴 Uncommitted Changes — 22 FILES (946+/613−)

### Severity: HIGH

| File | Size of Change | Risk |
| :--- | :--- | :--- |
| `pipeline-cron.ts` | 136 lines | CRITICAL — P169 fix |
| `pipeline-cron.test.ts` | 175 lines | HIGH — test updates match refactor |
| `proposals/pg-handlers.ts` | 135 lines | HIGH — proposal backend changes |
| `rfc/pg-handlers.ts` | 70 lines | MEDIUM |
| `CLAUDE.md` | 25 lines | MEDIUM — project memory drift |
| `orchestrator.ts` | 40 lines | MEDIUM |
| 16 other files | Various | LOW-MEDIUM |

**Risks:**
1. Any git operation (checkout, pull, stash) could lose the pipeline-cron fix
2. Gate reviews evaluate committed code, missing actual fixes
3. Tests pass on-disk but fail if someone checks out HEAD
4. `CLAUDE.md` drift — committed version may not reflect current project state

**Verdict:** 🔴 **BLOCK — Must commit or stash.** Uncommitted work of this scope is a deployment and review blocker.

---

## 6. 🚨 Node.js v24 Compatibility — ESCALATE (11th Cycle, 40+ hours)

**7/7 files still broken.** Identical to all 10 previous reviews.

```
src/core/infrastructure/knowledge-base.ts:108
src/apps/mcp-server/tools/knowledge/handlers.ts:17
src/apps/mcp-server/tools/memory/pg-handlers.ts:39
src/apps/mcp-server/tools/protocol/handlers.ts:30
src/apps/mcp-server/tools/cubic/pg-handlers.ts:24
src/apps/mcp-server/tools/teams/handlers.ts:30
src/apps/mcp-server/tools/pulse/pg-handlers.ts:55
```

**Fix:** 7 × 2 minutes = 15 minutes. Same mechanical transformation every cycle.
**Impact:** MCP server crashes on startup. Zero tool access.
**Cycles:** 11. **Hours:** 40+.

**Verdict:** 🚨 **ESCALATE (11th cycle)** — GOVERNANCE FAILURE. This is the longest-standing blocker in the project. Recommend human operator direct intervention or HOTFIX proposal with CRITICAL priority.

---

## 7. 🔴 Postgres — BLOCK ALL (11th Cycle)

```
pg_isready → /var/run/postgresql:5432 - no response
```

**Verdict:** 🔴 **BLOCK ALL** — 11th cycle. Platform cannot function.

---

## 8. ❌ proposal-storage-v2 — BLOCK (6th Cycle)

| Check | Status |
| :--- | :--- |
| Error handling | ❌ 3/25 async functions (12%) |
| Tests | ❌ None |
| Changes since 5th cycle | ❌ None |

**Verdict:** ❌ **BLOCK** — 6th cycle unchanged.

---

## 9. ❌ Orchestrator — BLOCK (UNCHANGED)

Zero test files for `scripts/orchestrator-with-skeptic.ts` or `scripts/orchestrator.ts`.

**getNextState() bug persists:** TRIAGE→FIX and FIX→DEPLOYED are invalid state names. Should be TRIAGE→FIXING and FIXING→DONE per CLAUDE.md.

**Verdict:** ❌ **BLOCK**

---

## 10. ⚠️ HTTP MCP Authentication — HIGH (UNCHANGED)

`http-compat.ts` still has zero authentication.

**Verdict:** ⚠️ **HIGH**

---

## 11. 🟡 Unit Tests — PASSING (26/26)

| Suite | Tests | Result |
| :--- | :--- | :--- |
| pipeline-cron.test.ts | 5 | ✅ All pass |
| ac-tools-bugfix.test.ts | 21 | ✅ All pass |

Tests pass on both committed and on-disk code. Note: pipeline-cron tests were updated to use `mcpClientFactory` DI (uncommitted).

---

## Summary Table

| Item | Decision | Severity | Cycles Unchanged |
| :--- | :--- | :--- | :--- |
| Roadmap board fix | ✅ APPROVE | — | NEW |
| Heartbeat liveness | ✅ APPROVE | — | NEW |
| Hermes fallback | ✅ APPROVE | — | NEW |
| Pipeline-cron on-disk fix | 🚨 BLOCK (uncommitted) | CRITICAL | NEW |
| Uncommitted changes (22 files) | 🔴 BLOCK | HIGH | NEW |
| Node.js v24 | 🚨 ESCALATE | CRITICAL | 11 |
| Postgres | 🔴 BLOCK ALL | CRITICAL | 11 |
| Orchestrator tests | ❌ BLOCK | HIGH | 11+ |
| proposal-storage-v2 | ❌ BLOCK | HIGH | 6 |
| HTTP MCP auth | ⚠️ HIGH | HIGH | 11 |
| getNextState() bug | ⚠️ MINOR BUG | LOW | 2 |
| Unit tests (26) | ✅ APPROVE | — | — |
| Integration tests | ❌ BLOCK | HIGH | 11 |

---

## Critical Action Items

### Immediate (This Session)
1. **COMMIT pipeline-cron.ts refactor** — The P169 fix is real but trapped in the working tree. `git add src/core/pipeline/pipeline-cron.ts tests/unit/pipeline-cron.test.ts && git commit -m "fix(P169): pure cubic dispatch, remove spawnAgent, wire AC-3 notification"`
2. **Commit or stash remaining 20 files** — Decide which are ready and which need cleanup
3. **Clean up untracked files** — 66 untracked files including debug scripts and test artifacts

### High Priority (Next 24 Hours)
4. **Fix Node.js v24** — 15-minute fix, 11th cycle. Assign directly to human operator.
5. **Start Postgres** — Platform non-functional for 11 cycles.
6. **Fix getNextState()** — Change `TRIAGE: "FIX"` to `TRIAGE: "FIXING"` and `FIX: "DEPLOYED"` to `FIXING: "DONE"`

### Strategic
7. **Escalation ladder reconciliation** — Update `escalateOrNotify()` to match current dispatch model (Hermes/Nous, not Claude)
8. **Add orchestrator tests** — Production-critical infrastructure with zero coverage
9. **Type the wire format** — `toWireProposal()` should return a typed interface

---

## Governance Escalation: Node.js v24

| Cycles | Hours | Action |
| :--- | :--- | :--- |
| 11 | 40+ | **CRITICAL ESCALATE → Human Operator** |

This is no longer a code quality issue. The fix is trivial (7 files × 2 min = 15 min). The impact is catastrophic (MCP server crashes). The persistence across 11 review cycles indicates either:
- The fix is assigned to no one
- The fix is assigned but not prioritized
- There is a process gap preventing trivial fixes from being executed

**SKEPTIC BETA recommends:** Create a HOTFIX proposal with CRITICAL priority, assign directly to Gary (human owner), with a 24-hour SLA. This should bypass the normal proposal workflow entirely.

---

## New Finding: Code Trapped in Working Tree

This is a process-level risk that hasn't been flagged before. The most significant code improvement in this cycle (pipeline-cron refactor that would unblock P169) exists only as uncommitted changes. This means:
- Gate reviews see the old code and keep blocking
- The fixer gets demoralized (code is done but keeps getting blocked)
- Any workspace disruption loses the work

**Recommendation:** Establish a convention that significant code changes must be committed before the next review cycle runs. Consider adding a pre-review check that warns about uncommitted changes to files referenced by active proposals.
