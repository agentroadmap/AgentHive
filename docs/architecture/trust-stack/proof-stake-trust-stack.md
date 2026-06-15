---
proposal: P2997
parent: P2995
title: "Agent Identity Trust Stack — Proof (existing) + Stake (new)"
status: DEVELOP
---

# Agent Identity Trust Stack: Proof + Stake

P2997 operationalizes the P2995-AC2 trust research. After D2 rescope it builds
**only** the net-new **Stake / capability-bond** layer and wires the
**already-existing Proof layer** into more chokepoints. **No new proof tables or
columns are introduced.**

## AC-1 / AC-5 — Map current Brief/Claim signals; audit the EXISTING Proof layer

### Current trust signals (Brief/Claim model — what already exists)

| Signal | Surface | Meaning | Lifetime |
| :--- | :--- | :--- | :--- |
| Registry row | `roadmap_workforce.agent_registry` (`agent_identity` UNIQUE) | the agent exists / is known | durable |
| Heartbeat / presence | `fn_pulse` → presence state, `pulse` MCP action | the agent is alive now | transient (TTL) |
| Session / lease | `roadmap.prop_leases`, `worktree_lease` | the agent holds work | transient (TTL) |
| Work claim | `fn_claim_work_offer` / `squad_dispatch` | the agent took a specific offer | per-offer |
| Crypto identity (**Proof**) | `agent_registry.public_key`, `key_rotated_at` (**migration 018**) | the agent can prove key ownership | durable, rotatable |

### EXISTING Proof layer — audited, reused as-is (P2997 adds nothing here)

| Component | File | Role |
| :--- | :--- | :--- |
| Crypto columns | `scripts/migrations/018-agent-registry-crypto-identity.sql` | `public_key` (Ed25519, hex), `key_rotated_at` on `agent_registry` |
| Key mgmt | `src/core/identity/agent-identity.ts` | `generateAgentKeyPair`, `signData`, `verifySignature`, `rotateKeyPair`, `issueToken`/`verifyToken` |
| Verification middleware | `src/core/identity/identity-verification.ts` | `verifyAgentIdentity(agentId, signature?, data?)` — soft-fail by default, hard-fail under `AGENTHIVE_AUTH_REQUIRED=true` |
| Principal verifier | `src/core/identity/principal-verifier.ts` | `PrincipalVerifier`, `buildMcpAuthMiddleware`, trust tiers |
| Principal identity | `src/core/identity/principal-identity.ts` | bound bearer tokens, agent session tokens, revocation |
| Key storage | `src/core/security/key-storage.ts` | at-rest key handling |

**Conclusion:** the Proof layer is complete and live. P2997 reuses migration 018
+ the identity module verbatim. The only Proof change is **wiring** (AC-7): the
existing `verifyAgentIdentity` check, previously invoked **only** in `msg_send`
(`src/apps/mcp-server/tools/messages/pg-handlers.ts` ~line 400), is now also
invoked at claim time.

## AC-2 / AC-6 — Stake / capability-bond schema (the only new schema)

Migration `scripts/migrations/283-p2997-stake-layer.sql`:

| Object | Definition | Purpose |
| :--- | :--- | :--- |
| `agent_registry.stake_microcents` | `bigint NOT NULL DEFAULT 0` | current bonded stake, integer microcents (1¢ = 10 000 µ¢) |
| `agent_registry.stake_status` | `text NOT NULL DEFAULT 'active'`, CHECK ∈ {`active`,`slashed`,`returned`} | bond lifecycle |
| `agent_registry.is_legacy` | `boolean NOT NULL DEFAULT false` | explicit legacy/unsigned scope flag |
| `stake_ledger` | append-only: `event_type` ∈ {bond,slash,return,downgrade}, `delta_microcents`, `balance_after`, `failure_class`, `dispatch_id`, `proposal_id`, `reason` | auditable running stake balance |

**Does not duplicate migration 018:** no key/signature columns are added. Stake
**layers over** the cost ledger `roadmap_efficiency.agent_budget_ledger` — that
ledger accounts token cost; `stake_ledger` accounts the bond. They are disjoint.

**Microcents** keep the bond integer-exact (no float drift) and aligned with the
USD-cents cost accounting.

### Lifecycle / downgrade

- An agent posts a `bond` (stake_microcents > 0, status `active`).
- Genuine failure → `slash` (deduct, clamp at 0; status flips to `slashed` at 0).
- Clean completion → `return` (status `returned`; balance preserved, re-bondable).
- Key-validity loss → set `is_legacy=true` (a `downgrade` ledger event) → the
  agent reverts to legacy scope (non-blocking proposals only), governed by the
  existing proof soft-fail policy. No new revocation machinery — reuses the
  identity module's key state + this flag.

## AC-3 / AC-7 — Enforcement points (chokepoints)

Stake and proof are mechanical, cross-cutting concerns → enforced in the
deterministic liaison/wrapper layer (per CONVENTIONS §4 P1859), never "remembered"
by an LLM. Implementation: `src/infra/agency/stake-admission.ts`.

| # | Chokepoint | Function modified | Check added |
| :-- | :--- | :--- | :--- |
| 1 | Pre-claim | `agency-claim-loop.ts::claimOne` | `evaluateStakeAdmission` (slashed/returned → skip claim) **+** existing `verifyAgentIdentity` proof check (hard-fail mode refuses unsigned at claim) |
| 2 | Post-work, failure | `offer-dispatch-handler.ts` completion block | `slashStake` — slashes only `failure_class='unknown'` (non-transient); transient classes (auth_rejected, rate_limited, quota_exhausted, no_eligible_agency, lease_expired) never slash |
| 3 | Post-completion, success | `offer-dispatch-handler.ts` completion block | `returnStake` — returned-on-success |
| (existing) | `msg_send` | `messages/pg-handlers.ts` | unchanged existing `verifyAgentIdentity` call |

`failure_class` taxonomy is reused from migration 184 (`squad_dispatch`). At the
completion site a degenerate `auth_required` exit maps to the transient
`auth_rejected` class (not the agent's fault, no slash); an empty-output or
missing-artifact "completion" (the hallucinated-completion pattern) maps to
`unknown` and **is** slashable.

## AC-4 / AC-8 — Legacy scope + admission policy + migration/test evidence

- **Admission gating:** `active` → admitted; `slashed` → rejected at claim;
  `returned` → rejected until re-bonded; **missing registry row / NULL stake** →
  admitted as **legacy** (the stake layer never invents a bond → full backward
  compatibility).
- **Proof policy unchanged:** legacy/unsigned agents continue to be governed by
  the existing `AGENTHIVE_AUTH_REQUIRED` soft-fail / hard-fail switch. No new
  proof schema is introduced.
- **Fail-open reads:** a transient DB error in the stake or proof gate fails
  open (admit) so the gate can never wedge the whole claim loop.
- **Evidence:**
  - Behavior: `src/infra/agency/__tests__/stake-admission-p2997.test.ts` (14 tests)
  - Wiring: `src/infra/agency/__tests__/stake-wiring-p2997.test.ts`
  - Migration (live DB, BEGIN/ROLLBACK; columns, CHECKs, ledger, idempotency,
    CHECK rejection): `scripts/migrations/__tests__/p2997-stake-migration.test.ts`

### Operator decision still open (AC-8)

A per-operation `agent_identity_proofs` history table (narrower defensible scope,
recording each signed operation) was floated. P2997 deliberately does **not**
add it — the proof layer is reused as-is and stake settlement already produces a
per-dispatch audit trail via `stake_ledger`. Adding a per-op proof history is a
separate, additive proposal if the operator wants it.
