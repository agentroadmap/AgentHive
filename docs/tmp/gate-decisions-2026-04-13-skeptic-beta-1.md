# SKEPTIC BETA Gate Decisions — 2026-04-13 (Run 1)

**Reviewer:** skeptic-beta (cron)
**Timestamp:** 2026-04-13T00:34 UTC
**Focus:** Implementation Quality & Test Coverage (7th follow-up)
**Context:** SKEPTIC ALPHA confirmed platform non-functional (Postgres schema missing, all services down)

---

## Executive Summary

**🔴 CATASTROPHIC: Platform infrastructure collapsed.** Postgres is not running. Zero database tables exist. All systemd services missing. This is not a proposal-level quality issue — it is a **platform-level emergency** that makes all code quality reviews moot until resolved. Carrying forward the same 6 blockers from 6 previous reviews unchanged.

### Quick Status

| Item | 7th Cycle Status | Change from 6th |
| :--- | :--- | :--- |
| Postgres running | ❌ DOWN | 🔴 NEW (was degraded, now dead) |
| DB schema applied | ❌ NONE | 🔴 NEW (confirmed zero tables) |
| Systemd services | ❌ MISSING | 🔴 NEW (all 3 units not found) |
| Node.js v24 compat | 🚨 ESCALATE | ❌ UNCHANGED (7 cycles) |
| Orchestrator tests | ❌ BLOCK | ❌ UNCHANGED (zero tests) |
| proposal-storage-v2 | ❌ BLOCK | ❌ UNCHANGED (3rd cycle) |
| HTTP MCP auth | ⚠️ HIGH | ❌ UNCHANGED |
| Unit tests | ✅ PASS | ✅ UNCHANGED |

---

## 1. 🔴 CRITICAL: Platform Infrastructure — BLOCK ALL

### 1a. Postgres Not Running

**Evidence:**
```
$ pg_isready
/var/run/postgresql:5432 - no response
```

Postgres is not accepting connections. Without it, the entire MCP server operates in degraded mode — only file-based tools function.

**Verdict:** 🔴 **BLOCK ALL** — No proposal can be evaluated, developed, or merged without a running database.

### 1b. Database Schema Missing (Confirmed by SKEPTIC ALPHA)

Zero tables exist. All MCP tools backed by Postgres return `relation does not exist`:
- `proposal` — core workflow
- `workflow_templates` — state machine
- `agent_registry` — agent identity
- `knowledge_entries` — knowledge base
- `roadmap.cubics` — cubic orchestration
- `roadmap.escalation_log` — obstacle tracking
- `message_ledger` — A2A messaging
- `v_active_memory` — agent memory

**Schema files exist but were never applied:**
- `database/ddl/roadmap-ddl-v3.sql` (109KB — likely canonical)
- `database/ddl/roadmap-ddl-v2.sql` (66KB)
- `database/ddl/002-rfc-workflow-schema.sql` through `017-daily-efficiency-views.sql` (16 incremental migrations)

**Problem:** No migration runner has executed these. The `agenthive-db-migration` skill exists but was never invoked during deployment.

**Verdict:** 🔴 **BLOCK ALL**

### 1c. All Systemd Services Missing

```
$ systemctl status hermes-gate-pipeline
Unit hermes-gate-pipeline.service could not be found.
$ systemctl status agenthive-orchestrator
Unit agenthive-orchestrator.service could not be found.
$ systemctl status hermes-gateway
Unit hermes-gateway.service could not be found.
```

**Impact:** No gate pipeline, no orchestrator dispatch, no gateway API — the automation backbone is completely absent.

**Verdict:** 🔴 **BLOCK ALL**

---

## 2. 🚨 Node.js v24 TypeScript Compatibility — ESCALATE (7th Cycle)

**CONFIRMED STILL BROKEN** — Identical crash to all 6 previous reviews.

**Evidence (reproduced this cycle):**
```
file:///data/code/AgentHive/src/apps/mcp-server/tools/knowledge/handlers.ts:17
    constructor(private readonly server: McpServer) {}
                                 ^^^^^^^^^^^^^^^^^
SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property
is not supported in strip-only mode
```

**Test result (this cycle):**
```
3 pass, 29 fail — acceptance-criteria.test.ts
```

**Impact:**
- ALL integration tests that import MCP knowledge handlers crash
- 65 files use the `private readonly` pattern
- Node.js v24.14.1 is active (was never pinned to v22)
- Acceptance criteria tests, multi-proposal tests, E2E MCP coverage — all blocked

**Trivial fixes that exist but haven't been applied:**
1. Refactor 7 constructor signatures (~15 min)
2. Add `--experimental-strip-types` flag to bun/node invocation
3. Pin Node.js v22 in `package.json` engines field

**Verdict:** 🚨 **ESCALATE (7th cycle)** — This is now a governance failure spanning 24+ hours. The mechanical fix has been identified since cycle 2.

---

## 3. Orchestrator Code Quality — ⚠️ IMPROVED / ❌ BLOCKED (Tests)

### Code Quality (Verified)

`scripts/orchestrator.ts` — 297 lines. Quality assessment:

| Check | Status | Notes |
| :--- | :--- | :--- |
| Try/catch on all async paths | ✅ | 5/5 covered |
| Graceful client.close() | ✅ | finally blocks present |
| Defensive JSON parsing | ✅ | `safeParseMcpResponse()` |
| Parallel dispatch tolerance | ✅ | `Promise.allSettled()` |
| Contextual logging | ✅ | Structured logger throughout |
| Error propagation | ✅ | Returns null on failure, doesn't throw |
| Connection pooling | ✅ | Uses shared `getPool()` |

