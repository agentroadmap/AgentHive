### P268 — AbortController plumbing for in-flight MCP cubic_focus and cubic_create — SEND_BACK (Skeptic Alpha, 2026-04-21)

**Context:** P268 proposes plumbing AbortController through spawnAgent to abort MCP calls (cubic_focus, cubic_create) during shutdown, preventing pipeline-cron from hanging past TimeoutStopSec.

**Decision: SEND_BACK to DRAFT**

The proposal identifies a real problem but the RFC is not structurally ready for Review.

**FINDINGS:**

| AC | Verdict | Evidence |
|:---|:---|:---|
| ACs exist | FAIL | list_criteria returned empty. No measurable acceptance criteria defined. |
| Design coherent | FAIL | Proposes AbortController through spawnAgent, but cubic_create/cubic_focus use mcpClientFactory (McpClientLike.callTool), not spawnAgent. Two distinct interfaces conflated. |
| Economically sound | UNCERTAIN | AbortController won't solve the real problem — MCP SDK callTool doesn't accept AbortSignal. Aborting HTTP leaves squad_dispatch in 'active'. |
| Defer clause defined | FAIL | "Defer until after ST1/ST2" — ST1/ST2 are undefined. Not proposal IDs, tests, or documented milestones. |
| Existing pattern referenced | FAIL | Orchestrator.ts lines 1386-1422 already implements bounded drain + SQL cleanup. Not referenced or adapted. |

**ROOT CAUSE (real, confirmed):**
pipeline-cron.ts line 860: `await (this.drainPromise ?? Promise.resolve())` — no timeout race. If MCP call hangs, stop() hangs indefinitely. No in-flight tracking exists (no Set<Promise>, no SHUTDOWN_DRAIN_MS, no SQL cleanup on timeout).

**COMPARISON — orchestrator.ts already has the fix:**
- Lines 39-42: `const inFlight = new Set<Promise<unknown>>()` — tracks promises
- Lines 1386-1394: `Promise.race([drainPromise, timeoutPromise])` — bounded wait
- Lines 1401-1421: SQL UPDATE on timeout — cancels hanging dispatch rows

No AbortController needed. The pattern is proven and already in production.

**RECOMMENDED FIX (simple, proven):**
1. Track MCP calls in a Set<Promise> (like orchestrator inFlight)
2. Race drain vs configurable timeout in stop() (default 30s)
3. On timeout: SQL UPDATE squad_dispatch SET dispatch_status='cancelled' WHERE dispatch_status IN ('assigned','active') AND completed_at IS NULL
4. On timeout: SQL UPDATE proposal_lease SET released_at=now() for affected proposals

**REQUIRED BEFORE ADVANCEMENT:**
1. Add measurable ACs:
   - AC-1: stop() races drain against configurable timeout (default 30s)
   - AC-2: On timeout, SQL UPDATE cancels in-flight dispatch rows
   - AC-3: proposal_lease for cancelled dispatches get released_at=now()
   - AC-4: Unit test proves stop() resolves within timeout+1s when MCP call hangs
2. Remove or define ST1/ST2
3. Update design to match actual code path (mcpClientFactory, not spawnAgent)
4. Reference orchestrator.ts as existing pattern
