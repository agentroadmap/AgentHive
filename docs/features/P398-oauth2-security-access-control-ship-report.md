# P398 Ship Report — OAuth2 Security & Access Control

**Status:** COMPLETE  
**Date:** 2026-05-09  
**Proposal:** P398 — OAuth2 Security & Access Control

---

## Summary

P398 delivers a complete, self-contained authentication and access-control stack for AgentHive agents. There is no external OAuth2 provider; agents are headless autonomous processes for which browser-redirect flows are inapplicable. Authentication is built on Ed25519 cryptographic identity (Node.js built-in `crypto`), stateless signed Bearer tokens, and a three-role RBAC system enforced at both the application and PostgreSQL layers.

---

## Implemented Components

### 1. Agent Identity & Authentication — `src/core/security/auth.ts`

**Authentication Provider**

Internal Ed25519 cryptographic identity. No external dependency. All primitives come from `node:crypto`.

**Token Format**

```
rmk_<base64url(payload)>.<base64url(Ed25519_sig)>
```

- Prefix `rmk_` (roadmap token) is stable; other prefixes may be added without collision.
- Payload fields: `agentId`, `issuedAt`, `expiresAt`, `keyVersion`, `nonce` (16-byte random, replay protection).
- Default TTL: 1 hour (`DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000`). Configurable via `AuthConfig.tokenTtlMs`.

**Session Storage**

Stateless HTTP layer — no session store, no Redis, no cookies. Every request carries a self-contained signed Bearer token. Identity files are stored at `.roadmap/auth/identity.json` (mode `0o600`).

**Key API surface**

| Method | Description |
|---|---|
| `AgentAuth.initializeIdentity(agentId)` | Generates Ed25519 key pair on first run; loads existing on subsequent runs |
| `AgentAuth.issueToken(agentId)` | Issues `rmk_` prefixed signed token |
| `AgentAuth.verifyToken(token)` | Returns `{ agentId, keyVersion }` or `null` |
| `AgentAuth.rotateKeys()` | Archives current key, generates new pair, increments `keyVersion` |
| `AgentAuth.logAudit(event)` / `flushAuditLog()` | Appends to in-memory log; flushes to `audit.jsonl` |
| `extractBearerToken(headers)` | Parses `Authorization: Bearer <token>` |
| `authenticateRequest(auth, headers)` | HTTP middleware wrapper |

**Key Rotation**

`rotateKeys()` archives the current key to `identity.v<N>.json`, generates a new Ed25519 pair, and increments `keyVersion`. Up to 3 versions are retained for grace-period verification of in-flight tokens. Zero downtime — tokens remain valid until their individual expiry timestamps.

**Audit Logging (auth layer)**

Append-only `audit.jsonl` per identity directory.  
Schema: `{ timestamp, agentId, action, resource, resourceId?, success, details?, keyVersion }`  
Events logged: `token_issued`, `token_verify` (success and failure), `key_rotation`.

---

### 2. RBAC Authorization — `src/core/security/authorization.ts`

**Role Hierarchy**

| Role | Permissions | Phase Access |
|---|---|---|
| `agent` | `proposal:read/claim/edit/complete` | explore, research, implement, complete |
| `reviewer` | agent + `proposal:revert`, `phase:review`, `audit:read` | + review |
| `admin` | reviewer + `proposal:delete/revert`, `phase:certify`, `admin:config/override`, `audit:read` | + certify |

**Enforcement**

- **Assignee check**: `checkProposalEdit()` — only the assigned agent may edit; `null` assignee = any agent with `proposal:edit` can claim. Admins bypass.
- **Phase-gate sequence**: `checkPhaseTransition()` — canonical order `explore → research → implement → review → certify → complete`. Phase skipping is rejected except `implement → complete` (allowed for non-critical proposals).
- **Auto-suspension**: `recordViolation()` auto-triggers `suspendAgent()` after 5 violations within a 60-minute window (configurable via `AccessPolicy.autoEscalate`).
- **Override rate limit**: Reviewers may use `checkProposalEdit()` override up to 3 times per hour; `adminOverride()` requires `admin` role and is fully logged.

**Persistence**

State files in configured `storageDir`:
- `roles.json` — role assignments
- `audit.json` — access control audit events
- `violations.json` — violation records
- `suspended.json` — active suspensions

**HTTP error signals**

- `HTTP 401` — token invalid, expired, or absent
- `HTTP 403` — RBAC denial or agent suspended

---

### 3. Database Security Layer — `src/core/security/db-security.ts`

