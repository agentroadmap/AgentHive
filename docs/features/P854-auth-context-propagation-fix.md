# P854 — Auth Context Propagation Fix: `_auth` Principal into `agentContextStorage` + Bearer Auth on HTTP Transport

**Status:** COMPLETE  
**Parent:** P843 (MCP Auth Middleware), P844 (Pool Gate)  
**Commit:** `d6e09e13`

---

## Overview

P843 wired `PrincipalVerifier` into `callTool()` so that the `_auth` envelope is verified and a `verifiedPrincipal` is resolved. P844 added a pool gate in `getProjectDb()` that reads `agentContextStorage.getStore()` to decide which tenant DB to open. P854 closes the two gaps that prevented these two systems from connecting on port 6421.

**Gap 1:** `callTool()` set `verifiedPrincipal` as a local variable but called `tool.handler(args)` outside any `agentContextStorage.run()` wrapper. `getProjectDb()` therefore always received `undefined` from the store when agents called through port 6421 with an `_auth` envelope.

**Gap 2:** `handleDirectMcpRequest()` in `http-compat.ts` dispatched `tools/call` without an `Authorization` header and without wrapping in `agentContextStorage.run()`. Operator callers on `POST /mcp` (port 6421) likewise got no auth context into the store.

The result was that P844's tenant-DB gate only fired on the board-server SSE path (port 6420, which already had bearer interception). Both gaps are now closed.

---

## Fix

### Part A — `callTool()` wraps handler when `_auth` envelope resolved

**File:** `src/apps/mcp-server/server.ts`

After the P843 identity gate verifies the `_auth` envelope and sets `verifiedPrincipal`, the handler dispatch now branches:

```typescript
// P854: _auth envelope path sets verifiedPrincipal but has no transport context;
// wrap handler so getProjectDb() P844 gate sees the principal.
const result = verifiedPrincipal && !ctx
  ? await agentContextStorage.run({ verified: verifiedPrincipal }, () => tool.handler(args))
  : await tool.handler(args);
```

The `!ctx` guard prevents redundant wrapping: when a transport handler (SSE bearer or `runWithBearerContext`) already populated the store before `callTool()` ran, `ctx` is non-null and the plain path is taken. The store is already live and `agentContextStorage.run()` would just create a redundant nested scope.

### Part B — `runWithBearerContext()` + `handleDirectMcpRequest()` wiring

**File:** `src/apps/mcp-server/server.ts` — new `runWithBearerContext()` method:

```typescript
async runWithBearerContext<T>(authHeader: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7) as BoundBearerToken;
    const res = verifyBoundBearer(token, this._getOperatorHmacSecret());
    if (res.ok && res.principal_id) {
      const principal: VerifiedPrincipal = {
        principal_id: res.principal_id,
        principal_kind: "operator",
        parent_principal_id: null,
      };
      return agentContextStorage.run({ verified: principal }, fn);
    }
  }
  return fn();
}
```

`principal_kind` is hardcoded `"operator"` for the HTTP bearer path — direct-HTTP callers are always operators, not agents (agents use the `_auth` envelope in Part A).

**File:** `src/apps/mcp-server/http-compat.ts` — `handleDirectMcpRequest()` now accepts `authHeader` and delegates through `runWithBearerContext`:

```typescript
const result = await server.runWithBearerContext(authHeader, () =>
  server.testInterface.callTool({ params: { name: toolName, arguments: toolArguments } }),
);
```

**File:** `scripts/mcp-sse-server.js` — passes `req.headers.authorization` through to close the last hop:

```javascript
const response = await handleDirectMcpRequest(sharedServer, req.body, req.headers.authorization);
```

---

## Authentication Flow After P854

### Agent calling via `_auth` envelope (port 6421, SSE):

```
callTool()
  → P843 gate: verify _auth envelope → verifiedPrincipal set, ctx = null
  → P854 Part A: agentContextStorage.run({ verified: verifiedPrincipal }, handler)
      → handler calls getProjectDb()
          → P844: agentContextStorage.getStore() returns { verified: { principal_kind: 'agent', ... } }
          → tenant DB resolved ✓
```

### Operator calling via bearer (port 6421, POST /mcp):

```
POST /mcp  Authorization: Bearer <token>
  → mcp-sse-server.js passes authHeader to handleDirectMcpRequest()
  → P854 Part B: server.runWithBearerContext(authHeader, fn)
      → verifyBoundBearer() succeeds
      → agentContextStorage.run({ verified: { principal_kind: 'operator', ... } }, fn)
          → callTool() runs; ctx already set → no re-wrap (plain path)
              → handler calls getProjectDb()
                  → P844 gate sees operator context ✓
```

---

## Testing

**File:** `tests/p854-context-propagation.test.ts` — 8 tests covering:

| Test | Assertion |
|---|---|
| Valid bearer | fn runs with `principal_id` and `principal_kind: 'operator'` set |
| Wrong HMAC secret | fn runs WITHOUT context (token rejected) |
| No header | fn runs WITHOUT context |
| Malformed header (no `Bearer` prefix) | fn runs WITHOUT context |
| Context teardown | Store is `undefined` after `fn` completes |
| Nested async visibility | `getStore()` inside `setTimeout(0)` returns the principal |
| Concurrent isolation | Two overlapping `agentContextStorage.run()` calls maintain independent contexts |

The concurrency test is particularly important: it validates that `AsyncLocalStorage` (Node.js CLS) correctly isolates overlapping async call stacks, which is the fundamental invariant P844 and P854 rely on.

---

## Related Proposals

| Proposal | Relationship |
|---|---|
| P472 | `PrincipalIdentityStore`, `verifyBoundBearer`, `issueBoundBearer` primitives |
| P843 | Wired `PrincipalVerifier` into `callTool()` — set up the gate but left `verifiedPrincipal` in a local variable |
| P844 | `getProjectDb()` tenant-DB pool gate — depends on `agentContextStorage` being populated; P854 is the fix that makes P844 work on port 6421 |
| P841 | Parent umbrella: holistic identity & trust infrastructure |
