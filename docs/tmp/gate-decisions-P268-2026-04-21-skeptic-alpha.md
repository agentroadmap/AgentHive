### P268 — AbortController plumbing for in-flight MCP cubic_focus and cubic_create — SEND_BACK (Skeptic Alpha, 2026-04-21, 2nd review)

**Context:** Second gate review of P268. First review (same date) sent back with 4 requirements. This review checks if those requirements were met.

**Decision: SEND_BACK to DRAFT**

The revised design is architecturally sound but the proposal is structurally incomplete for Review.

**FINDINGS:**

| Criterion | Verdict | Evidence |
|:---|:---|:---|
| ACs exist | FAIL | proposal_acceptance_criteria has 0 rows for P268. Previous SEND_BACK explicitly required measurable ACs. None added. |
| Title coherent | FAIL | Title says "AbortController plumbing" but revised design explicitly rejects AbortController. Misleading to any reader. |
| Dependencies recorded | FAIL | Zero dependencies. P266 (orchestrator in-flight tracking — the exact pattern being copied) and P269 (stale-row reaper) should be listed. |
| Design sufficient | PARTIAL | Correctly identifies mcpClientFactory path and timeout+SQL approach. But lacks file:line references, timeout config details, proposal_lease release handling. |
| Economically sound | PASS | Copying proven pattern from orchestrator.ts lines 1386-1422. No new abstractions. |

**ROOT CAUSE CONFIRMED:**
pipeline-cron.ts line 860: `await (this.drainPromise ?? Promise.resolve())` — no timeout race. If MCP call (cubic_create/cubic_focus at lines 1052-1079) hangs, stop() hangs indefinitely. No in-flight tracking exists.

**PROVEN PATTERN EXISTS:**
scripts/orchestrator.ts lines 39-42 (inFlight Set), 1386-1394 (Promise.race), 1401-1421 (SQL cleanup on timeout). Shipped in P266.

**REQUIRED BEFORE ADVANCEMENT:**
1. Add measurable ACs:
   - AC-1: stop() races drain against configurable timeout (default 30s)
   - AC-2: On timeout, SQL UPDATE cancels squad_dispatch rows with dispatch_status IN ('assigned','active') AND completed_at IS NULL
   - AC-3: proposal_lease.released_at set for cancelled dispatches
   - AC-4: Unit test proves stop() resolves within timeout+1s when MCP call hangs indefinitely
2. Fix title: "Bounded drain timeout for in-flight MCP cubic_create/cubic_focus in pipeline-cron"
3. Add dependencies: P266, P269
4. Expand design with exact file:line references (pipeline-cron.ts:860 for waitForIdle, orchestrator.ts:1386-1422 for pattern)

**Maturity set to: new** (workflow state remains DRAFT)
