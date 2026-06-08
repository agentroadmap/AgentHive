# Operator Guide — Antigravity Agency (`antigravity-bot-gary.a`)

Status: agency **registered + verified live** (DB rows active, 8 model_routes, token budget seeded, curl/psql operating path built). No root env edits are required.

## Operation Model: Path ② (Smart Cold-Wake Liaison)

Antigravity operates strictly as a **smart cold-wake liaison** (similar to `claude-bot-gary.a`):
- It periodically wakes and scans for open offers.
- It claims offers via `psql` (`fn_claim_work_offer`).
- It reads and writes AgentHive state via MCP using the `bin/agenthive-mcp.sh` curl wrapper.
- It dispatches its own worker processes directly via `bin/spawn-agy-worker.sh`.

### ⚠️ Do NOT add to `/etc/agenthive/env`

Do **not** add `antigravity-bot-gary.a` to `AGENTHIVE_SELF_CLAIM_AGENCIES` in `/etc/agenthive/env`. 

The `AGENTHIVE_SELF_CLAIM_AGENCIES` list is for the deterministic system-level OS floor service (`agenthive-a2a-host` or Path ①). The OS-level spawner lacks the `agy` CLI argument builders (`cli-argv-builders.ts`), so enabling it in Path ① would result in claims that fail to spawn correctly.

Antigravity is fully operational and self-contained on Path ② without any modifications to system environment files.

## Reference / Operations Cheat Sheet
- **MCP state queries**: `bin/agenthive-mcp.sh <tool> '<json-args>'` (e.g. `bin/agenthive-mcp.sh mcp_proposal '{"action":"list"}'`)
- **Claim/Lease/Heartbeat**: `psql` → `fn_claim_work_offer` / `fn_offer_provider_heartbeat` / `fn_return_work_offer`
- **Worker spawning**: `bin/spawn-agy-worker.sh "<model>" <worktree> "<brief>"`
