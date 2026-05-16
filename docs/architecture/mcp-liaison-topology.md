# MCP Server + Liaison Process Topology

**Proposal:** P1095 | **Date:** 2026-05-16 | **Status:** Canonical

This document describes how the MCP server (port 6421) and agency liaison processes are launched, supervised, and recovered. It was produced via live system inspection (running PIDs, `/proc`, `systemctl`, and source tracing).

---

## 1. Process Tree

```
systemd (PID 1)
│
├── agenthive-mcp.service                 [User: agenthive]
│   └── node PID 1171031                  scripts/mcp-sse-server.js
│       └── LISTEN :6421 (127.0.0.1)      SSE + StreamableHTTP transports
│
├── agenthive-board.service               [User: gary]
│   └── node PID 3655480                  scripts/cli.cjs.js browser --port 6420
│       └── LISTEN :6420 (*)              Dashboard HTTP + WebSocket
│
├── agenthive-orchestrator.service        [User: gary]
│   └── node                              scripts/orchestrator.ts
│
├── agenthive-state-feed.service          [User: xiaomi]
│   └── bun                               scripts/state-feed-listener.ts
│
├── agenthive-notification-router.service [User: gary]
│   └── node                              scripts/start-notification-router.ts
│
└── agenthive-agency@<name>.service  ×9  [User: gary]  (see §4 for active list)
    └── node PID <liaison>                scripts/start-liaison.ts
        ├── bootLiaison()                 heartbeat every 30s → liaisonHeartbeat()
        ├── startLiaisonHub()             LISTEN pg_notify 'liaison_message_<name>'
        ├── runLiaisonAgent()             LISTEN pg_notify 'a2a_msg_<name>'
        └── spawn(claude --print …) ×N   on-demand child processes per dispatched task
```

---

## 2. MCP Server (Port 6421)

### 2.1 Systemd Unit

| Field | Value |
|---|---|
| Unit file | `/etc/systemd/system/agenthive-mcp.service` |
| User | `agenthive` |
| WorkingDirectory | `/data/code/AgentHive` |
| ExecStart | `/usr/local/bin/agenthive-mcp.sh` |
| Restart | `always` (RestartSec=3) |
| After | `network.target` |

The startup script (`/usr/local/bin/agenthive-mcp.sh`) sources `/etc/agenthive/env`, sets up NVM and PG env vars, then execs:

```
node --import jiti/register scripts/mcp-sse-server.js
```

### 2.2 Port Binding Code

| File | Location |
|---|---|
| Entry point | `scripts/mcp-sse-server.js` |
| Port binding | `scripts/mcp-sse-server.js:207` — `app.listen(port, host, …)` |
| MCP tool handlers | `src/apps/mcp-server/server.ts` — `createMcpServer()` |
| HTTP compat layer | `src/apps/mcp-server/http-compat.ts` — `handleDirectMcpRequest()` |

`MCP_PORT=6421` and `MCP_HOST=127.0.0.1` are the defaults; both are overridable via env. The env file at `/etc/agenthive/env` sets `MCP_PORT=6421`.

### 2.3 Transports

`MCP_TRANSPORT` controls which transports are active (default: `"both"`):

| Transport | Endpoint | Status |
|---|---|---|
| SSE | `/sse` (connect), `/messages` (post) | Active; retiring 2026-07-01 |
| StreamableHTTP | `/mcp-streamable` (aliases: `/mcp/streamable`, `/streamable`) | Active; preferred |

### 2.4 Health Endpoint

```
GET http://127.0.0.1:6421/health
```

Returns JSON with `status`, `version`, `uptime`, `sessions` (SSE session count), and full transport config. Example (observed live):

```json
{
  "status": "ok",
  "version": "0.0.0",
  "uptime": 1097,
  "sessions": 30,
  "transport": { "active": ["sse", "streamable-http"], "config": "both", ... }
}
```

A `200 OK` with `status: "ok"` confirms the server is ready.

### 2.5 Session Architecture

A **single shared MCP server** (`createMcpServer()`) is created once per process lifetime. Per-session SDK server instances are created for each SSE connection but delegate all request handling to the shared instance. This ensures DB connections and `pg_notify` listeners are set up exactly once.

---

## 3. Agency / Liaison Processes

### 3.1 Systemd Template

All active agencies use the `agenthive-agency@.service` template:

