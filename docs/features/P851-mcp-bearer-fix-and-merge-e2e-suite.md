# P851 — P841 Follow-up: POST /mcp Bearer Wiring Fix + MERGE e2e Test Suite

**Status:** COMPLETE  
**Parent:** P841 (Identity & Trust Infrastructure)  
**Scope:** Two targeted fixes found during P841 code review — not a feature extension.

---

## Overview

P841 shipped P843 (MCP auth middleware) and P844 (project pool gate) in COMPLETE state, but the code review found two gaps that were missed before advancement:

1. **Bearer token was silently ignored on `POST /mcp`** — `handleDirectMcp()` in `src/apps/server/index.ts` had a `TODO` block instead of the same 4-line bearer verification pattern used in `handleMcpMessage()`. In log-only mode, operator tokens were accepted but never resolved to a principal (so audit rows showed `unauthenticated`). In enforce mode, *all* `POST /mcp` calls were rejected because no principal was ever set.

2. **Seven of eight MERGE ACs had no test file** — P841's MERGE checklist listed 8 ACs across P843, P844, and P842; only one had an existing test. This left the identity gate untested end-to-end.

P851 applies the bearer fix and writes the missing test suite. P841 stays COMPLETE; this proposal does not reopen the umbrella or any child.

---

## Fix: `handleDirectMcp()` Bearer Verification

**File:** `src/apps/server/index.ts`, `handleDirectMcp()` method

### Before (gap)

The method parsed the `Authorization` header but stopped short of resolution — a `TODO` placeholder left `verifiedPrincipal` as `null` unconditionally. The handler then called `handleDirectMcpRequest()` without wrapping it in `agentContextStorage.run()`, so `callTool()` received no transport context.

### After (fixed, lines 1317–1345)

```typescript
// P843: Extract and verify operator bearer token if present
let verifiedPrincipal: VerifiedPrincipal | null = null;
const authHeader = req.headers.get("Authorization");
if (authHeader?.startsWith("Bearer ")) {
  const token = authHeader.slice(7);
  const hmacSecret = this._getOperatorHmacSecret();
  const result = await verifyBoundBearer(token, hmacSecret);
  if (result.ok && result.principal_id) {
    verifiedPrincipal = {
      principal_id: result.principal_id,
      principal_kind: "operator",
      parent_principal_id: null,
    };
  }
}

const callHandler = async () =>
  handleDirectMcpRequest(this.mcpServer as McpServer, payload);

const response = verifiedPrincipal
  ? await agentContextStorage.run({ verified: verifiedPrincipal }, () => callHandler())
  : await callHandler();
```

**Key invariants preserved:**

- `verifyBoundBearer` was already imported at line 37 — no new imports.
- `_getOperatorHmacSecret()` was already available in the class — no new dependencies.
- `agentContextStorage.run()` wraps the handler only when a principal was resolved, matching the pattern in `handleMcpMessage()` (line 3975).
- Agency and agent callers are unaffected: they embed `_auth` in JSON-RPC `params.arguments`; the bearer path is operator-only.
- An invalid or missing token falls through to `verifiedPrincipal = null`, leaving the request unauthenticated (passes in log-only mode, throws in enforce mode — same as `handleMcpMessage()`).

---

## Test Suite: `tests/e2e/p841-auth-merge.test.ts`

Target file: `tests/e2e/p841-auth-merge.test.ts`

This file provides the missing MERGE coverage for P841. It exercises the live identity gate stack end-to-end: HTTP transport → `callTool()` gate → P844 pool gate → P842 budget middleware.

### Test Inventory

| Test | AC | Scenario | Assertion |
|---|---|---|---|
| `T1` | P843-AC-6 | `POST /mcp` without `Authorization` header, enforce mode on | HTTP 200 with `error.message` containing `[P843] No auth envelope` |
| `T2` | P843-AC-7 | `restricted` tier token calls `prop_create` (write-category tool) | `callTool()` throws `[P843] Auth denied` before handler executes |
| `T3` | P843-AC-8 | `authority` tier token calls any registered tool | Handler executes; audit log row with `decision = 'allowed'` |
| `T4` | P844-AC-1 | Trusted agent calls `getProjectDb()` with an assigned project slug | Returns pool handle; `pool_access_audit` row with `decision = 'allowed'` |
| `T5` | P844-AC-2 | Trusted agent calls `getProjectDb()` with an unassigned project slug | Throws `PoolAccessDenied`; `pool_access_audit` row with `decision = 'denied'` |
| `T6` | P842-AC-1 | Agent with `cap = 0` in `agent_budgets` triggers any tool call | Throws `BudgetExceededError` before handler executes |
| `T7` | P841-MERGE | Regression sweep — board API, orchestrator dispatch, CLI smoke | No `[P843]` / `[P844]` / `[P842]` errors appear in log-only mode traffic |

### Setup Pattern

