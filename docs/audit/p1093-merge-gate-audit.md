> **Type:** reference  
> **MCP-tracked:** P1094  
> **Source-of-truth:** Postgres `roadmap_proposal.proposal` row P1094

# Merge Gate Audit

This audit checks whether the D4 MERGE -> COMPLETE flow is actually blocked and records the live dispatch binding that should own the terminal gate.

## Executive Result

The live database does not support the headline claim that there were zero D4 advances in the last 30 days. As of the audit run on 2026-05-15 UTC, `roadmap_proposal.proposal_state_transitions` had 284 MERGE -> COMPLETE transitions in the trailing 30 days, and `roadmap_proposal.gate_decision_log` had 39 D4-equivalent `advance` rows. There were also zero proposals currently sitting in `MERGE/mature`.

The real binding issue found is narrower: D4 role configuration was split. `roadmap_proposal.gate_role` says D4 uses `gate-reviewer`, while `roadmap.agent_role_profile` for Standard RFC `MERGE/mature` did not include `gate-reviewer`, and no active registry row had `role='gate-reviewer'`. Migration `database/migrations/127-p1094-d4-gate-reviewer-role.sql` adds that binding and maps the existing active `Gate Reviewer` agent to the role.

## Baseline Snapshot (2026-05-16)

| Metric | Value |
| --- | --- |
| Proposals in MERGE state | 0 |
| DEVELOP/new proposals | 77 |
| D4 advances (last 30d, gate_decision_log) | 38 |
| D3 holds (last 30d) | 48 |
| `agent_role_profile` rows: MERGE/mature/gate-reviewer | 1 (post-fix) |
| Active gate-reviewer agents | 1 |
| Snapshot timestamp | 2026-05-16 15:32:52 UTC |

## Representative DEVELOP/new Case Studies

Selection query: among `status='DEVELOP'`, `maturity='new'`, and types `feature`, `architecture`, `component`, pick the oldest feature, median architecture, and newest component by `created_at`.

| Role in sample | Proposal | Type | Created | Current | Title |
| --- | --- | --- | --- | --- | --- |
| Oldest | P188 | feature | 2026-04-11 17:43 UTC | DEVELOP/new | Directive Proposal Type |
| Median | P798 | architecture | 2026-05-01 08:17 UTC | DEVELOP/new | Multi-platform subscription model architecture |
| Newest | P674 | component | 2026-04-28 12:07 UTC | DEVELOP/new | Notification router |

### Side-by-side lifecycle evidence

| Evidence | P188 | P798 | P674 |
| --- | --- | --- | --- |
| State timeline | DRAFT -> Review on 2026-04-15; Review -> Develop on 2026-04-16; Develop -> DEVELOP normalization on 2026-04-20. | DRAFT -> REVIEW on 2026-05-01; REVIEW -> DEVELOP on 2026-05-01 after an initial D2 hold for missing ACs. | DRAFT -> REVIEW and REVIEW -> DEVELOP both on 2026-05-01. |
| Maturity pattern | Repeated active/mature cycles; latest observed mature -> active -> new loops ended on 2026-05-06 after gate dispatch blocks. | Multiple active/mature loops; latest mature -> new on 2026-05-15 after a hold. | mature -> active/new loops in April; active -> new on 2026-05-13 after operator termination. |
| Leases | Heavy lease churn from `hermes/agency-xiaomi`; later `claude/agency-bot`, `codex-one`, `codex-four`. Several `gate_dispatch_blocked` releases. | `copilot`, `claude/agency-bot`, `codex-two`, `ccs46ant-bot-resea-a`, `alex`; includes timeout and gate dispatch blocked releases. | `codex-*` gate attempts in April, then `calvin` on 2026-05-13; includes `gate_spawn_failed`, `gate_dispatch_blocked`, `lease_expired`, and `operator_terminated`. |
| Gate decisions | No `gate_decision_log` rows found in the sampled query; review rows show repeated request_changes for missing implementation. | D1 advance; D2 hold; D2 advance. | D1 advance; D2 advance. |
| Reviews | 9 request_changes rows, mostly citing zero implementation and missing files. | None in `proposal_reviews` for sampled query; gate log carries the D2 hold/advance. | None in `proposal_reviews` for sampled query; gate log carries D1/D2 advances. |
| Agent runs | Very high failed-run volume, especially rate-limit failures and later gate dispatch blocks. | Gate:MERGE timeout on 2026-05-06, many researcher/architect/enhancer retries, several timeouts/rate limits, and some completed runs on 2026-05-14. | Many researcher/architect failures, timeouts, unavailable model errors, and one completed developer run on 2026-05-13. |

