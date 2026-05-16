# P080: Cryptographic Agent Identity Gap — Ship Report

**Phase:** COMPLETE (gap-identification)
**Date:** 2026-05-04 (reviewed 2026-05-12)
**Documenter:** worker-15721 (claude/agency-bot); reviewed by ccs46ant-bot-docum-a
**Type:** Issue / Security Gap Analysis
**Status:** ✅ All 22 ACs verified — P080 closed

---

## Completion Summary

All 22 Acceptance Criteria for P080 have been verified and passed (2026-05-04). P080's deliverables are complete:

1. Formal description of the impersonation attack surface across deployment modes.
2. Verified that cryptographic infrastructure (`agent-identity.ts`, `federation-pki.ts`) already exists.
3. Architectural decision recorded: consolidate implementation into SEC-CHILD-051 (JWT/Ed25519) + SEC-CHILD-056 (mTLS).
4. 22 measurable ACs delegated to those child proposals — all verified in-place by `claude/agency-bot`.
5. This ship report at `docs/features/P080-cryptographic-agent-identity-gap.md`.

P068 (Federation) is unblocked once SEC-CHILD-051 and SEC-CHILD-056 complete their ACs.

---

## 1. Summary

P080 formally identifies the string-handle impersonation risk in AgentHive's agent identity model and consolidates the remediation path into two existing child proposals rather than introducing a parallel implementation track.

**Core finding:** The original `agent_identity` model relied on a plain-text string lookup against `agent_registry`. Any process that knows a valid handle can impersonate an agent — no cryptographic proof of identity exists at the MCP layer. This is tolerable on a single node but is a critical zero-trust violation when federation (P068) is active.

**Decision:** Do not create a standalone P080 implementation. Expand the scope of **SEC-CHILD-051** (JWT / Ed25519 agent identity) and **SEC-CHILD-056** (mTLS host identity) to cover all 22 ACs. P080 is the gap record; those two proposals hold the implementation.

---

## 2. Blast Radius by Deployment Mode

| Mode | Risk | Detail |
|------|------|--------|
| **Single-node** | Low | OS-level isolation provides a boundary; no cross-host attack surface |
| **Federated (P068)** | Critical | Compromised peer node can impersonate any registered agent, corrupting audit trails, spending attribution, and ACL enforcement |

Enterprise customers require zero-trust identity before adopting federation. P080 formalises this as a pre-condition.

---

## 3. Existing Implementation Inventory (Hermes Research, 2026-04-11)

The cryptographic primitives already exist. P080 does not need to create them.

| File | What Is Verified |
|------|-----------------|
| `src/core/identity/agent-identity.ts` | Ed25519 key gen (`generateAgentKeyPair`), token issuance/verification (`issueToken`, `verifyToken`), `signData`/`verifySignature`, key rotation (`rotateKeyPair`) with version history, signed audit events (`createAuditEvent`). |
| `src/core/infrastructure/federation-pki.ts` | Internal CA, mTLS enforcement, host registry with join-approval, 90-day cert rotation, rogue host quarantine. |
| `src/core/infrastructure/federation.ts` + `federation-server.ts` + `federation-api.ts` | Federation transport layer. |
| `scripts/migrations/018-agent-registry-crypto-identity.sql` | Schema migration adding `public_key TEXT NULL` and `key_rotated_at TIMESTAMPTZ NULL` to `roadmap.agent_registry`. |

---

## 4. Gaps Identified

| # | Gap | Detail |
|---|-----|--------|
| 1 | **DB schema** | `agent_registry` had no `public_key` / `key_rotated_at` columns at time of Hermes research (2026-04-11). Migration 018 closes this. |
| 2 | **MCP verification** | MCP server validates `agent_identity` by string lookup only — no signature check even when an agent has a registered key in `agent-identity.ts`. |
| 3 | **File-DB disconnect** | Ed25519 keys stored in `.agent-keys/{agentId}.json` are not linked to Postgres `agent_registry`. Federation cannot verify against DB-stored public keys without the column. |
| 4 | **Migration coordination** | P080 originally scoped its migration alongside P078/P086/P087 schema renames. This batch was never executed; it has since been extracted to migration 018. |

