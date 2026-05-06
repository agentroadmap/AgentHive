# Agent Access Control

This document describes the authentication and authorization layer for agents calling MCP tools in AgentHive. The system is **partially live** — transport auth and pool gating are enforced; per-agent budget enforcement is a Phase 3 stub.

---

## Status at a glance

| Layer | Proposal | Status |
|---|---|---|
| Bearer token verification (both transports) | P843 / P851 | **Live** |
| `_auth` envelope verification (agency/agent flow) | P843 | **Live** |
| `agentContextStorage` propagation | P843 | **Live** |
| Pool access gate (`getProjectDb`) | P844 | **Live** |
| Spawn env sanitization (`_SECRET`, `_PASSWORD`) | P845 | **Live** |
| Per-agent budget cap enforcement | P842 | **Stub** (Phase 3) |
| Project-level dispatch allowlist + budget | P484 | **Live** (dispatch path only) |

**Default mode:** log-only. Auth decisions are written to the DB but unauthenticated calls are not rejected. Set `P843_AUTH_ENFORCE_MCP=true` to switch to enforce mode.

---

## How it works

### 1. Identity carriers

There are two ways a caller proves identity to `callTool()`:

**A — HTTP Bearer token (operator callers)**

Operators call POST `/mcp` or connect via SSE. The `Authorization: Bearer <token>` header carries an HMAC-SHA256 bound bearer token issued by `issueBoundBearer()`.

```
Caller ──► POST /mcp
           Authorization: Bearer <rmk_p472 token>
           │
           ▼
     handleDirectMcp() / handleMcpMessage()
     verifyBoundBearer(token, operatorHmacSecret)
           │
           ▼ ok=true
     agentContextStorage.run({ verified: { principal_id, principal_kind: "operator" } })
           │
           ▼
       callTool()  ─── reads context from agentContextStorage
```

The HMAC secret is read from `OPERATOR_HMAC_SECRET` env var. If not set, a random 32-byte secret is generated at startup (tokens do not survive server restarts in that case).

Token format: `base64url(JSON payload) . HMAC-SHA256 signature`

Payload fields: `prefix="rmk_p472"`, `principal_id`, `issued_at`, `expires_at`, `nonce`.

Verification rejects: wrong signature, expired (beyond ±5 min clock skew), missing `principal_id`.

**B — Inline `_auth` envelope (agency / agent callers)**

Spawned agents call tools via JSON-RPC. They embed a `_auth` field in `params.arguments`:

```json
{
  "method": "tools/call",
  "params": {
    "name": "mcp_proposal",
    "arguments": {
      "_auth": {
        "principal_id": "agent:abc123",
        "token": "<HMAC session token>",
        "scope": ["proposal:read", "proposal:write"]
      },
      "action": "get",
      "args": { "id": "851" }
    }
  }
}
```

`callTool()` strips `_auth` from `args` before the handler sees it, then calls `principalVerifier.verify(envelope)` to check the HMAC session token and scope. Session tokens are derived at spawn time via `deriveAgentSessionToken()`.

---

### 2. `callTool()` gate sequence

Every tool call flows through this sequence (source: `src/apps/mcp-server/server.ts:321`):

```
callTool(request)
  │
  ├─ 1. Tool lookup — error if tool not registered
  │
  ├─ 2. P843 identity gate
  │     ├─ agentContextStorage has context?  → use it (operator bearer path)
  │     ├─ args._auth present?               → verify envelope (agency/agent path)
  │     └─ neither                           → "unauthenticated"
  │           log-only mode: proceed
  │           enforce mode (P843_AUTH_ENFORCE_MCP=true): throw [P843] No auth envelope
  │
  ├─ 3. P599 tool grant envelope check
  │     If a toolEnvelope is configured, the requested tool+op must be in the grant set.
  │     Agents spawned with restricted tool grants can only call their allowed tools.
  │
  └─ 4. handler(args) executes
```

Auth decisions (allowed / denied / unauthenticated) are written to the DB via `writeAuthDecisionLog()` at every step. Failures in that write are non-fatal.

---

### 3. Pool access gate (P844)

When any code calls `getProjectDb(slug)` to get a tenant database pool, the gate inspects the current `agentContextStorage` context:

```
getProjectDb("my-project")
  │
  ├─ ctx.verified.principal_kind === "agent"?
  │     YES → checkAgentProjectRole(principal_id, "my-project")
  │           queries: control_identity.agent_project_roles
  │           WHERE agent_principal_did = $1 AND project_slug = $2
  │           │
  │           ├─ row exists → allowed; audit log written; pool returned
  │           └─ no row (or DB failure) → PoolAccessDenied thrown
  │
  ├─ ctx.verified but not "agent" (operator / agency)?
  │     → allowed (bootstrap_passthrough); audit log written; pool returned
  │
  └─ no ctx at all?
        → allowed (no gate applied); pool returned
```