| Field | Value |
|---|---|
| Unit file | `/etc/systemd/system/agenthive-agency@.service` |
| User | `gary` |
| WorkingDirectory | `/data/code/AgentHive` |
| ExecStart | `node --import jiti/register scripts/start-liaison.ts` |
| Restart | `on-failure` (RestartSec=15) |
| Requires | `agenthive-mcp.service` |
| After | `network.target postgresql.service agenthive-mcp.service` |
| Global env | `/etc/agenthive/env` |
| Per-agency env | `/etc/agenthive/agency-<name>.env` (optional; sets `AGENTHIVE_AGENT_PROVIDER`, `AGENTHIVE_AGENT_PROJECTS`) |
| AGENCY_ID | `%i` (systemd instance name) |
| AGENCY_HOST_ID | `bot` (hardcoded in template) |

A separate `agenthive-liaison@.service` template exists but has **zero active instances**. It is structurally identical to `agenthive-agency@.service` except it reads `liaison-<name>.env` and omits the `AGENCY_HOST_ID=bot` default. It is the intended template for future or non-standard agencies.

### 3.2 Liaison Startup Sequence

The production entry point at `/data/code/AgentHive/scripts/start-liaison.ts` boots in three layers:

**Layer 1 — `bootLiaison()`** (`src/infra/agency/liaison-boot.ts`):
- Reads `AGENCY_ID`, `AGENCY_PROVIDER`, `AGENCY_HOST_ID` from env
- Calls `liaisonRegister()` to register with the orchestrator (DB row in `agency_liaison_session`)
- Starts a 30-second heartbeat loop (`liaisonHeartbeat()`) that keeps `v_agency_status.dispatchable = true`
- Starts `startLiaisonHub()`:
  - Opens a dedicated (non-pooled) `pg.Client` and LISTENs on `liaison_message_<agencyId>`
  - Handles uplink messages (subagent → orchestrator), downlink directives, and `offer_dispatch` routing

**Layer 2 — `runLiaisonAgent()`** (`src/infra/agency/liaison-agent.ts`):
- Only runs if `AGENCY_PROVIDER` is set (falls back to non-fatal warning)
- Opens a second dedicated `pg.Client`, LISTENs on `a2a_msg_<agencyId>` channel
- On each notification, fetches the `message_ledger` row and dispatches:
  - `protocol_ping` → immediate `protocol_pong` (no LLM, no token cost)
  - Explicit spawn tasks → invokes CLI via `CliInvocationRegistry`
  - Other message types → routes to the per-provider handler via `invokeCliHandler()`

**Layer 3 — On-demand child processes:**
- When a task is dispatched, `spawnCliCapture()` (`src/infra/agency/liaison-agent.ts`) calls `spawn(bin, args)` where `bin` is the CLI for the provider (e.g. `claude --print …`)
- Child processes are direct descendants of the liaison node process (verified via `/proc/<pid>/status PPid`)
- Example: `agenthive-agency@adam.service` (PID 1171033) was observed with 4 live claude child processes (PIDs 1184430, 1184986, 1186021, 1186044)

### 3.3 Active Agency Instances

| Agency | systemd unit | PID (observed) |
|---|---|---|
| adam | agenthive-agency@adam | 1171033 |
| alan | agenthive-agency@alan | 1171034 |
| alex | agenthive-agency@alex | 1171036 |
| codex-agency-bot | agenthive-agency@codex-agency-bot | — |
| copilot-agency-gary | agenthive-agency@copilot-agency-gary | — |
| gemini-agency-bot | agenthive-agency@gemini-agency-bot | — |
| george | agenthive-agency@george | 1171040 |
| pablo | agenthive-agency@pablo | — |
| pete | agenthive-agency@pete | — |

All 9 instances run the same `scripts/start-liaison.ts` entry point. Provider identity comes from the per-agency env file.

---

## 4. Port Summary

| Port | Binding | Service | Owning process |
|---|---|---|---|
| 6421 | 127.0.0.1 | MCP SSE Server | `scripts/mcp-sse-server.js` (agenthive user) |
| 6420 | `*` (all interfaces) | Dashboard Board | `scripts/cli.cjs.js browser` (gary user) |

No other agenthive ports were found listening at time of audit.

---

## 5. Failure-Mode Table

