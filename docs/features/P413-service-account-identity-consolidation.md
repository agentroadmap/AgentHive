# P413 — AgentHive Service Account & Runtime Identity Consolidation

**Status:** COMPLETE  
**Type:** issue  
**Priority:** high  
**Completed:** 2026-05-05

---

## 1. Motivation

The MCP restart/host test surfaced a systemic risk: AgentHive services run as different Unix users while sharing the same DB superuser and presenting inconsistent AgentHive identities. This makes restarts, audits, host policy enforcement, and credential ownership hard to reason about and harder to change safely.

This document provides:
- A live service inventory (AC-1)
- The canonical identity policy (AC-2)
- A least-privilege rollout plan with rollback (AC-3)
- Verification scope (AC-4, AC-7)
- Migration boundary and source-of-truth declaration (AC-5, AC-6)

---

## 2. Live Service Inventory (AC-1)

### 2.1 systemd Services

| Service unit | Unix User | Unix Group | Env file(s) | AgentHive identity | AGENTHIVE_HOST | DB auth | Notes |
|---|---|---|---|---|---|---|---|
| `agenthive-mcp.service` | `agenthive` | `agenthive` | `/etc/agenthive/env` | _(none registered)_ | _(hostname default)_ | `admin` (superuser) | `/home/agenthive` does not exist |
| `agenthive-orchestrator.service` | `gary` | `gary` | `/etc/agenthive/env` | `orchestrator` | _(hostname default)_ | `admin` (superuser) | NVM node path hard-wired to `/home/gary/.nvm` |
| `agenthive-gate-pipeline.service` | `xiaomi` | `gary` | `/etc/agenthive/env` + drop-in | `hermes/agency-xiaomi` (drop-in) | _(hostname default)_ | `admin` (superuser) | Mixed group ownership; offer dispatch disabled via drop-in |
| `agenthive-state-feed.service` | `xiaomi` | _(default)_ | `/etc/agenthive/env` | _(none)_ | _(hostname default)_ | `admin` (superuser) | bun runtime |
| `agenthive-a2a.service` | `gary` | `gary` | `/etc/agenthive/env` | _(none)_ | _(hostname default)_ | `admin` (superuser) | Drop-in clears and resets env file |
| `agenthive-discord-bridge.service` | `xiaomi` | _(default)_ | `/home/xiaomi/.agenthive.env`, `/home/xiaomi/.hermes/.env` | _(none)_ | _(hostname default)_ | varies by home env | Sole service loading from user-home env; not `/etc/agenthive/env` |
| `agenthive-claude-agency.service` | `gary` | `gary` | `/etc/agenthive/env` | `claude/agency-bot` | _(hostname default)_ | `admin` (superuser) | NVM node path hard-wired to `/home/gary/.nvm` |
| `agenthive-copilot-agency.service` | `gary` | `gary` | `/etc/agenthive/env` + drop-in | `copilot/agency-gary` | _(hostname default)_ | `admin` (superuser) | Drop-in overrides identity |
| `agenthive-board.service` | `gary` | `gary` | `/etc/agenthive/env` | _(none)_ | _(hostname default)_ | `admin` (superuser) | Dashboard HTTP + WebSocket :6420 |
| `agenthive-notification-router.service` | `xiaomi` | _(default)_ | `/etc/agenthive/env` | _(none)_ | _(hostname default)_ | `admin` (superuser) | bun runtime |
| `agenthive-schema-drift-monitor.service` | `xiaomi` | _(default)_ | `/etc/agenthive/env` | _(none)_ | _(hostname default)_ | `admin` (superuser) | oneshot + timer |

### 2.2 Cron Jobs (`/etc/cron.d/agenthive-reporting`)

| Schedule | Unix User | Env source | Script | Notes |
|---|---|---|---|---|
| Hourly (`0 * * * *`) | `xiaomi` | `/home/xiaomi/.hermes/.env` | `scripts/status-report-deliver.sh` | Loads user-home env |
| Every 5 min (`*/5 * * * *`) | `xiaomi` | `/home/xiaomi/.hermes/.env` | `scripts/state-feed-watchdog.sh` | Loads user-home env |
| Every 15 min (`*/15 * * * *`) | `xiaomi` | _(none; env inherited)_ | `bun scripts/cubic-lifecycle-cron.ts` | No explicit env load |

