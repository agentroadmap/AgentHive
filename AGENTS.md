## AgentHive — Codex Instructions

**This is a thin shim. Read `CONVENTIONS.md` for the full canonical source.**

### Quick Reference

| File | Purpose |
| :--- | :--- |
| **CONVENTIONS.md** | Canonical source — workflow, MCP, DB, Git, governance. Read this first. |
| CLAUDE.md | Claude-specific memory + pointer to CONVENTIONS.md |
| agentGuide.md | Retired. Content merged into CONVENTIONS.md. |

### Governance Amendments

> To propose a constitutional change (amendments to the AgentHive Constitution, doc-9),
> use proposal type **`governance-amendment`** — NOT `feature`. The 6-stage workflow
> (DRAFT → DELIBERATION → REVIEW → DEVELOP → MERGE → COMPLETE) enforces a 48-hour
> deliberation window, Skeptic quorum, and human-only final approval.
> See CONVENTIONS.md §Governance Amendment Workflow for the full step-by-step guide.

### Codex-Specific Notes

- Work is proposal-driven. Check the current proposal, state, and dependencies before changing shared behavior.
- Use the MCP and proposal workflow when the task affects shared project state, release flow, or agent coordination.
- Create and update tracked proposals through MCP/Postgres first; treat markdown files as synced projections, not the lifecycle source of truth.
- Keep changes surgical. Avoid unrelated refactors, formatting churn, or broad cleanup.
- Prefer tests that reproduce the bug or validate the behavior you changed.
- Don't litter workspace with random files, especially project root folder.
- If a section becomes stale, prefer moving the detail into docs and keeping this file short.
- **Gate verdicts (P1391):** when `AGENTHIVE_GATE_AUTHORITY_ENABLED` is ON, `record_gate_decision` accepts only `advance | request_for_change | reject` for new writes. `reject` (→ obsolete) is ELEVATED: it needs an `operator_token` or an active `authority_grant`, and the agent path also needs a frontier-model route + a `superseded_by`/`conflicts_with` dependency edge. Flag OFF keeps the legacy `hold`/`reject`/`waive`/`escalate` vocabulary with no who-check. See CONVENTIONS.md "Gate-verdict vocabulary (P1391)".

### Repo Context

- Current worktree root: CWD
- Main project root: repository root
- MCP server: `http://127.0.0.1:6421/sse`
- **DB topology (target):** `hiveCentral` for control plane + one DB per project tenant (`agenthive`, `monkeyKing-audio`, `georgia-singer`, …). See CONVENTIONS.md §6.0.
- **DB today (transition):** single-DB `agenthive`. P429 extracts `hiveCentral` and recasts `agenthive` as the first project tenant DB.
- Shared operator host: `bot`
- Use `AGENTHIVE_HOST=bot` when the current machine is the shared CLI/operator host. The physical host may run Codex, Claude, Hermes, or Copilot-backed spawns, but the child route must still come from the DB-resolved model route and host policy.
- Host policy is shared-host, route-specific. Do not treat `bot` as a single-provider host; use `roadmap.host_model_policy` to decide which route providers are allowed.