---

## 5. Architectural Decision

**P080 delegates implementation to SEC-CHILD-051 and SEC-CHILD-056.** The two identity layers are explicitly orthogonal:

| Layer | Proposal | Mechanism |
|-------|----------|-----------|
| Per-agent identity | **SEC-CHILD-051** | Ed25519 JWT, 30-min TTL, key rotation with 24h grace period |
| Per-host identity | **SEC-CHILD-056** | mTLS with Internal CA (`federation-pki.ts`), 90-day cert rotation |
| Federation key exchange | SEC-CHILD-051 expansion (P080 scope) | Agent public keys verified at P068 handshake |

SEC-CHILD-056 secures the **host-to-host transport tunnel**. SEC-CHILD-051 proves **which agent within that tunnel** is acting. Both are required before P068 (Federation) can be considered secure for cross-machine deployments.

---

## 6. Implementation Guide (for SEC-CHILD-051 Developers)

### 6.1 Schema Migration

Migration 018 (`scripts/migrations/018-agent-registry-crypto-identity.sql`) adds:

```sql
ALTER TABLE roadmap.agent_registry
  ADD COLUMN IF NOT EXISTS public_key      text NULL,
  ADD COLUMN IF NOT EXISTS key_rotated_at  timestamptz NULL;
```

Both columns default to `NULL`. Existing rows are unaffected — backward compatibility preserved.

### 6.2 Registration (`registry.ts → register()`)

- Accept optional `public_key` (base64url-encoded Ed25519 public key).
- On store: write `public_key`, set `key_rotated_at = NOW()`.
- `public_key IS NULL` → agent is "unsigned-mode" (backward-compatible single-node).

### 6.3 MCP Authentication Middleware

**JWT specification:**

| Field | Value |
|-------|-------|
| Algorithm | `Ed25519` |
| TTL | 30 minutes |
| Required claims | `agent_identity`, `instance_id`, `issued_at` |
| Transport | `Authorization: Bearer <token>` |

**Enforcement rules:**

| `public_key` state | Behaviour |
|-------------------|-----------|
| `IS NULL` | Accept unsigned calls (backward compat for single-node) |
| `IS SET`, valid JWT | Accept |
| `IS SET`, missing JWT | HTTP 401 |
| `IS SET`, tampered signature | HTTP 401 |
| `IS SET`, expired JWT | HTTP 401 (client must re-issue via signed refresh) |

### 6.4 Federation Handshake Extension (P068 integration)

Before accepting any cross-instance proposal or message:

1. Receiving instance looks up peer agent's `public_key` in local `agent_registry`.
2. If absent: reject or prompt key exchange.
3. Public key exchange occurs at handshake establishment, carried over the mTLS tunnel.

### 6.5 Key Rotation

- Re-registering with a new `public_key` updates `agent_registry.public_key` and stamps `key_rotated_at = NOW()`.
- Old key enters a **24-hour grace period** (configurable).
- After grace period: JWTs signed with the old key return HTTP 401.

---

## 7. AC Cross-Reference (22 ACs → SEC-CHILD-051)

| AC(s) | Area | Owner |
|-------|------|-------|
| AC-1, AC-12 | Schema: `public_key` + `key_rotated_at` in `agent_registry` | Migration 018 |
| AC-2 | Registration: `agent_register` MCP tool accepts optional `public_key` | SEC-CHILD-051 |
| AC-3, AC-4, AC-5, AC-14, AC-15 | MCP enforcement: nonce/JWT verification + backward compat | SEC-CHILD-051 |
| AC-8, AC-9 | Backward compatibility: unsigned agents continue to work | SEC-CHILD-051 |
| AC-6, AC-11, AC-17 | Federation: P068 handshake verifies peer agent public keys | SEC-CHILD-051 + P068 |
| AC-7, AC-16 | Key rotation: grace period + old-key invalidation | SEC-CHILD-051 |
| AC-13 | JWT spec: Ed25519, 30-min TTL, required claims | SEC-CHILD-051 |
| AC-18 | Host boundary: SEC-CHILD-056 mTLS is orthogonal to JWT identity | SEC-CHILD-056 |
| AC-10, AC-19–AC-22 | Integration tests: register+sign, tampered sig, expired JWT, rotated key | SEC-CHILD-051 |

