# WORKFLOW.md — Workflow Orchestration Inside AgentHive

**Version:** 1.0 | **Status:** Live
**Source:** Authored by an orchestration agent (gemini/codex collaboration), 2026-06-01. Reconciled with GIT.md on merge-to-main authority (see §4 note).

> Sibling of GIT.md (git mechanics) and ORCHESTRATION.md (state-machine mechanics). This doc covers **when and how to use a Workflow** (deterministic multi-agent fan-out) inside one proposal's lifecycle.

---

## 1. The mental model (the one thing to get right)

> **The state machine owns transitions across time. A Workflow owns one bounded parallel burst within a single lease. Maturity is the boundary between runs.**

A Workflow run is single-turn, in-memory, deterministic fan-out — it completes in one go (with resume). The 5-state machine is long-lived, DB-backed, lease-arbitrated, async. **Do not model the state machine as a Workflow.** Use a Workflow for the work that happens *inside* one maturity transition, where several distinct experts must collaborate in one burst.

**Lifecycle of a single run:**
`claim/lease → run Workflow (Active work) → read structured result → write DB with a real verified_by identity → set maturity='mature' → release_lease → gate cron advances state.`

**One Workflow = one maturity transition.** Never chain Draft→Review→Develop in a single script — that re-couples the timescales the architecture deliberately separates.

---

## 2. Why this fits AgentHive specifically

Within a single state, advancing a proposal often needs multiple expert roles working together at once — and that's exactly a Workflow fan-out:

| State (maturity=Active) | Experts that collaborate in one burst | Workflow shape |
|---|---|---|
| Draft | splitter + AC-author(s) + coherence critic | parallel draft → completeness critic |
| Review | feasibility + arch-fit + coherence + AC-structure lenses → adversarial verify | judge panel (kills rubber-stamp + operator-self-review) |
| Develop | per-AC builder → per-AC filesystem verifier | `pipeline(acs, build, verify)` + worktree isolation |
| Merge | conductor + cheap test runners + fixers + drift critic | tiered gauntlet (see §4) |
| Complete | — | terminal, no run |

---

## 3. Core patterns to reach for

- **Judge panel (Review):** N independent verdicts from different lenses, then adversarial verify. Independence is structural — it's the fix for gate rubber-stamping and for "author reviews own proposal."
- **Pipeline + verify (Develop):** every pass must be confirmed by a second agent checking artifacts exist on disk. Structural defense against AC fabrication — no claimed pass survives unverified.
- **Tiered models (cost):** frontier (opus) plans/triages/judges; cheap (haiku/sonnet) runs the repetitive bulk. **Never run tests on a frontier model.**
- **Loop-until-green, budget-bounded:** `while (!green && round < N && budget.remaining() > X)`. On cap, escalate to USER — never burn.
- **Drift gate (Merge):** a frontier agent re-reads the original ACs/motivation against the final diff. Green ≠ done — catch both scope creep and shortfall.

---

## 4. The Merge gauntlet (highest-value, tiered)

Conductor (opus) holds USER intent → plans suite matrix → triages failures → drift-gates. Cheap runners (haiku) execute suites in parallel; fixers (sonnet) attempt bounded fixes in isolated worktrees. Loop bounded by budget + round cap. Mechanical breakage converges; design-level breakage correctly bounces to USER rather than letting a cheap agent gut intent to make a test pass.

> **Merge-to-main authority (reconciled with GIT.md §7, 2026-06-01):** the Workflow fan-out produces the verified result + a `merge_ok` verdict, but **no worker touches main from inside the fan-out.** The actual merge to main is done OUTSIDE the run by an **independent gate agent** (not the author), executing GIT.md §7's mandatory pre-push checks (clean status, intended-diff review, targeted test, MCP-handler export surface-sanity). High-risk classes (schema / main-infra / security) may be escalated to the operator. This supersedes any "operator merges" phrasing in earlier drafts of this doc — canon is: **independent gate agent merges; author never self-merges; operator handles only escalated high-risk merges.**

---

## 5. Non-negotiable guardrails (each earned from a real incident)

1. **Structured output only at the DB seam.** Agents return schema-validated structs; the orchestrator/gate stay mechanical and must never parse LLM prose to decide a transition.
2. **Worktree isolation + immediate post-run audit** on any build/fix run. Sub-agents have bypassed isolation and pushed to main before — verify git HEAD and DB maturity right after every dispatch; serialize risky writes if in doubt. (See GIT.md §7 STOP rule + parallel-dispatch audit.)
3. **Real identity for DB writes.** `verify_ac` requires `verified_by`; pass a genuine `agent_registry` identity, never `'operator'`/`'system'` impersonation.
4. **No silent truncation.** If a run caps coverage (top-N, skipped regression, sampling), `log()` what was dropped. "Passed" must never quietly mean "didn't run."
5. **No operator self-review.** A proposal's author must not write its own gate verdict — dispatch independent reviewers. The Workflow judge panel enforces this by construction.
6. **Budget is a hard ceiling.** Bound loops on `budget.remaining()`; escalate at the cap.

---

## 6. Boundaries — what NOT to do

- Don't run a Workflow to do trivial/sequential work — that's a plain Agent call or inline.
- Don't let a Workflow advance state; it produces artifacts + structured verdicts, the cron/gate advances state.
- Don't merge to main from inside a fan-out (per §4 — gate agent merges outside the run).
- Don't fire a Workflow without a concrete target proposal + its ACs as the intent anchor.

---

## Cross-references

- **GIT.md** — git mechanics: worktree isolation, the merge gauntlet's pre-push checks (§7), force-push, commit discipline. WORKFLOW.md §4 defers to GIT.md §7 for the actual merge mechanics.
- **ORCHESTRATION.md** — the state-machine mechanics this doc sits inside (DRAFT→REVIEW→DEVELOP→MERGE→COMPLETE, dispatch, lease, gate cron).
- **CONVENTIONS.md §5/§6** — proposal lifecycle + orchestration deep reference.

---

**Maintainer:** Gary Qi (gary.qi@gmail.com) | **Last Updated:** 2026-06-01 | **Status:** DRAFT (pending merge-authority ratification across canon + in-repo gate landing)