```typescript
import assert from 'node:assert';
import { describe, before, after, it } from 'node:test';
import {
  issueBoundBearer,
  verifyBoundBearer,
} from '../../src/core/identity/principal-identity.ts';
import { agentContextStorage } from '../../src/shared/identity/agent-context.ts';
import { setupTwoTier, type TwoTierHandles } from '../_helpers/two-tier-db.ts';

const ENFORCE = { P843_AUTH_ENFORCE_MCP: 'true' };

describe('P841 MERGE — identity gate e2e', () => {
  let handles: TwoTierHandles;

  before(async () => {
    handles = await setupTwoTier({
      controlSchemas: ['control_identity', 'roadmap'],
      tenantSeeds: [{ slug: 'test-project' }],
    });
  });

  after(async () => handles.cleanup());

  // T1 — unauthenticated POST /mcp rejected in enforce mode
  it('T1: POST /mcp without auth → error in enforce mode', async () => {
    process.env.P843_AUTH_ENFORCE_MCP = 'true';
    try {
      // ...call handleDirectMcpRequest() with no Authorization header
      // assert response body contains [P843] No auth envelope
    } finally {
      delete process.env.P843_AUTH_ENFORCE_MCP;
    }
  });

  // T2–T3 — tier-based callTool() access
  // T4–T5 — getProjectDb() pool gate
  // T6 — budget cap
  // T7 — regression sweep in log-only mode
});
```

### P843 Tests (T1–T3): Enforce-Mode Toggle

- Set `process.env.P843_AUTH_ENFORCE_MCP = 'true'` in a `before`/`beforeEach` hook and restore in `after`/`afterEach`.
- Issue real tokens via `issueBoundBearer(principal_id, hmacSecret)` — the same function used in production.
- Call `POST /mcp` with a constructed JSON-RPC body directly against the live HTTP handler (or call `callTool()` with a pre-populated `agentContextStorage`).
- Assert HTTP status or thrown error message contains the expected `[P843]` prefix.

For tier restriction (T2): seed a principal with `tier = 'restricted'` in `control_identity.principal_identity`; issue its bearer token; call a `write` category tool; assert the gate throws before the handler DB write occurs (verify by checking the handler's table is unchanged).

### P844 Tests (T4–T5): Pool Gate

- Seed `agent_project_roles` with `(agent_id, project_slug = 'test-project', role = 'reader')`.
- Set `agentContextStorage` with a matching `principal_id` via `agentContextStorage.run(...)`.
- Call `getProjectDb('test-project')` → expect a pool handle (no throw).
- Call `getProjectDb('other-project')` (not seeded) → expect `PoolAccessDenied`.
- After each call, query `pool_access_audit` and assert the `decision` column matches.

### P842 Tests (T6): Budget Cap

- Seed `agent_budgets` with `(principal_id, max_usd_cents = 0, current_spent_usd_cents = 0)`.
- Set `agentContextStorage` with that `principal_id`.
- Trigger any tool call that passes through `checkAgentBudget()`.
- Assert `BudgetExceededError` is thrown and the handler never modifies any table.

### P841-MERGE Regression Sweep (T7)

Run the existing board API, orchestrator dispatch, and CLI smoke tests without `P843_AUTH_ENFORCE_MCP=true`. Collect `control_identity.auth_decision_log` entries after each test block. The sweep passes if:

- No calls that should be unauthenticated appear in the log as `denied`.
- No new test-generated rows appear as `unauthenticated` in a context that provides credentials.

This confirms that log-only mode does not break existing callers while enforcement infrastructure is in place.

---

## Scope Boundary

| In scope | Out of scope |
|---|---|
| 4-line bearer wiring in `handleDirectMcp()` | P841 re-opening or scope changes |
| 7 missing MERGE e2e tests | Agent credential hardening (Ed25519 upgrade — deferred post P843 enforcement) |
| `P843_AUTH_ENFORCE_MCP` toggle correctness | New auth credential types |
| `pool_access_audit` and budget-cap assertion | Phase 3 `checkAgentBudget()` implementation (gated on P484) |

---

## Migration History

No new migrations. All tables (`control_identity.auth_decision_log`, `pool_access_audit`, `agent_budgets`, `agent_project_roles`) were created by P843, P844, and P842 respectively.

---

## Related Proposals

| Proposal | Relationship |
|---|---|
| P841 | Umbrella — identity & trust infrastructure; P851 is a post-review fix, not a new phase |
| P843 | Shipped the `callTool()` identity gate and `handleMcpMessage()` bearer path; P851 patches the missing `handleDirectMcp()` path |
| P844 | `getProjectDb()` principal gate — verified end-to-end by T4/T5 in this suite |
| P842 | Hard budget enforcement — verified end-to-end by T6 in this suite |
| P472 | Provides `issueBoundBearer()` / `verifyBoundBearer()` primitives used in tests |
| P599 | Tool grant envelope check — runs after the P843 gate; not re-tested here (covered in P599 unit tests) |
