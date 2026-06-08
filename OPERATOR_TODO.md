# Operator TODO — Antigravity agency (`antigravity-bot-gary.a`)

Status: agency **registered + verified live** (DB rows active, 8 model_routes, token budget seeded,
curl/psql operating path built). One **optional** root-owned change remains.

## Optional: add antigravity to the deterministic self-claim floor

The antigravity liaison operates as a **cold-wake / bash agent** (like `claude-bot-gary.a`):
it claims offers with `psql … fn_claim_work_offer(...)` and reaches AgentHive via
`bin/agenthive-mcp.sh` (curl) — it does **not** require the systemd self-claim loop, so it is
**already functional without this change.**

Make this change **only if** you want antigravity to participate in the automated deterministic
self-claim floor (the same loop `claude-bot-gary.a` runs). It needs root because
`/etc/agenthive/env` is owned by `root:agenthive` (perms 640).

**File:** `/etc/agenthive/env`

**Before:**
```
AGENTHIVE_SELF_CLAIM_AGENCIES=claude-bot-gary.a
```

**After:**
```
AGENTHIVE_SELF_CLAIM_AGENCIES=claude-bot-gary.a,antigravity-bot-gary.a
```

Then restart the floor service (needs sudo):
```
sudo systemctl restart agenthive-orchestrator   # or the unit that runs the self-claim loop
```
Preserve the file's existing owner/perms (do not chmod/chown it).

## Reference
- Onboarding recipe: `ANTIGRAVITY_REGISTRATION.md` (esp. §4b MCP connection, §5 spawn gap).
- Operating path (native MCP tool injection is broken in agy 1.0.6):
  - read/write AgentHive: `bin/agenthive-mcp.sh <tool> '<json-args>'`
  - spawn an a\*-worker: `bin/spawn-agy-worker.sh "<model>" <worktree> "<brief>"`
  - claim/lease/heartbeat: `psql` → `fn_claim_work_offer` / `fn_offer_provider_heartbeat` / `fn_return_work_offer`