### 2.3 Wrapper Scripts (`/usr/local/bin/`)

All wrappers `source /etc/agenthive/env` at startup and set a `HOME` fallback. The fallback home varies by script, reflecting user-home assumptions baked into the scripts:

| Script | HOME fallback |
|---|---|
| `agenthive-mcp.sh` | `/home/agenthive` |
| `agenthive-gate-pipeline.sh` | `/home/gary` |
| `agenthive-a2a.sh` | `/home/gary` |
| `agenthive-state-feed.sh` | `/home/xiaomi` |
| `agenthive-notification-router.sh` | `/home/xiaomi` |
| `agenthive-schema-drift-monitor.sh` | `/home/xiaomi` |

---

## 3. Database Roles Inventory

### 3.1 Login Roles

| DB Role | Superuser | Can Login | Current use |
|---|---|---|---|
| `admin` | YES | YES | **All production services** (via `PGUSER=admin` in `/etc/agenthive/env`) |
| `gary` | YES | YES | Interactive operator access; member of `agent_write` |
| `xiaomi` | YES | YES | Interactive operator access; member of `agent_write` |
| `agenthive_repl` | NO | YES | Replication; no service uses it at runtime |
| `agenthive_admin` | YES | YES | Admin escalation; not used by services |
| `agent_andy` / `agent_bob` / `agent_carter` / `agent_claude_one` / `agent_copilot_one` / `agent_gemini_one` / `agent_gilbert` / `agent_openclaw_alpha/beta/gamma` / `agent_skeptic` / `agent_xiaomi_one` | NO | YES | Per-agent login roles; member of `agent_write` |

### 3.2 Group Roles (no login)

| DB Role | Can Login | Grant scope | Status |
|---|---|---|---|
| `agent_read` | NO | SELECT on all `roadmap.*` + sub-schemas, views, `token_cache.*` | Active; all `agent_write` members inherit via membership |
| `agent_write` | NO | INSERT/UPDATE on proposal, workforce, efficiency tables | Active; `admin`, `gary`, `xiaomi` are members |
| `agenthive_orchestrator` | NO | _(no grants assigned)_ | Role exists, unused in production |
| `agenthive_agency` | NO | _(no grants assigned)_ | Role exists, unused in production |
| `agenthive_a2a` | YES | _(no table grants assigned)_ | Role exists, unused in production |
| `agenthive_observability` | NO | _(no grants assigned)_ | Role exists, unused in production |
| `roadmap_agent` | NO | Observability/tracing tables (SELECT/INSERT) | Used by per-agent named roles |

**Critical finding:** Every production service connects as `admin` (superuser). The service-specific roles `agenthive_orchestrator`, `agenthive_agency`, `agenthive_a2a`, and `agenthive_observability` exist in `pg_roles` but carry no table grants and are not wired to any service.

### 3.3 Env File Security

| File | Owner | Mode | Contents |
|---|---|---|---|
| `/etc/agenthive/env` | `root:root` | `0644` (world-readable) | `PGPASSWORD`, `DATABASE_URL`, `DISCORD_WEBHOOK_*` |

**Risk:** `/etc/agenthive/env` is world-readable and contains the database password and Discord webhook URL. Any local process can read these credentials.

---

## 4. AgentHive Agent Identity Inventory

### 4.1 Registered Service Identities

| Agent identity | agent_type | role | trust_tier | Used by service |
|---|---|---|---|---|
| `orchestrator` | tool | developer | restricted | `agenthive-orchestrator.service` |
| `claude/agency-bot` | agency | developer | known | `agenthive-claude-agency.service` |
| `copilot/agency-gary` | agency | _(none)_ | known | `agenthive-copilot-agency.service` |
| `hermes/agency-xiaomi` | agency | _(none)_ | restricted | `agenthive-gate-pipeline.service` (via drop-in) |

### 4.2 Services Without a Registered Identity

The following services have no `AGENTHIVE_AGENT_IDENTITY` and are not registered in `agent_registry`:

- `agenthive-mcp.service` — no identity; MCP server need not be an agent
- `agenthive-state-feed.service` — no identity
- `agenthive-a2a.service` — no identity
- `agenthive-discord-bridge.service` — no identity
- `agenthive-board.service` — no identity
- `agenthive-notification-router.service` — no identity

