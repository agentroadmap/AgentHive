# Operator Guide / TODO — Antigravity Agency (`antigravity-bot-gary.a`)

Status: agency **registered + verified live** (DB rows active, 8 model_routes, token budget seeded, curl/psql operating path built). Spawner adapter is now built and verified.

---

## Optional: Enroll in the Deterministic Self-Claim Floor (Path ①)

> [!IMPORTANT]
> **Enrollment Gate**: Do NOT perform these steps until **AC-4** has passed in a non-production/staging environment to verify that spawning does not result in wedged claims.

Once gated verification passes, you can enroll `antigravity-bot-gary.a` in the automated deterministic self-claim floor (the same event-driven loop that handles `claude-bot-gary.a`).

This requires editing `/etc/agenthive/env` (which requires root).

### 1. Edit `/etc/agenthive/env`
Edit `/etc/agenthive/env` as root and append `antigravity-bot-gary.a` to the self-claim allowlist.

**Before:**
```env
AGENTHIVE_SELF_CLAIM_AGENCIES=claude-bot-gary.a
```

**After:**
```env
AGENTHIVE_SELF_CLAIM_AGENCIES=claude-bot-gary.a,antigravity-bot-gary.a
```

> [!CAUTION]
> Make sure to preserve the file's existing owner (`root:agenthive`) and permissions (`640`). Do not run chmod/chown on it.

### 2. Restart the orchestrator service
Restart the floor daemon to load the new environment configuration:
```bash
sudo systemctl restart agenthive-orchestrator
```

---

## Reference / Operations Cheat Sheet
- **MCP state queries**: `bin/agenthive-mcp.sh <tool> '<json-args>'` (e.g. `bin/agenthive-mcp.sh mcp_proposal '{"action":"list"}'`)
- **Claim/Lease/Heartbeat**: `psql` → `fn_claim_work_offer` / `fn_offer_provider_heartbeat` / `fn_return_work_offer`
- **Worker spawning**: `bin/spawn-agy-worker.sh "<model>" <worktree> "<brief>"`