### Remaining Code Issues

1. **setInterval not cleared on shutdown (line 262):** Polling interval persists after SIGTERM/SIGINT. The interval ID should be stored and `clearInterval()` called in the shutdown handler. Current code calls `pgClient.release()` and `pool.end()` but the interval callback will fire and throw after pool shutdown.

2. **New MCP Client per dispatch (lines 95-96):** Each `dispatchAgent()` creates `new Client()` + `new SSEClientTransport()`. Under concurrent dispatch (line 188: `Promise.allSettled`), this opens N simultaneous SSE connections. Could exhaust file descriptors under load.

3. **Fuzzy cubic matching (line 109):** `agents.includes(agent)` does exact string match — safe. But cubic name at line 130 uses `${agent}` without sanitization.

### Test Coverage

**Zero.** No `orchestrator.test.ts` exists. The cubic reuse logic (lines 93-168, the main new feature) is completely untested.

**Minimum required tests:**
- `safeParseMcpResponse()` — unit test for valid JSON, error prefixes, empty result, non-JSON
- Cubic reuse flow — mock MCP client, verify recycle-before-create pattern
- `handleStateChange()` — verify agent dispatch map lookup, parallel execution
- Shutdown handler — verify clearInterval is called

**Verdict:** ❌ **BLOCK** — Code quality significantly improved from last review but zero test coverage on production-critical event-driven infrastructure is unacceptable.

---

## 4. proposal-storage-v2.ts — ❌ BLOCK (3rd Cycle, UNCHANGED)

`src/infra/postgres/proposal-storage-v2.ts` — 870 lines, core persistence layer.

| Check | Status | Detail |
| :--- | :--- | :--- |
| Functions | 27 | All exported, no internal helpers |
| Error handling | 3/27 | Only 15 try/catch/throw occurrences in 870 lines |
| Test coverage | 0% | Zero test files reference this module |
| Type safety | ❌ | `tags: any` (lines 29, 48, 82) — JSONB columns untyped |
| Input validation | ❌ | No parameter validation before SQL queries |
| Connection error handling | ❌ | Pool errors will propagate uncaught |

**Risk:** This is the MCP server's persistence layer. If the database connection drops or a query fails, the entire MCP server crashes because most functions lack try/catch.

**Verdict:** ❌ **BLOCK** — No changes since first flagged 3 cycles ago. Core infrastructure without error handling is a production liability.

---

## 5. HTTP MCP Authentication — ⚠️ HIGH (UNCHANGED)

`src/apps/mcp-server/http-compat.ts`:
- No Bearer token authentication
- No localhost IP restriction
- No rate limiting on the HTTP endpoint
- Accepts any JSON-RPC payload from any network caller

**Impact:** Any machine on the network can invoke any MCP tool (create proposals, modify state, access knowledge base) without authentication.

**Verdict:** ⚠️ **HIGH** — Not blocking today (localhost deployment) but must be resolved before any external exposure.

---

## 6. Unit Tests — ✅ PASSING

| Suite | Tests | Result |
| :--- | :--- | :--- |
| ac-tools-bugfix.test.ts | 21 | ✅ All pass (163ms) |

**Total test files in project:** 481 TypeScript source files, ~240 test files
**Integration test status:** ALL blocked by Node.js v24 issue

---

## 7. Previously Blocked Proposals

| Proposal | Decision | Blocker | Cycles |
| :--- | :--- | :--- | :--- |
| P163 | ❌ BLOCK | ACs corrupted, no dedicated tests | 7 |
| P164 | ❌ BLOCK | Zero implementation evidence | 7 |
| P165 | ❌ BLOCK | Weakest-link scoring not implemented | 7 |
| P166 | ❌ BLOCK | No schema column, no implementation | 7 |
| P170 | 🚨 ESCALATE | No ACs, governance failure | 7 |

---

## Summary Table

| Item | Decision | Severity | Action Required |
| :--- | :--- | :--- | :--- |
| Postgres running | 🔴 BLOCK ALL | CRITICAL | Start Postgres service |
| DB schema | 🔴 BLOCK ALL | CRITICAL | Apply roadmap-ddl-v3.sql + migrations |
| Systemd services | 🔴 BLOCK ALL | CRITICAL | Install + start all 3 services |
| Node.js v24 | 🚨 ESCALATE | CRITICAL | Pin v22 or fix 7 constructors (15 min) |
| Orchestrator | ❌ BLOCK | HIGH | Add unit + integration tests |
| proposal-storage-v2 | ❌ BLOCK | HIGH | Add error handling + tests |
| HTTP MCP auth | ⚠️ HIGH | HIGH | Add Bearer token auth |
| Unit tests | ✅ APPROVE | — | — |
| P163-P166 | ❌ BLOCK | MEDIUM | Implementation required |
| P170 | 🚨 ESCALATE | MEDIUM | ACs or governance override |

---

## Critical Path

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
9. Re-evaluate P163-P166                   [ongoing]
```

**Total time to restore basic functionality: ~55 minutes.**
**Total time to resolve all BLOCK items: ~5 hours.**

---

## Systemic Concern: 7 Cycles of Identical Results

Seven consecutive SKEPTIC BETA reviews have produced the same findings. This indicates:
1. The review process is not driving corrective action
2. Infrastructure issues are blocking all downstream work
3. The Node.js v24 fix (15 min of work) has been deferred for 24+ hours

**Recommendation:** Halt all proposal development until the platform is operational. The critical path above must be executed before any gate decisions on individual proposals can be meaningful.

---

*Report generated by SKEPTIC BETA — implementation quality review agent*
*Next action: Human/ops intervention to restore platform infrastructure*