**`PoolAccessDenied`** message: `[P844] Pool access denied: agent <principal_id> has no role for project <slug>`

To grant an agent access to a project DB, insert a row into `control_identity.agent_project_roles`:

```sql
INSERT INTO control_identity.agent_project_roles (agent_principal_did, project_slug)
VALUES ('agent:my-agent-id', 'my-project');
```

All gate decisions are audited to `control_identity.pool_access_audit`. Audit write failures are non-fatal.

---

### 4. Spawn env sanitization (P845)

When the orchestrator spawns a child agent via `agent-spawner.ts`, any `extraEnv` passed by the caller is filtered through `sanitizeExtraEnv()` before being merged into the child process environment:

```typescript
sanitizeExtraEnv({ MY_SECRET: "x", API_PASSWORD: "y", SAFE_KEY: "z" })
// → { SAFE_KEY: "z" }
```

Keys matching `/_SECRET$/i` or `/_PASSWORD$/i` are stripped. Keys like `SECRETAIRE` (doesn't end in `_SECRET`) survive. This prevents credential leakage into child agent environments.

---

### 5. What is NOT yet enforced

**Per-agent budget caps (P842 — Phase 3 stub)**

`checkAgentBudget()` and `recordAgentSpend()` in `src/shared/dispatch/budget-check.ts` have empty bodies. The `BudgetExceededError` class exists (with correct name, `[P842]` message prefix, and `cap_type` property) but is never thrown automatically by `callTool()`. Budget enforcement at the agent level is gated on P484 completing.

**Project-level dispatch allowlist (P484)**

`evaluateDispatch()` in `src/shared/dispatch/allowlist-check.ts` implements route allowlist, capability scope, and project-level budget checks with atomic `SELECT...FOR UPDATE`. This runs on the dispatch path but is not invoked on every MCP tool call — it is a pre-dispatch gate for outbound agent calls, not an inbound tool call gate.

---

## Enforce mode

By default the system is in **log-only mode**: unauthenticated calls are logged but proceed. This is safe for development and for operators who haven't yet issued credentials.

To switch to **enforce mode**, set the environment variable before starting the server:

```bash
P843_AUTH_ENFORCE_MCP=true bun run server
```

In enforce mode:
- Calls with no `Authorization` header and no `_auth` envelope → `[P843] No auth envelope`
- Calls with an invalid or expired bearer token → bearer is not set; treated as no-auth
- Calls with a failing `_auth` envelope → `[P843] Auth denied: <reason>`

---

## Issuing operator tokens

```typescript
import { issueBoundBearer } from "./src/core/identity/principal-identity.ts";

const secret = Buffer.from(process.env.OPERATOR_HMAC_SECRET!, "hex");
const token = issueBoundBearer("op:my-operator", secret); // 1-hour TTL default
// Use as: Authorization: Bearer <token>
```

To verify a token (for debugging):

```typescript
import { verifyBoundBearer } from "./src/core/identity/principal-identity.ts";
const result = verifyBoundBearer(token, secret);
// { ok: true, principal_id: "op:my-operator" }
// { ok: false, reason: "token_expired" | "invalid_signature" | ... }
```

---

## Key source files

| File | Purpose |
|---|---|
| `src/core/identity/principal-identity.ts` | `issueBoundBearer`, `verifyBoundBearer`, `deriveAgentSessionToken` |
| `src/core/identity/principal-verifier.ts` | `PrincipalVerifier.verify()` — validates `_auth` envelopes |
| `src/shared/identity/agent-context.ts` | `agentContextStorage` (AsyncLocalStorage), `VerifiedPrincipal` |
| `src/apps/mcp-server/server.ts` | `callTool()` gate, `P843_AUTH_ENFORCE_MCP`, `writeAuthDecisionLog()` |
| `src/apps/server/index.ts` | `handleDirectMcp()`, `handleMcpMessage()` — bearer extraction + context setup |
| `src/postgres/pool-registry.ts` | `getProjectDb()` — P844 pool access gate |
| `src/infra/postgres/pool.ts` | `PoolAccessDenied` error class |
| `src/shared/dispatch/budget-check.ts` | `BudgetExceededError`, `checkAgentBudget()` (stub) |
| `src/shared/dispatch/allowlist-check.ts` | `evaluateDispatch()` — project-level dispatch gate |
| `src/core/orchestration/spawn-env-sanitizer.ts` | `sanitizeExtraEnv()` |
| `tests/p841-auth-merge.test.ts` | Integration tests for all live layers |
