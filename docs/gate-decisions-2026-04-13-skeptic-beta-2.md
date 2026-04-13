# SKEPTIC BETA Gate Decisions — 2026-04-13 (Run 2)

**Reviewer:** skeptic-beta (cron)
**Timestamp:** 2026-04-13T04:37 UTC
**Focus:** Implementation Quality & Test Coverage (8th follow-up)
**Context:** Recent code changes include schema refactor (maturity_state→maturity, roadmap→roadmap_proposal), new getProposalProjection tool, deleteAC reorganization, constants cleanup.

---

## Executive Summary

**Mixed: Schema quality improved, but platform still collapsed.** The recent commits show solid refactoring work — the `maturity_state`→`maturity` and `roadmap`→`roadmap_proposal` namespace migrations are comprehensive and well-executed. However, Postgres remains down, systemd services are absent, and Node.js v24 incompatibility persists (8th cycle). New code (`getProposalProjection`) was added without tests. All 6 infrastructure blockers from previous reviews remain **unchanged**.

### Quick Status

| Item | 8th Cycle Status | Change from 7th |
| :--- | :--- | :--- |
| Postgres running | ❌ DOWN | ❌ UNCHANGED (8 cycles) |
| DB schema applied | ❌ NONE | ❌ UNCHANGED |
| Systemd services | ❌ MISSING | ❌ UNCHANGED |
| Node.js v24 compat | 🚨 ESCALATE | ❌ UNCHANGED (8 cycles) |
| Orchestrator tests | ❌ BLOCK | ❌ UNCHANGED |
| proposal-storage-v2 | ❌ BLOCK | ❌ UNCHANGED |
| HTTP MCP auth | ⚠️ HIGH | ❌ UNCHANGED |
| Unit tests | ✅ PASS | ✅ UNCHANGED |
| Schema refactor | ✅ NEW | 🟢 IMPROVEMENT |

---

## 1. 🟢 Schema Refactor — APPROVED (with notes)

### maturity_state → maturity migration

| Check | Status | Detail |
| :--- | :--- | :--- |
| Column rename in storage layer | ✅ | proposal-storage-v2.ts: all references updated |
| Handler references | ✅ | pg-handlers.ts, rfc/pg-handlers.ts, proposal-integrity.ts |
| Schema generators | ✅ | schema-generators.ts: enum values corrected (was "skeleton/contracted/audited", now "new/active/mature/obsolete") |
| Constants | ✅ | DEFAULT_STATUSES: Hotfix workflow added (TRIAGE→FIXING→DONE), legacy statuses preserved |
| Backward compat | ✅ | pool.ts search_path includes both `roadmap` and `roadmap_proposal` |

**Quality notes:**
- Search path fallback in `pool.ts` (line 95-96) is well-designed: when schema is "roadmap", appends ",roadmap_proposal" so unqualified refs resolve against both.
- The old maturity enum values ("skeleton", "contracted", "audited") in schema-generators were a latent bug — now fixed.
- `DEFAULT_STATUSES` properly preserves legacy statuses while adding new hotfix workflow.

**Verdict:** ✅ **APPROVE** — Clean, comprehensive refactor.

### Minor Issue: YAML Injection in getProposalProjection

```typescript
// Line 654: title unquoted in YAML frontmatter
md += `title: "${proposal.title}"\n`;
```

If a proposal title contains a backslash or double quote, this breaks YAML parsing. Should escape or use YAML-safe serialization.

**Severity:** LOW (titles are agent-generated, not user-input)
**Verdict:** ⚠️ **REQUEST CHANGES** — Escape title for YAML safety.

---

## 2. 🔴 Platform Infrastructure — BLOCK ALL (8th Cycle)

**Completely unchanged from all 7 previous reviews.**

| Check | Evidence |
| :--- | :--- |
| Postgres | `pg_isready` → no response |
| Systemd services | All 3 units not found |
| DB schema | Zero tables confirmed in last ALPHA review |

**Verdict:** 🔴 **BLOCK ALL** — 8th cycle. Platform cannot function.

---

## 3. 🚨 Node.js v24 TypeScript Compatibility — ESCALATE (8th Cycle)

**Still broken.** Integration test evidence (this cycle):
```
file:///data/code/AgentHive/src/apps/mcp-server/tools/knowledge/handlers.ts:17
    constructor(private readonly server: McpServer) {}
SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property
is not supported in strip-only mode
```

**Impact on this cycle's changes:** The new `getProposalProjection` function in `pg-handlers.ts` cannot be tested via integration tests because all integration tests that import the MCP server crash on this error.

**Verdict:** 🚨 **ESCALATE (8th cycle, 28+ hours)** — Governance failure. Fix is 15 minutes of work.

---

## 4. getProposalProjection — ❌ BLOCK (New Code, No Tests)

New MCP tool `prop_get_projection` added in `proposals/pg-handlers.ts` (lines 599-735) + `backend-switch.ts`.

### Code Quality Assessment

| Check | Status | Detail |
| :--- | :--- | :--- |
| Try/catch | ✅ | Outer try/catch with errorResult |
| Null proposal check | ✅ | Returns "not found" message |
| Structured output | ✅ | YAML frontmatter + Markdown sections |
| AC status icons | ✅ | Visual mapping for pass/fail/blocked/waived |

### Issues Found

