## AgentHive — Claude Code Instructions

**This is a thin shim. Read `CONVENTIONS.md` for the full canonical source.**

### Quick Reference

| File | Purpose |
| :--- | :--- |
| **CONVENTIONS.md** | Canonical source — workflow, MCP, DB, Git, governance. Read this first. |
| AGENTS.md | Codex-specific quirks + pointer to CONVENTIONS.md |
| agentGuide.md | Retired. Content merged into CONVENTIONS.md. |

### Claude-Specific Notes

- **Host policy:** Only `nous+xiaomi` models on this host. Anthropic models are forbidden.
- **MCP:** `http://127.0.0.1:6421/sse` (SSE transport). System crontab at `/etc/cron.d/agenthive-reporting`.
- **DB:** `agenthive@127.0.0.1:5432`, user `xiaomi`. Schema-qualify with `roadmap.`
- **Worktree:** Use CWD-based convention, not hardcoded paths. Sibling worktree resolved from CWD.
- **Services:** Need `sudo` to restart. Code changes must be merged to `main` for services to see them.
- **Hotfix workflow:** See CONVENTIONS.md section 5 (Hotfix Workflow) and section 15 (Escalation Matrix) for terminal states and escape paths.

### Repo Context

- Project root: `CWD`
- Main project: `/data/code/AgentHive`
- MCP server: `http://127.0.0.1:6421/sse`
- GitLab: `gitlab.local` (SSH needs config for user `xiaomi`)
- Shared operator host: `bot`
- Use `AGENTHIVE_HOST=bot` when the current machine is the shared CLI/operator host. The physical host may run Codex, Claude, Hermes, or Copilot-backed spawns, but the child route must still come from the DB-resolved model route and host policy.
- Host policy is shared-host, route-specific. Do not treat `bot` as a single-provider host; use `roadmap.host_model_policy` to decide which route providers are allowed.