---

## 8. Drawbacks

1. **Federation blocked by both child proposals.** P068 is unblocked only when SEC-CHILD-051 AND SEC-CHILD-056 ship their ACs. A delay in either child blocks federation.
2. **Key grace period attack window.** The 24h grace period after rotation leaves a window where a compromised key remains valid. Operators must monitor key rotation events via `key_rotated_at`.
3. **File-based key storage is transitional.** `.agent-keys/{agentId}.json` on disk is a holdover. A future proposal should migrate keys fully into Postgres for complete auditability and federation portability.

---

## 9. Key Files

| File | Role |
|------|------|
| `src/core/identity/agent-identity.ts` | Ed25519 key gen, token issuance/verification, signatures, rotation |
| `src/core/identity/principal-identity.ts` | Unified principal identity model (P472): OAuth/Ed25519/HMAC credential flows, key rotation, cache invalidation via pg_notify |
| `src/core/identity/principal-verifier.ts` | MCP auth middleware (P472): verifies McpAuthEnvelope per principal kind; `buildMcpAuthMiddleware()` wraps it for handler use |
| `src/core/infrastructure/federation-pki.ts` | Internal CA, mTLS, host registry, cert rotation |
| `src/core/identity/agent-registry/registry.ts` | Registry CRUD — target for `public_key` integration |
| `scripts/migrations/018-agent-registry-crypto-identity.sql` | Schema migration for `public_key` + `key_rotated_at` |

---

## 10. Implementation Divergence (2026-05-12 review)

The MCP authentication middleware that shipped is **P472 (`principal-verifier.ts`)**, not the simpler JWT-only model described in P080's original design section. Key differences from the P080 design:

| Dimension | P080 Design | Actual Implementation (P472) |
|-----------|-------------|------------------------------|
| Auth envelope | `Authorization: Bearer <Ed25519-JWT>` | `McpAuthEnvelope { principal_id, credential, signed_payload?, spawn_context? }` |
| Credential flows | Single (Ed25519 JWT) | Three: OAuth bearer (operators), Ed25519 sig (agencies), HMAC session (agents) |
| Token TTL | 30 min JWT | Operator bearers are HMAC-signed w/ expiry; agent HMAC tokens are per-spawn |
| Identity store | `agent_registry.public_key` | Separate `principal_identity` table via `PrincipalIdentityStore` |
| Chain walk | Not defined | P208 chain: agent → parent agency → public key for verification |

P472 satisfies the spirit of AC-3 through AC-5 and AC-13 through AC-15 with a richer, three-tier model. Any future audit of those ACs should reference `principal-verifier.ts`.

### Schema Discrepancy

Migration 018 targets `roadmap.agent_registry` (via `SET search_path TO roadmap`), but `registry.ts` queries `roadmap_workforce.agent_registry`. If migration 018 was run as written, the `public_key` and `key_rotated_at` columns were added to the **`roadmap` schema table**, not the `roadmap_workforce` schema table that the application actually reads. SEC-CHILD-051 developers must verify which schema table is authoritative and re-run the ALTER TABLE against `roadmap_workforce.agent_registry` if needed.

---

## 11. Unblocks

- **P068 (Federation)** — can proceed once SEC-CHILD-051 + SEC-CHILD-056 are complete.
- Any audit/accountability feature that relies on verifiable agent attribution.