1. **Zero test coverage** — No unit or integration tests for this function. `grep` found no references in any test file.

2. **5 sequential DB queries could be parallelized** (lines 610-644):
   ```typescript
   const acResult = await query(...);      // query 1
   const leaseResult = await query(...);   // query 2
   const decisionResult = await query(...); // query 3
   const depResult = await query(...);     // query 4
   ```
   These are independent queries that could use `Promise.all()` for ~4x latency reduction.

3. **YAML injection** — Title not escaped (see above).

4. **No timeout on queries** — If Postgres is slow/hung, this function blocks indefinitely.

**Verdict:** ❌ **BLOCK** — New production code without tests. Parallelizable queries not optimized.

---

## 5. proposal-storage-v2.ts — ❌ BLOCK (4th Cycle, UNCHANGED)

| Check | Status | Detail |
| :--- | :--- | :--- |
| Error handling | ❌ UNCHANGED | Only 3/27 functions have try/catch |
| Test coverage | ❌ UNCHANGED | Zero test files reference this module |
| Type safety | ❌ UNCHANGED | `tags: any` on lines 29, 82 |
| Input validation | ❌ UNCHANGED | No parameter validation before SQL |

**Recent changes:** Schema column rename (`maturity_state`→`maturity`) and view name update (`roadmap.v_proposal_summary`→`roadmap_proposal.v_proposal_summary`). These are correct but don't address the quality issues.

**Verdict:** ❌ **BLOCK** — 4th cycle unchanged.

---

## 6. Orchestrator Tests — ❌ BLOCK (UNCHANGED)

Zero test files found for `scripts/orchestrator.ts`. No changes since last review.

**Verdict:** ❌ **BLOCK**

---

## 7. HTTP MCP Authentication — ⚠️ HIGH (UNCHANGED)

No auth on HTTP endpoint. No changes.

**Verdict:** ⚠️ **HIGH**

---

## 8. Unit Tests — ✅ PASSING

| Suite | Tests | Result |
| :--- | :--- | :--- |
| ac-tools-bugfix.test.ts | 21 | ✅ All pass (364ms) |
| milestone-filter.test.ts | 5 | ✅ All pass (365ms) |

**Total:** 26 tests, 0 failures.

---

## 9. Constants Cleanup — ✅ APPROVED

`src/shared/constants/index.ts` changes:
- Added `FIXING` and `DONE` hotfix statuses
- Added `NON_ISSUE` terminal status  
- Removed duplicate `DEPLOYED` entry
- Added workflow comments clarifying RFC vs Hotfix

**Verdict:** ✅ **APPROVE**

---

## Summary Table

| Item | Decision | Severity | Cycles Unchanged |
| :--- | :--- | :--- | :--- |
| Schema refactor (maturity) | ✅ APPROVE | — | NEW |
| Schema refactor (namespaces) | ✅ APPROVE | — | NEW |
| Constants cleanup | ✅ APPROVE | — | NEW |
| getProposalProjection | ❌ BLOCK | HIGH | NEW |
| YAML injection | ⚠️ REQUEST CHANGES | LOW | NEW |
| Postgres running | 🔴 BLOCK ALL | CRITICAL | 8 |
| DB schema | 🔴 BLOCK ALL | CRITICAL | 8 |
| Systemd services | 🔴 BLOCK ALL | CRITICAL | 8 |
| Node.js v24 | 🚨 ESCALATE | CRITICAL | 8 |
| Orchestrator | ❌ BLOCK | HIGH | 8 |
| proposal-storage-v2 | ❌ BLOCK | HIGH | 4 |
| HTTP MCP auth | ⚠️ HIGH | HIGH | 8 |
| Unit tests | ✅ APPROVE | — | — |
| P163-P166 | ❌ BLOCK | MEDIUM | 8 |
| P170 | 🚨 ESCALATE | MEDIUM | 8 |

---

## What Changed This Cycle

**Positive:**
- Schema refactor is comprehensive and well-executed
- Backward-compatible search_path fallback
- Maturity enum corrected in schema generators (was wrong)
- Constants cleaned up with proper workflow documentation
- deleteAC reorganized with cleanup_singles support
- New getProposalProjection tool (good idea, needs tests)

**Not addressed (8th cycle):**
- Platform infrastructure (Postgres, systemd, schema)
- Node.js v24 fix (15 min of work, 28+ hours deferred)
- Orchestrator test coverage
- proposal-storage-v2 error handling
- HTTP MCP auth

---

## Critical Path (Unchanged from 7th Cycle)

```
1. Start Postgres                          [5 min]
2. Apply schema (roadmap-ddl-v3.sql)       [10 min]
3. Install systemd services                [15 min]
4. Fix Node.js v24 (pin v22 or refactor)   [15 min]
5. Smoke-test proposal workflow            [10 min]
   ↓
Now meaningful QA is possible:
6. Write orchestrator tests                [2 hrs]
7. Add storage-v2 error handling           [1 hr]
8. Add HTTP MCP auth                       [1 hr]
9. Write getProposalProjection tests       [30 min]
10. Parallelize projection queries         [15 min]
11. Re-evaluate P163-P166                  [ongoing]
```

---

*Report generated by SKEPTIC BETA — implementation quality review agent*
*Run 2, 2026-04-13T04:37 UTC*