This is acceptable for infrastructure services that do not participate in the proposal lifecycle.

---

## 5. Host Model Policy

Source: `roadmap.host_model_policy` table.

| `host_name` | Allowed providers | Forbidden providers | Notes |
|---|---|---|---|
| `gary-main` | (any) | `{anthropic}` | No Anthropic models; Nous/Xiaomi only |
| `claude-box` | (any) | `{anthropic}` | No Anthropic models |
| `hermes` | (any) | _(none)_ | All providers permitted |
| `bot` | `{anthropic}` | _(none)_ | Anthropic-only shared operator host |

`AGENTHIVE_HOST` is resolved as a structural config key (env var, optional). When unset, services default to the OS hostname. The comment in `agenthive-orchestrator.service` (`# hostname() default is correct on this host`) confirms the intended behavior.

---

## 6. Identified Gaps and Risks

| ID | Gap | Severity | Affected services |
|---|---|---|---|
| G-1 | All services authenticate to DB as superuser `admin` | HIGH | All |
| G-2 | `/etc/agenthive/env` is world-readable and contains credentials | HIGH | All |
| G-3 | `agenthive-mcp.service` runs as user `agenthive` but `/home/agenthive` does not exist | MEDIUM | MCP |
| G-4 | `agenthive-discord-bridge.service` loads env from `/home/xiaomi/` (user-home) | MEDIUM | Discord bridge |
| G-5 | Cron jobs source `/home/xiaomi/.hermes/.env` (user-home) | MEDIUM | Cron |
| G-6 | Gate pipeline has mixed group (`User=xiaomi`, `Group=gary`) | LOW | Gate pipeline |
| G-7 | Service-specific DB roles (`agenthive_orchestrator`, etc.) exist but have no grants | INFO | N/A (not wired) |
| G-8 | Node runtime PATH in orchestrator/agency services hardcoded to `/home/gary/.nvm` | MEDIUM | Orchestrator, agencies |

---

## 7. Canonical Identity Policy (AC-2)

### 7.1 When Service-Specific AgentHive Identities Are Required

A service **must** have a registered `AGENTHIVE_AGENT_IDENTITY` when:
- It participates in the proposal lifecycle (leasing, offering, heartbeating, spawning agents)
- Its actions must be traceable to a specific audit identity in `roadmap.agent_runs`, `roadmap.audit_log`, or `roadmap.proposal_lease`

A service **does not need** a registered identity when:
- It is a pure infrastructure relay (MCP SSE server, state-feed, A2A dispatcher, notification router, dashboard)
- It does not write to the proposal or workforce schemas directly

### 7.2 Canonical Runtime Identity Mapping

```
Service role           Unix user     DB login role        AgentHive identity
─────────────────────  ────────────  ───────────────────  ────────────────────────
MCP SSE server         agenthive     agenthive_mcp (*)    (none — infrastructure)
Orchestrator           agenthive (*) agenthive_orch (*)   orchestrator
Gate pipeline          agenthive (*) agenthive_agency (*) hermes/agency-xiaomi
State feed             agenthive (*) agenthive_feed (*)   (none — infrastructure)
A2A dispatcher         agenthive (*) agenthive_a2a        (none — infrastructure)
Discord bridge         agenthive (*) agenthive_bridge (*)  (none — infrastructure)
Claude agency          agenthive (*) agenthive_agency     claude/agency-bot
Copilot agency         agenthive (*) agenthive_agency     copilot/agency-gary
Dashboard board        agenthive (*) agenthive_ro (*)     (none — infrastructure)
Notification router    agenthive (*) agenthive_feed (*)   (none — infrastructure)
Schema drift monitor   agenthive (*) agenthive_ro (*)     (none — infrastructure)

(*) Target state — not yet implemented. See rollout plan.
```

### 7.3 Env File Policy

| Env file | Purpose | Who reads it |
|---|---|---|
| `/etc/agenthive/env` | Primary canonical env for all systemd services | All systemd units via `EnvironmentFile=` |
| `/home/xiaomi/.hermes/.env` | Legacy; cron + discord bridge only | Cron (`/etc/cron.d/agenthive-reporting`), discord bridge |

**Policy:** All service secrets must be in `/etc/agenthive/env` (root-owned, restricted). User-home env files are legacy and must be migrated out. No service should depend on a path under `/home/<user>/`.