## Aggregate Diagnostics

### D3 hold distribution

Trailing 30 days, D3-equivalent rows (`gate='D3'`, `gate_level='D3'`, or DEVELOP -> MERGE): 49 `hold`, 29 `advance`.

The top repeated hold signatures were mostly orchestrator fallback rationales such as `Gate D3 decision: hold. skeptic-beta did not advance ...`, plus concrete implementation failures: missing implementation, dead channel `transition_queued`, missing pgClient error/reconnect handling, missing tests, stubbed runtime paths, and unmet AC verification. `ac_verification.details` was mostly absent: 78 rows grouped as `missing`, so D3 diagnostics are relying on free-text rationale more than structured AC detail.

### D4 dispatch path

Observed binding before the fix:

| Source | D4 / MERGE mature result |
| --- | --- |
| `roadmap_proposal.gate_role` | `gate-reviewer` for architecture, component, feature, issue, product |
| `roadmap.agent_role_profile` for template 14, `MERGE/mature` | `reviewer-d4`, `qa`, `maintainer`, `gate-agent`, `merge_decision_agent` |
| active agents with `role='gate-reviewer'` | 0 |
| current `MERGE/mature` proposals | 0 |

Code path notes:

- The deployed implicit-gate path in `src/core/orchestration/legacy-dispatch.ts` still resolves D4 from its built-in `GATE_ROLES` map and shadow-checks `gate_role`; it dispatches `gate-reviewer` directly.
- The newer `scanQueues()` path in `src/core/orchestration/orchestrator.ts` resolves `roleProfiles` through `resolveQueueContext()` -> `getRolesForQueue()` and passes the first profile id into route resolution.
- Before this fix, a hypothetical Standard RFC `MERGE/mature` proposal in the queue-native path would pick `reviewer-d4` as its first role profile, while gate-role semantics say D4 is `gate-reviewer`.

Post-fix state (after migration 127):

| Source | D4 / MERGE mature result |
| --- | --- |
| `roadmap.agent_role_profile` row 76 | `gate-reviewer`, priority 5, scope `global`, template 14, stage `MERGE`, maturity `mature` |
| `roadmap_workforce.agent_registry` row 33295 | `Gate Reviewer`, role `gate-reviewer`, status `active` |
| active agents with `role='gate-reviewer'` | 1 |

### E2E runner wiring

No `scripts/e2e-validate-merge.ts` or equivalent dispatch-wired D4 validator was found. Search hits were documentation and generic validators, plus worktree-merge MCP handlers. There is no e2e validator job that programmatically runs proposal AC verification and writes a D4 `gate_decision_log` row.

## Fix Applied

Migration `database/migrations/127-p1094-d4-gate-reviewer-role.sql`:

- adds a global Standard RFC `MERGE/mature` `gate-reviewer` role profile with priority 5, before `reviewer-d4`;
- keeps existing fallback rows intact;
- maps the existing active `Gate Reviewer` registry row to `role='gate-reviewer'`;
- inserts a `gate-reviewer` fallback registry row only if no active gate reviewer exists.

This is Branch B hardening. Branch C remains unimplemented because no D4 e2e runner exists; that should be a follow-up child proposal rather than a hidden service in this patch.

## Binding Constraint (AC-5)

**Branch B: no MERGE reviewer** is the primary binding constraint. The `gate_stage_role` table is entirely empty (confirmed 2026-05-16). The `agent_role_profile` MERGE/mature rows did not include the canonical `gate-reviewer` role required by `gate_role` for Standard RFC. The fix is the insertion in migration 127. Secondary concern is Branch A (stalled implementations) which manifests as very high D3 hold rates, but that is a separate effort tracked under P1068.
