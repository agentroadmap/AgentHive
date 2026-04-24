# P299 Gate Decision — SKEPTIC-BETA — 2026-04-21

## Decision: SEND BACK

## Verification Results (10 ACs checked)

| AC | Status | Finding |
|---|---|---|
| AC-1: dispatchAgent() removed | FAIL | Still exists at orchestrator.ts:453 |
| AC-2: _dispatchTransitionQueue() removed | FAIL | Still exists at orchestrator.ts:992 |
| AC-3: OfferProvider SpawnHandle + SIGTERM | FAIL | No SpawnHandle type. No SIGTERM/SIGKILL. spawnAgent returns SpawnResult only. |
| AC-4: releaseStaleCubics() + cubic imports removed | FAIL | Still at orchestrator.ts:1214. cubic_list/transition called inside. |
| AC-5: OfferProvider uses dynamic worktree | FAIL | offer-provider.ts:223 hardcodes "hermes-andy" fallback |
| AC-6: No cubic_* in orchestrator.ts | FAIL | cubic_acquire (467), cubic_list (1220), cubic_transition (1230) |
| AC-7: spawnAgent returns SpawnHandle | FAIL | agent-spawner.ts exports SpawnResult only |
| AC-8: Legacy orchestrator variants deleted | FAIL | All 4 files still exist (1,124 total lines) |
| AC-9: Additional dead code removed | FAIL | classifyProviderError, isProviderInCooldown, setProviderCooldown, recordProviderSuccess, setProposalMaturity, releaseDispatchLease all still defined |
| AC-10: STATE_TO_PHASE kept | PASS | Correctly preserved at line 50, used by handleStateChange() |

**Score: 1/10 ACs met.**

## Assessment

None of the changes described in the proposal have been implemented. The orchestrator.ts is completely unchanged from its pre-migration state. ~400 lines of dead code remain. OfferProvider has no SpawnHandle support and no process lifecycle management.

The proposal's design document is thorough and correct — the dead code identifications are accurate, and the AC-3 changes (process tracking) are the real substance. But zero code has been written.

## Recommended Next Steps

1. Start with Change 1 (dead code deletion) — largest line count, lowest risk since every identified function is confirmed uncalled
2. Implement Change 3 (dynamic worktree) — trivial, ~3 lines
3. Implement Change 2 (SpawnHandle) — refactor agent-spawner.ts to return handle, wire into OfferProvider with lease-loss termination

## Artifacts

- Discussion recorded in roadmap_proposal.proposal_discussions (proposal_id=299)
- Lease released in roadmap_proposal.proposal_lease (proposal_id=299)
- Maturity set to 'new'