---

## 8. Least-Privilege Rollout Plan (AC-3)

### 8.1 Phase 1 — Fix env file permissions (no restart required)

```bash
# Restrict env file to agenthive group only
sudo chown root:agenthive /etc/agenthive/env
sudo chmod 0640 /etc/agenthive/env

# Verify services that run as agenthive can still read it
sudo -u agenthive cat /etc/agenthive/env > /dev/null && echo "OK"
```

**Rollback:** `sudo chmod 0644 /etc/agenthive/env`

### 8.2 Phase 2 — Create dedicated Unix service account

```bash
# Ensure agenthive home exists with correct ownership
sudo mkdir -p /home/agenthive
sudo chown agenthive:agenthive /home/agenthive
sudo chmod 0750 /home/agenthive

# Verify agenthive group membership covers services that need env access
id agenthive
```

**Rollback:** Not needed; additive only.

### 8.3 Phase 3 — Migrate services to agenthive unix account

Change `User=gary` and `User=xiaomi` to `User=agenthive` in:
- `agenthive-orchestrator.service`
- `agenthive-gate-pipeline.service`
- `agenthive-state-feed.service`
- `agenthive-a2a.service`
- `agenthive-discord-bridge.service`
- `agenthive-claude-agency.service`
- `agenthive-copilot-agency.service`
- `agenthive-board.service`
- `agenthive-notification-router.service`
- `agenthive-schema-drift-monitor.service`

Replace NVM path assumptions with a system-wide Node install:

```bash
# Install Node system-wide (or symlink into /usr/local/bin)
sudo ln -sf /home/gary/.nvm/versions/node/v24.14.0/bin/node /usr/local/bin/node
sudo ln -sf /home/gary/.nvm/versions/node/v24.14.0/bin/npm /usr/local/bin/npm
# Verify
sudo -u agenthive node --version
```

Then update each service `ExecStart` to use `/usr/local/bin/node` rather than the NVM path.

**Migration order** (dependency-safe):
1. `agenthive-state-feed` (no dependents)
2. `agenthive-notification-router` (no dependents)
3. `agenthive-schema-drift-monitor` (no dependents)
4. `agenthive-discord-bridge` (no dependents)
5. `agenthive-a2a` (requires MCP to be up)
6. `agenthive-gate-pipeline` (requires MCP)
7. `agenthive-board` (requires MCP)
8. `agenthive-claude-agency` (requires MCP + orchestrator)
9. `agenthive-copilot-agency` (requires MCP + orchestrator)
10. `agenthive-orchestrator` (last; all others depend on it)
11. `agenthive-mcp` (restart last — temporary service interruption)

**Rollback** (per service): `sudo systemctl revert <unit>` and restart.

### 8.4 Phase 4 — Assign least-privilege DB roles

The service-specific roles already exist in pg_roles with no grants. Wire them by granting role membership:

```sql
-- Orchestrator: needs read + workflow write
GRANT agent_read TO agenthive_orchestrator;
GRANT agent_write TO agenthive_orchestrator;
ALTER ROLE agenthive_orchestrator LOGIN;

-- Agency (Claude/Copilot): needs proposal lifecycle write
GRANT agent_read TO agenthive_agency;
GRANT agent_write TO agenthive_agency;
ALTER ROLE agenthive_agency LOGIN;

-- A2A: needs message_ledger write + read
GRANT agent_read TO agenthive_a2a;
-- Add INSERT on message_ledger specifically if narrower grant preferred:
-- GRANT INSERT ON roadmap.message_ledger TO agenthive_a2a;

-- Infrastructure (feed, router, board): read-only
GRANT agent_read TO agenthive_observability;
ALTER ROLE agenthive_observability LOGIN;
```

Update `/etc/agenthive/env` per-service or use per-service drop-ins:

```ini
# /etc/systemd/system/agenthive-orchestrator.service.d/dbuser.conf
[Service]
Environment=PGUSER=agenthive_orchestrator
```

**Rollback:** Revert drop-in, restart service; all services fall back to `PGUSER=admin` from base env.

### 8.5 Phase 5 — Migrate discord bridge and cron off user-home env

Merge secrets from `/home/xiaomi/.hermes/.env` into `/etc/agenthive/env`. Update cron entries:

```
# Before
0 * * * * xiaomi . /home/xiaomi/.hermes/.env && ...
# After
0 * * * * agenthive . /etc/agenthive/env && ...
```

Update `agenthive-discord-bridge.service` to remove `EnvironmentFile=-/home/xiaomi/.agenthive.env` and `EnvironmentFile=-/home/xiaomi/.hermes/.env` lines.

**Rollback:** Restore original cron entries from git; restart bridge.

---

## 9. Verification Plan (AC-4, AC-7)

### 9.1 Startup Verification (no interactive shell dependency)

After each phase, verify service starts cleanly from systemd with no dependency on an interactive user environment:

```bash
# Stop and clear any lingering user-session env
sudo systemctl stop agenthive-<service>
sudo systemctl start agenthive-<service>
sudo systemctl status agenthive-<service> --no-pager
journalctl -u agenthive-<service> -n 50 --no-pager
```

Check for:
- No `HOME not set` or `permission denied` in journal
- No NVM path errors
- MCP SSE endpoint responds: `curl -s http://127.0.0.1:6421/sse | head -5`

### 9.2 Service Coverage Checklist

| Service | Startup test | Identity test | DB connect test |
|---|---|---|---|
| MCP | `curl http://127.0.0.1:6421/sse` responds | N/A | `pg_isready` |
| Orchestrator | Journal shows `[orchestrator] poll cycle` | `agent_registry` row for `orchestrator` exists | No superuser in `pg_stat_activity` (Phase 4) |
| Gate pipeline | Journal shows `gate-pipeline` ready | `hermes/agency-xiaomi` in `agent_registry` | N/A |
| State feed | Journal shows `LISTEN roadmap_events` | N/A | `pg_stat_activity` shows listener |
| A2A | Journal shows `A2A dispatcher ready` | N/A | N/A |

### 9.3 Regression Tests

- `tests/runtime/e2e-agent-spawn.test.ts` — validates orchestrator can claim a proposal and spawn an agent
- `tests/runtime/provider.test.ts` — validates provider routing resolves from DB, not hardcoded literals
- Manual: restart MCP then verify orchestrator reconnects within 30 seconds

### 9.4 Operator-Visible Failure Behavior

| Failure | Observable signal | Recovery |
|---|---|---|
| DB role has no grants | `pg_role_permissions_denied` error in journal | `GRANT agent_read TO <role>` + restart |
| `agenthive` user can't read `/etc/agenthive/env` | Service fails immediately, journal shows `permission denied: /etc/agenthive/env` | `chmod 640 /etc/agenthive/env` + `chgrp agenthive /etc/agenthive/env` |
| Node not found on PATH | Service fails with `No such file or directory` | Fix `ExecStart` path or `/usr/local/bin/node` symlink |
| Discord bridge can't find env | Bridge exits silently with no webhook URL | Check `journalctl -u agenthive-discord-bridge` for missing var |

---

## 10. Source of Truth and Migration Boundary (AC-5, AC-6)

**Source of truth:** The systemd unit files in `/etc/systemd/system/` and the env file at `/etc/agenthive/env` are the live source of truth for runtime identity. The repo files under `scripts/systemd/` and `etc-systemd/` are the canonical source for future deployments. Divergences must be resolved by deploying from repo.

**Migration boundary:** Phases 1–2 (permissions + home dir) are safe at any time. Phases 3–5 (user migration, DB role wiring, env consolidation) require a maintenance window for each service group. The control-plane DB transition (P474) must land before per-service DB roles can be enforced, as `config.getProjectDb(slug)` is required for multi-tenant isolation.

**Required capabilities:** operations (systemd, user management), security (DB grants, env file permissions).

**Skeptic concern addressed (AC-6):** The service inventory above (Section 2) provides the full matrix of Unix users, env files, DB roles, and identities per daemon. The rollout plan (Section 8) specifies exact ownership, grant, restart, and rollback steps in dependency-safe order without orphaning any live job.

---

## 11. Related Proposals

| Proposal | Relationship |
|---|---|
| P048, P237, P289, P298, P411 | Blocked by P413 — depend on stable identity/account model |
| P472 | Auth + identity unification; adjacent — covers keys, sessions, OAuth |
| P159 | Agent identity wiring in spawner |
| P474 | Multi-tenant DB; required before per-service DB role enforcement |