SQLite-backed security layer for the file-to-database migration path (STATE-095 AC#5):

| Class | Tables | Purpose |
|---|---|---|
| `AuditTrail` | `audit_events` | Append-only event log; replaces git-log as authoritative audit source |
| `AccessControl` | `access_control` | Fine-grained resource + wildcard permission grants with revocation |
| `DataIntegrity` | `integrity_checks` | SHA-256 hash comparison between file and DB content |
| `AgentTokenStore` | `agent_tokens` | DB-backed token hash store; plaintext tokens are never persisted |

`AgentTokenStore` stores only HMAC of the token; `revokeAllForAgent()` supports emergency revocation on key compromise or suspension.

---

### 4. Credential Vault Schema — `database/ddl/hivecentral/005-credential.sql`

Schema `control_credential` in `hiveCentral`. Stores **metadata about secrets only** — never the secret values themselves.

| Table | Purpose |
|---|---|
| `vault_provider` | Registry of secret backends (`env`, `file`, `hcp_vault`, `aws_secrets`) |
| `credential` | Named secret references pointing to a vault path |
| `credential_grant` | Access grants per grantee (principal/agency/project/model_route) |
| `rotation_log` | **Append-only** rotation audit; DDL-level trigger prevents UPDATE/DELETE |

Views:
- `v_active_credentials` — active credentials with `rotation_overdue` flag
- `v_active_grants` — grants with `is_expired` flag

**Migration boundary:** `control_credential` schema co-exists in `agenthive@127.0.0.1:5432` until P429, which moves it to `hiveCentral`.

---

### 5. PostgreSQL Role Grants — migrations 007 and 022

**`scripts/migrations/007-agent-security-roles.sql`**

Three `NOLOGIN` roles:

| Role | Capabilities |
|---|---|
| `agent_read` | `SELECT` on all tables |
| `agent_write` | `agent_read` + `INSERT/UPDATE` on safe surfaces; **no DELETE on proposals** |
| `admin_write` | `agent_write` + `DELETE/TRUNCATE` on all tables |

Per-agent login users (`agent_andy`, `agent_bob`, `agent_carter`, `agent_gemini_one`, `agent_copilot_one`, `agent_gilbert`, `agent_skeptic`, `agent_openclaw_{alpha,beta,gamma}`) are granted `agent_write`.  
Destructive ops (DELETE on proposals, TRUNCATE, DROP) require explicit USER approval via the MCP destructive-op gate — not available to `agent_write` at the DB level.

**`scripts/migrations/022-schema-grants-agent-users.sql`**

Fixes a zero-access gap after the schema refactor (migrations 009–021) moved all tables from `public` to `roadmap`, `roadmap_proposal`, `roadmap_workforce`, `roadmap_efficiency`, `metrics`, `token_cache`. Grants `USAGE` on all schemas and extends `SELECT`/`INSERT`/`UPDATE` to the role hierarchy. `DEFAULT PRIVILEGES` ensures future tables created by `andy` inherit the same pattern.

---

## Local / Dev Mode

No external dependencies required. `initializeIdentity()` auto-creates identity on first call. The credential vault works with `env_var` or `file` provider types. To test fast expiry: set `tokenTtlMs: 5000` in `AuthConfig`.

---

## Test Coverage

| Test file | Covers |
|---|---|
| `tests/integration/auth.test.ts` | AC#1–5: key generation, token issuance, verification, audit events, key rotation; `extractBearerToken` middleware |
| `tests/integration/proposal-54-authorization.test.ts` | RBAC role permissions, assignee enforcement, phase-gate validation, admin override |
| `tests/integration/proposal-54-access-control.test.ts` | Additional access control surface tests |

---

## Rollback Procedure

| Component | Rollback |
|---|---|
| Identity compromise | Restore `identity.v<N>.json`, call `rotateKeys()` to reissue |
| RBAC state | Edit `roles.json` / `suspended.json` / `violations.json` in `storageDir` |
| DB roles | `REVOKE agent_write FROM agent_<name>;` in psql |
| Credential grants | `UPDATE control_credential.credential_grant SET expires_at = now() WHERE ...` |

---

## Migration / Compatibility Notes

- `access-control.ts` is **legacy**; `authorization.ts` (STATE-54) is canonical.
- Token prefix `rmk_` is stable; additional prefixes may be added without collision.
- Adding new agents: add a migration row in `008-create-agent-users.sql` + `GRANT agent_write TO agent_<name>`.
- `control_credential` schema moves to `hiveCentral` post-P429; code path: `config.getProjectDb('hivecentral')`.

---

## Operator-Visible Failure Signals

| Signal | Meaning |
|---|---|
| `HTTP 401` | Token absent, malformed, expired, or signature invalid |
| `HTTP 403` | RBAC role lacking permission, or agent suspended |
| `CredentialAccessError` | Typed error code from credential client; vault path never leaked in message |
| `PostgreSQL: permission denied` | Agent user missing DB role — check migration 007/022 applied |
| `Agent is suspended` reason on `AccessCheckResult` | Auto-suspension triggered by violation threshold |
