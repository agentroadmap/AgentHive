# P241 — Optional Standby Gating Mode for Builder-Gate Collaboration

## Problem Statement

The baseline gating model is deliberately stateless: the builder self-declares mature, releases the work lease, and the cubic waits for a gating agent to claim and decide. This is correct for most proposals. However, some proposals accumulate unnecessary full send-back cycles when the gating agent encounters minor clarifications that the original builder could resolve in seconds.

Without a standby mechanism, every ambiguity triggers a full rejection cycle:

1. Gate sends back → proposal returns to New
2. Orchestrator redispatches builder
3. Builder reclaims, reads context, makes minor fix
4. Builder re-declares mature
5. Gate reclaims from scratch

This adds latency and token cost for interactions that could have been resolved via a single MCP message exchange.

## Design Decisions

### Decision 1: Standby is not a workflow state

Rejected: New `STANDBY` maturity — would require changes to `proposal_maturity_check` constraint, `reference_terms`, and all maturity-checking code paths. Blast radius too high.

Rejected: Boolean `is_on_standby` on proposal — mixes collaboration policy with proposal lifecycle.

**Chosen**: Standby is a lightweight presence attached to the cubic. The prior leaser may remain reachable via MCP messaging within the cubic without holding an active gate lease. No schema changes to the core proposal state machine.

### Decision 2: One active gate lease, always

The gating agent holds the sole active lease for the proposal during gate review. The standby participant holds no active lease and cannot block the gate decision. Gate decision semantics are identical to the baseline:

| Decision | Effect |
|----------|--------|
| `advance` | Moves state forward; resets maturity to `new` in the next state |
| `reject` / `send_back` | Keeps state; resets maturity to `new` in the same state |
| `obsolete` | Sets maturity to `obsolete` regardless of state |

### Decision 3: Orchestrator controls standby eligibility

The orchestrator decides whether standby is allowed, based on three factors:

1. **Proposal policy**: explicit opt-in via proposal metadata or type configuration
2. **Cost budget**: expected token/cost impact of keeping an agent on standby must be within configured limits
3. **Agent availability**: the prior leaser must be available and responsive

If any factor fails, the system degrades to the baseline stateless handoff transparently. Standby is always optional.

### Decision 4: Timebox with automatic fallback

Standby mode is timeboxed. If the standby duration or accumulated cost exceeds configured limits before the gate decision is made, the standby presence is dropped and the gate continues in stateless mode. The gate decision is never blocked by standby timeout.

### Decision 5: All collaboration via MCP records

Standby communication happens exclusively through MCP `discussion`, `message`, and `event` records in the proposal cubic. This ensures a complete audit trail and keeps the standby interaction observable. No out-of-band communication.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                  Baseline (default)                       │
│                                                           │
│  Builder → declare_mature → release lease                 │
│  Cubic   → wait for gate claim                            │
│  Gate    → claim → decide → release lease                 │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│            Standby Mode (opt-in, orchestrator-gated)      │
│                                                           │
│  Builder → declare_mature → transition to standby         │
│            presence (no active lease)                     │
│                │                                          │
│                │  MCP messaging / clarification           │
│                ▼                                          │
│  Gate    → claim (sole active lease)                      │
│            ├── query builder via cubic MCP messages       │
│            └── decide → release lease                     │
│                                                           │
│  Timebox guard: if standby cost > limit OR timeout        │
│                 → drop standby → gate continues alone     │
└──────────────────────────────────────────────────────────┘
```

## Orchestrator Evaluation (pseudo-logic)

```
function shouldEnableStandby(proposal, priorAgent):
  if not proposal.policy.standby_allowed:
    return false
  if estimatedStandbyCost(proposal) > budget.standby_max:
    return false
  if not priorAgent.isAvailable():
    return false
  return true
```

If `shouldEnableStandby` returns false, the system silently uses the baseline stateless path. No error, no retry.

## Timebox and Fallback

- Standby maximum duration is configured per-deployment (e.g. `standby_ttl_minutes`).
- If the timebox expires before the gate decision, the standby presence is dropped.
- The gate agent continues and completes the decision without the builder's further input.
- The gate decision still uses baseline semantics regardless of whether standby was active.

## Acceptance Criteria

| # | Criterion | Status |
|---|-----------|--------|
| AC-1 | Default mature-to-gate path remains stateless; builder standby is not required | ✅ verified |
| AC-2 | Standby mode allows prior leaser to remain attached to cubic without holding active gate lease | ✅ verified |
| AC-3 | Only one active gate lease is permitted; standby participants may only communicate or perform explicitly requested minor follow-up | ✅ verified |
| AC-4 | Orchestrator enables standby only when proposal policy, cost budget, and agent availability allow it | ✅ verified |
| AC-5 | Standby mode is timeboxed and automatically falls back to stateless handoff when cost or delay exceeds configured limits | ✅ verified |
| AC-6 | Gate decisions preserve baseline semantics: advance resets maturity to new in next state; reject/send_back resets maturity to new in same state; obsolete sets maturity obsolete | ✅ verified |
| AC-7 | All standby communication is recorded through MCP discussion/message/event records in the proposal cubic | ✅ verified |
| AC-8 | Tests cover: standby without duplicate gate claims, timeout fallback, decision lease release | ✅ verified |

## Dependencies

- **P240** (baseline mature-to-gate handoff): Standby mode is an optional extension of the stateless baseline defined in P240. P240 must be stable.
- **MCP cubic messaging**: Standby communication relies on cubic-scoped MCP discussion/message/event records being reliably writable and readable.

## Drawbacks

- **Token/opportunity cost**: Agents waiting on standby accumulate idle cost. The timebox and cost-budget checks mitigate but do not eliminate this.
- **Independent review risk**: If the gating agent relies too heavily on the standby builder's explanations, gate independence weakens. The single-active-lease constraint and MCP-record requirement maintain auditability, but the risk is structural and should be acknowledged in gate training.

## Alternatives Considered

| Alternative | Rejected because |
|-------------|-----------------|
| Always stateless handoff | Remains the default; standby is additive, not a replacement |
| Fully synchronous pair gating | Too heavy for normal proposal flow; adds mandatory coordination overhead to every gate |
| Standby as a maturity value | High blast radius — would touch constraint, reference_terms, and every maturity check in the codebase |
