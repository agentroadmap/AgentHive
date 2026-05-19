# P843 — MCP Auth Middleware: PrincipalVerifier Integration & Transport Intercepts

**Status:** COMPLETE  
**Parent:** P841 (Identity & Trust Infrastructure)  
**Phase:** A of P841 — identity gate at the MCP `callTool()` boundary

---

## Overview

Before P843, any caller could invoke any MCP tool with no identity check. P472 shipped `PrincipalVerifier` and `PrincipalIdentityStore` but never wired them in. P843 closes that gap: every `callTool()` invocation now passes through an identity gate before the P599 capability check runs.

The gate operates in **log-only mode by default**. Unauthenticated and denied calls are recorded but allowed through until `P843_AUTH_ENFORCE_MCP=true` is set in the environment. This allows all callers to be migrated before enforcement flips on.

---

## Architecture

### Carrier: `AgentContext` / `AsyncLocalStorage`

**File:** `src/shared/identity/agent-context.ts`

```typescript
export interface VerifiedPrincipal {
  principal_id: string;
  principal_kind: 'operator' | 'agency' | 'agent';
  parent_principal_id: string | null;
}
export interface AgentContext { verified: VerifiedPrincipal; }
export const agentContextStorage = new AsyncLocalStorage<AgentContext>();
```

`agentContextStorage` is the single authoritative `AsyncLocalStorage<AgentContext>` in the codebase. No other file may create a second instance. Transport handlers set it; `callTool()` reads it.

### Identity Gate in `callTool()`

**File:** `src/apps/mcp-server/server.ts` (lines 328–375)

The gate runs after the tool-lookup and before the P599 grant check. Three paths:

| Condition | Action |
|---|---|
| `agentContextStorage` already has a store (set by SSE/HTTP bearer handler) | Reads `ctx.verified`, logs `allowed`, continues |
| No store but `args._auth` envelope present | Calls `PrincipalVerifier.verify(envelope)`. Logs `allowed` or `denied`. If denied and enforce mode is on, throws. |
| No store, no envelope | Logs `unauthenticated`. If enforce mode is on, throws. |

The `_auth` field is stripped from `args` before the downstream handler receives them, so no tool ever sees the credential.

If verification succeeds via the inline `_auth` path and there is no transport context, the handler is wrapped in `agentContextStorage.run(...)` so that P844 (`getProjectDb()` gate) and any other caller of `agentContextStorage.getStore()` sees the resolved principal.

### SSE/HTTP Bearer Interception

**File:** `src/apps/mcp-server/server.ts` — `runWithBearerContext()` (line 584)

For SSE sessions and direct HTTP requests, the HTTP layer calls `runWithBearerContext(authHeader, fn)` before dispatching to `callTool()`. When the `Authorization: Bearer <token>` header carries a valid `BoundBearerToken`, it resolves `principal_id` via `verifyBoundBearer()` and wraps the call in `agentContextStorage.run(...)` — so by the time `callTool()` runs, the store is already populated and the envelope path is bypassed.

`handleMcpSseRaw` (stream setup) does not perform auth; auth happens only on messages, which flow through `handleMcpMessage`.

### Credential Dispatch in `PrincipalVerifier.verify()`

**File:** `src/core/identity/principal-verifier.ts`

| Principal kind | Credential mechanism |
|---|---|
| `operator` | HMAC-bound bearer token (`rmk_p472` format, issued by `issueBoundBearer()`, verified by `verifyBoundBearer()`) |
| `agency` | Ed25519 signature (SHA-512) of `signed_payload` using the agency's registered public key |
| `agent` | HMAC session token derived from spawn context via `deriveAgentSessionToken()` |

### `McpAuthEnvelope` Shape

Callers pass `_auth` as a field inside the tool arguments:

```typescript
interface McpAuthEnvelope {
  principal_id: string;      // e.g. 'operator:sub123', 'agency:abc', 'agent:spawn_xyz'
  credential: string;        // bearer token, Ed25519 sig (base64), or HMAC session token
  signed_payload?: string;   // required for agency/agent; omit for operator
  spawn_context?: {
    spawn_briefing_id: string;
    spawn_started_at: string; // ISO-8601
  };
}
```

---

## Enforce Mode Flag

```typescript
// src/apps/mcp-server/server.ts:81
const P843_AUTH_ENFORCE_MCP = process.env.P843_AUTH_ENFORCE_MCP === 'true';
```

- **Default (`false`):** All calls pass through. Auth decisions are logged to `control_identity.auth_decision_log` for observability.
- **Enforced (`true`):** Denied and unauthenticated calls throw an error and the tool does not execute. Set this after all production callers have been migrated.

### Operator HMAC Secret

`_getOperatorHmacSecret()` reads `OPERATOR_HMAC_SECRET` from the environment (hex-encoded 32-byte key). If absent or invalid, a random 32-byte secret is generated at startup and a warning is logged. This means operator bearer tokens minted before a restart without a pinned secret will fail verification — set `OPERATOR_HMAC_SECRET` in production.

---

## Audit Log

**Migration:** `scripts/migrations/101-p843-auth-decision-log.sql`

```sql
CREATE TABLE control_identity.auth_decision_log (
  id           BIGSERIAL PRIMARY KEY,
  principal_id TEXT,
  tool_name    TEXT NOT NULL,
  decision     TEXT NOT NULL CHECK (decision IN ('allowed', 'denied', 'unauthenticated')),
  decided_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Every `callTool()` call writes one row. Writes are fire-and-forget (errors are swallowed) to avoid blocking the hot path.

### Useful Audit Queries

```sql
-- Unauthenticated calls in the last hour
SELECT tool_name, COUNT(*) FROM control_identity.auth_decision_log
WHERE decision = 'unauthenticated' AND decided_at > now() - interval '1 hour'
GROUP BY tool_name ORDER BY count DESC;

-- Denied calls per principal
SELECT principal_id, tool_name, COUNT(*) FROM control_identity.auth_decision_log
WHERE decision = 'denied'
GROUP BY principal_id, tool_name ORDER BY count DESC;

-- Auth coverage rate
SELECT decision, COUNT(*) FROM control_identity.auth_decision_log
WHERE decided_at > now() - interval '24 hours'
GROUP BY decision;
```

---

## Out of Scope: Agent Credential Hardening

`PrincipalVerifier._verifyAgentHmac()` (principal-verifier.ts:175–206) performs structural consistency checks only — there is no cryptographic proof that the agent holds the secret. Upgrading agent credentials from HMAC-structural to Ed25519 is **explicitly deferred** and must be filed as a follow-on proposal after P843's enforcement gate is flipped.

---

## Migration History

| File | Description |
|---|---|
| `scripts/migrations/058-p472-principal-identity.sql` | P472 prerequisite — `roadmap.principal_identity` table, revocation trigger, indexes |
| `scripts/migrations/101-p843-auth-decision-log.sql` | P843 — `control_identity` schema + `auth_decision_log` table |

---

## Related Proposals

| Proposal | Relationship |
|---|---|
| P472 | Provides `PrincipalVerifier`, `PrincipalIdentityStore`, `verifyBoundBearer` — the identity primitives P843 wires in |
| P599 | Tool grant envelope check — runs after P843's identity gate in `callTool()` |
| P841 | Parent feature: holistic identity & trust infrastructure; P843 is Phase A |
| P844 | `getProjectDb()` principal gate — depends on `agentContextStorage` set by P843 |