| Component crashes | Immediate effect | Recovery |
|---|---|---|
| `agenthive-mcp.service` | Port 6421 drops; all open SSE sessions disconnect; `Requires=` causes all 9 agencies to stop | systemd restarts MCP in **3s** (`Restart=always`). Agencies restart ~15s later (`RestartSec=15`). **Note:** MCP crash cascades to agency stops — in-flight claude child processes are orphaned (PPID 1). |
| Single `agenthive-agency@<name>` | Liaison process dies; any in-flight child claude processes also die (SIGTERM from systemd KillSignal); heartbeat stops; agency becomes non-dispatchable in `v_agency_status` | systemd restarts in **15s** (`Restart=on-failure`). In-flight tasks are lost; lease expiry is the recovery path for claimed squad_dispatch rows. |
| `agenthive-orchestrator.service` | No new offers dispatched; no new leases issued | systemd restarts in **10s** (`Restart=on-failure`). No cascade to other services (`Wants=` not `Requires=`). In-progress agency work continues. |
| `agenthive-board.service` | Dashboard UI unavailable | No cascade. Restarted by systemd. |
| `agenthive-state-feed.service` | Discord/notification feed stops | No cascade. Restarted by systemd. |
| Individual claude child process | Single in-flight task lost | No systemd restart (child is not a service). Liaison loop resumes on next notification. |

**MCP Cascade Risk:** Because all agency units have `Requires=agenthive-mcp.service`, a 3-second MCP restart causes a ~15-second agency downtime window. During this window no dispatch can occur and no A2A messages are delivered.

---

## 6. Health Probes (Current State)

| Probe | Implementation | Gap |
|---|---|---|
| MCP server liveness | `GET http://127.0.0.1:6421/health` → 200 + `status:"ok"` | **Not wired** to state-feed or board alerting |
| Agency count | 9 `agenthive-agency@*.service` units in `running` state | No programmatic check; `systemctl` query only |
| Heartbeat freshness | `v_agency_status.dispatchable` column driven by 30s heartbeat | State-feed does not alert on dispatchable=false |
| Child process count | No probe | Liaison process count per agency is unmonitored |

---

## 7. Phase 2 Remediation Recommendations

Based on Phase 1 findings, the following actions are recommended in priority order:

### 7.1 Wire MCP health probe to state-feed (low effort, high visibility)
The `/health` endpoint exists. The state-feed service should poll it every 30–60s and emit a Discord alert if it returns non-200 or is unreachable. This surfaces the MCP cascade window to operators.

Add a one-line probe to `scripts/state-feed-listener.ts` or a new `scripts/mcp-health-probe.ts` run via the schema-drift-monitor timer pattern.

### 7.2 Document MCP cascade in CONVENTIONS.md (15 min)
Add a paragraph to CONVENTIONS.md noting that `Requires=agenthive-mcp.service` means any MCP restart stops all agencies. Operators should be aware that restarting `agenthive-mcp.service` has a ~15s platform-wide impact.

### 7.3 Consider `BindsTo=` vs `Requires=` for agency units (medium effort)
`Requires=` causes immediate agency stop on MCP stop. `BindsTo=` has the same effect. If MCP restarts are expected to be fast (3s), agencies could instead use `After=` + `Wants=` and a retry loop on connection failure — allowing agencies to survive brief MCP bounces. This is an architectural decision requiring operator sign-off.

### 7.4 Add dispatchable alert to state-feed (medium effort)
The state-feed listener already consumes `pg_notify`. Add a handler for when `v_agency_status.dispatchable` turns false for >2 minutes (i.e. 4 missed heartbeats), emitting a Discord alert per affected agency.

### 7.5 Migrate active instances to `agenthive-liaison@.service` (low urgency)
The `agenthive-liaison@.service` template is the intended canonical template (per the unit comment style and env-file naming). Current instances on `agenthive-agency@.service` should migrate when convenient. No functional difference today.

---

## 8. Source Code Index

| Component | Key files |
|---|---|
| MCP entry point | `scripts/mcp-sse-server.js` |
| MCP server (tools, handlers) | `src/apps/mcp-server/server.ts` |
| MCP HTTP compat | `src/apps/mcp-server/http-compat.ts` |
| Liaison entry point | `scripts/start-liaison.ts` (production: `/data/code/AgentHive/scripts/start-liaison.ts`) |
| Liaison boot (register, heartbeat) | `src/infra/agency/liaison-boot.ts` |
| Liaison hub (pg_notify LISTEN) | `src/infra/agency/liaison-hub.ts` |
| Liaison A2A agent (spawn) | `src/infra/agency/liaison-agent.ts` |
| CLI invocation registry | `src/core/runtime/cli-invocation.ts` |
| Orchestrator entry point | `scripts/orchestrator.ts` |
| State-feed listener | `scripts/state-feed-listener.ts` |
| Board entry point | `scripts/cli.cjs.js browser` |

---

*Audited live on 2026-05-16. System state may evolve; re-run discovery steps in §1–§3 to validate.*
