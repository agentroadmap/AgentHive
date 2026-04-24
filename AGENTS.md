## AgentHive — Codex Instructions

**This is a thin shim. Read `CONVENTIONS.md` for the full canonical source.**

### Quick Reference

| File | Purpose |
| :--- | :--- |
| **CONVENTIONS.md** | Canonical source — workflow, MCP, DB, Git, governance. Read this first. |
| CLAUDE.md | Claude-specific memory + pointer to CONVENTIONS.md |
| agentGuide.md | Retired. Content merged into CONVENTIONS.md. |

### Codex-Specific Notes

- Work is proposal-driven. Check the current proposal, state, and dependencies before changing shared behavior.
- Use the MCP and proposal workflow when the task affects shared project state, release flow, or agent coordination.
- Create and update tracked proposals through MCP/Postgres first; treat markdown files as synced projections, not the lifecycle source of truth.
- Keep changes surgical. Avoid unrelated refactors, formatting churn, or broad cleanup.
- Prefer tests that reproduce the bug or validate the behavior you changed.
- Don't litter workspace with random files, especially project root folder.
- If a section becomes stale, prefer moving the detail into docs and keeping this file short.

### Repo Context

- Current worktree root: CWD
- Main project root: repository root
- MCP server: `http://127.0.0.1:6421/sse`
- Shared operator host: `bot`
- Use `AGENTHIVE_HOST=bot` when the current machine is the shared CLI/operator host. The physical host may run Codex, Claude, Hermes, or Copilot-backed spawns, but the child route must still come from the DB-resolved model route and host policy.
- Host policy is shared-host, route-specific. Do not treat `bot` as a single-provider host; use `roadmap.host_model_policy` to decide which route providers are allowed.
