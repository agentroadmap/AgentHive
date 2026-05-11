# P387 — Universal Web Dashboard: Multi-Project, Multi-Host, Multi-Agency Configuration Interface

**Status:** COMPLETE  
**Type:** Feature  
**Priority:** High

---

## Overview

P387 establishes the Universal Web Dashboard as the operational control center for AgentHive. It defines clear tenancy boundaries across projects, hosts, and agencies; adds validated config mutation flows; and delivers real-time projection via WebSocket. All changes are additive — no schema migrations were required.

---

## Architecture

### Routing (App.tsx)

The React SPA registers 16+ client-side routes via `wouter`:

| Route | Component | Tenancy |
|---|---|---|
| `/` | `DashboardPage` | Project |
| `/board` | `BoardPage` | Project |
| `/proposals` | `ProposalsPage` | Project |
| `/directives` | `DirectivesPage` | Project |
| `/agents` | `AgentsPage` | Agency |
| `/teams` | `TeamsPage` | Agency |
| `/channels` | `ChannelsPage` | Project |
| `/statistics` | `StatisticsPage` | Project |
| `/activity` | `ActivityFeed` | Project |
| `/dispatches` | `DispatchPage` | Agency |
| `/knowledge` | `KnowledgePage` | Project |
| `/documents` | `DocumentsPage` | Project |
| `/decisions` | `DecisionsPage` | Project |
| `/map` | `MapPage` | Project |
| `/routes` | `RoutesPage` | Host |
| `/achievements` | `AchievementsView` | Project |
| `/settings` | `SettingsPage` | Project |

### Component Tree

```
App
├── AppNav
└── main (Switch)
    ├── <route pages>
    └── ProposalDetailsModal (global overlay)
```

`App` owns all top-level WebSocket state (`proposals`, `agents`, `channels`) from the `useWebSocket` hook and fans them out to page components as props. Individual pages fetch their own supplemental REST data.

---

## Data Domains

| Domain | Table | Dashboard Surface |
|---|---|---|
| Proposals | `roadmap_proposal.proposal` | Board, Proposals, Dashboard |
| Agent registry | `roadmap_workforce.agent_registry` | Agents, Teams |
| Model routes | `roadmap.model_route` | Routes page |
| Host policy | `roadmap.host_model_policy` | Routes page (validation) |
| Project config | `roadmap.config` | Settings page |
| Channels | `roadmap.channel_subscription` | Channels page |
| Messages | `roadmap.message_ledger` | Channels page |
| Gate decisions | `roadmap.gate_decision_log` | Dashboard projection |
| Dispatches | `roadmap_workforce.squad_dispatch` | Dashboard, Dispatch page |

---

## Tenancy Boundaries

### Project Scope

Proposals, directives, documents, decisions, channels, and statistics are all scoped to the project identified by the stored `daemonUrl` / project ID. Every HTTP request from `ApiClient` reads the current project ID from `localStorage` key `roadmap.project_scope.v1` and injects it as an `X-Project-Id` header. The server's `resolveProjectScope` reads this header to pick the correct tenant DB.

**Storage module:** `src/apps/dashboard-web/lib/project-scope-storage.ts`

- `getStoredProjectId()` — reads `localStorage` (SSR-safe)
- `setStoredProjectId(id)` — writes and fires `roadmap:project-scope-changed` custom event
- `onProjectScopeChange(handler)` — subscribes to same-tab and cross-tab (`StorageEvent`) scope changes

Both the `ApiClient` (REST) and `useWebSocket` (WS subscribe) call `getStoredProjectId()` so every in-flight request carries the same scope.

### Host Scope

Model routes (`roadmap.model_route`) and host policy (`roadmap.host_model_policy`) are host-scoped, not project-scoped. The `/api/routes` endpoint joins routes against `host_model_policy` and adds a computed `has_host_policy_match: boolean` field. The `RoutesPage` component uses this to display orphan warnings.

### Agency Scope

Agent registry, dispatch assignments, and cubic workloads are agency-scoped. The operator `/api/operator/agencies` endpoint provides agency-level control.

---

## Mutation Authority

| Surface | Endpoint | Authority | Validation |
|---|---|---|---|
| Project config | `PUT /api/config` | Any authenticated caller | Schema validation; HTTP 400 + field errors on failure |
| Route enable/disable | `PATCH /api/routes/:id` | Operator-only | Optimistic UI; reverts on error |
| Proposals | `PUT /api/proposals/:id` | Any authenticated caller | Server-side |
| Directives | `PUT /api/directives/:id` | Any authenticated caller | Server-side |
| Documents | `PUT /api/docs/:filename` | Any authenticated caller | Server-side |

The WebSocket layer is **read-only** — it serves live projection data. Any write attempted over WebSocket returns `{ type: "error", code: "UNSUPPORTED" }`.

---

## UX Flows

### 1. Project Switching

1. Operator opens **Settings** (`/settings`).
2. Updates `daemonUrl` or project-identifying fields.
3. Clicks **Save Settings** → `PUT /api/config`.
4. On HTTP 200: `SuccessToast` confirms save; dashboard state refreshes.
5. On HTTP 400: field-level error displayed inline; no write committed to DB.

`setStoredProjectId()` fires `roadmap:project-scope-changed` so both `ApiClient` and `useWebSocket` refetch/resubscribe under the new scope without a full page reload.

### 2. Unavailable Hosts (Routes Page)

When `/api/routes` is fetched, each route carries `has_host_policy_match`. The `RoutesPage` component:

- Counts orphans: `routes.filter(r => r.has_host_policy_match === false).length`
- Shows a yellow warning badge in the page header: `⚠ N no host policy`
- Highlights orphan rows with `bg-yellow-50` and a `⚠` prefix on the model name column

Enable/disable toggle is available on all routes (operator-level); orphan status is informational only and does not block toggle.

### 3. Config Validation

`SettingsPage` calls `apiClient.updateConfig(config)` on save:
- HTTP 200 → success message shown for 3 seconds via inline banner
- HTTP 400 → `setError()` renders an inline red banner with the server's error message
- Network error → same red banner

---

## WebSocket Bridge

**File:** `src/apps/dashboard-web/websocket-server.ts`  
**Port:** 3001 (configurable)  
**Transport:** `ws://` (raw WebSocket, no auth at the bridge layer)

### Data Sources

The bridge reads directly from Postgres (not from HTTP endpoints) to avoid routing through the app server:

```
loadProposals()  → roadmap_proposal.proposal
loadAgents()     → roadmap_workforce.agent_registry
loadChannels()   → roadmap.channel_subscription
loadMessages()   → roadmap.message_ledger
```

### Push Architecture

Two delivery mechanisms run in parallel:

1. **Polling:** `setInterval(broadcastSnapshot, 5000)` — 5-second heartbeat to all connected clients
2. **pg_notify:** `LISTEN proposal_state_changed`, `LISTEN proposal_gate_ready`, `LISTEN proposal_maturity_changed` — fires `broadcastSnapshot` on DB state changes for near-real-time updates

The `pg_notify` subscriber self-heals: on connection failure it retries with exponential backoff capped at 60 seconds (attempts 1→64→60s pattern), so temporary Postgres restarts don't silently degrade the bridge to poll-only mode.

### Wire Protocol

**Server → Client messages:**

| `type` | Payload | Description |
|---|---|---|
| `connected` | `{ message }` | Sent on WS handshake |
| `proposal_snapshot` | `{ data: Proposal[] }` | Full proposal list |
| `workforce_snapshot` | `{ data: Agent[] }` | Full agent list |
| `channels` | `{ data: Channel[] }` | Channel list |
| `message_snapshot` | `{ data: Message[], channel }` | Last 50 messages for a channel |
| `proposal` | `{ data: Proposal \| null }` | Single proposal lookup |
| `messages` | `{ data: Message[], channel }` | Messages response |
| `subscribed` | `{ channel }` | Subscribe acknowledgement |
| `error` | `{ message, code? }` | Error response |

**Client → Server messages:**

| `type` | Description |
|---|---|
| `getProposals` | Request full snapshot |
| `getProposal` | Request single proposal by `id` |
| `getAgents` | Request agent list |
| `getChannels` | Request channel list |
| `getMessages` | Request messages for `channel` |
| `subscribe` | Subscribe and receive full snapshot |
| `createProposal` | Rejected — not supported over WS |

---

## API Client

**File:** `src/apps/dashboard-web/lib/api.ts`  
**Class:** `ApiClient`

Features:
- Retry logic with exponential backoff (3 retries, 10s timeout default)
- 4xx errors not retried (client errors)
- `X-Project-Id` header auto-injected on every request from `getStoredProjectId()`
- `ApiError` and `NetworkError` typed exception classes for caller discrimination

Key methods and endpoints:

| Method | Endpoint | Purpose |
|---|---|---|
| `fetchProposals()` | `GET /api/proposals` | List with filters (status, assignee, parent, priority, labels) |
| `fetchProposal(id)` | `GET /api/proposal/:id` | Single proposal |
| `fetchRoutes()` | `GET /api/routes` | Routes with `has_host_policy_match` |
| `toggleRoute(id, enabled)` | `PATCH /api/routes/:id` | Enable/disable route |
| `fetchConfig()` | `GET /api/config` | Project config |
| `updateConfig(config)` | `PUT /api/config` | Validated config write |
| `fetchStatistics()` | `GET /api/statistics` | Proposal stats + counts |
| `fetchDispatches()` | `GET /api/dispatches` | Active dispatches |
| `fetchChannels()` | `GET /api/channels` | Channel list |
| `fetchMessages(channel)` | `GET /api/messages?channel=` | Messages for channel |
| `sendMessage(channel, text)` | `POST /api/messages` | Post message |
| `search(options)` | `GET /api/search` | Cross-type search |

---

## Health Indicator

**File:** `src/apps/dashboard-web/components/HealthIndicator.tsx`  
**Context:** `HealthCheckContext`

When the server is unreachable (`isOnline === false`):
- A full-width red banner appears at the top of the viewport (`z-50`)
- Shows "Server disconnected" with a pulsing dot
- Provides a **Retry** button that calls `retry()` from context

When connection is restored, `HealthSuccessToast` shows "Connection restored!" via the `SuccessToast` component.

Operator-visible failure signals:
- Red banner = HTTP server is unreachable
- WebSocket `connected` field = bridge connectivity
- `fallback_mode` flag in config response (if set) indicates degraded operation

---

## Migration Boundary

All P387 changes are **additive**:

- No new Postgres schema migrations
- `has_host_policy_match` is a computed field added to `GET /api/routes` response — old callers that don't read it are unaffected
- WebSocket wire protocol additions (`workforce_snapshot`, per-channel `message_snapshot`) are new message types; existing clients that don't handle them ignore them
- Project scope storage key `roadmap.project_scope.v1` is new — absence is treated as "no scope filter" by both client and server

Rollback: remove the `X-Project-Id` injection from `ApiClient` and the orphan-badge UI from `RoutesPage`; all other behavior reverts to pre-P387 state without data loss.

---

## Verification Plan

### Test Matrix

| Area | Test | Signal |
|---|---|---|
| Project scope injection | Send request with projectId in localStorage; assert `X-Project-Id` header on outgoing fetch | Browser devtools / network tab |
| Orphan badge | Seed a route with no matching `host_model_policy`; load RoutesPage; assert yellow badge visible | Visual + DOM assertion |
| Orphan row highlight | Same seed; assert row has `bg-yellow-50` class | DOM assertion |
| Route toggle | Click toggle; assert optimistic update; mock server error; assert revert | Unit test |
| Config save success | Mock `PUT /api/config` → 200; assert success banner | Component test |
| Config save failure | Mock `PUT /api/config` → 400; assert error banner; assert no nav reload | Component test |
| WS snapshot on connect | Connect WS client; assert `proposal_snapshot`, `workforce_snapshot`, `channels`, `message_snapshot` received | Integration test |
| WS pg_notify push | Fire `pg_notify proposal_state_changed`; assert client receives new snapshot within 1s | Integration test |
| WS poll fallback | Disable pg_notify; wait 6s; assert snapshot received via poll | Integration test |
| WS write rejection | Send `createProposal` over WS; assert `{ type: "error", code: "UNSUPPORTED" }` | Integration test |
| Cross-tab scope sync | Set projectId in tab A; assert tab B `useWebSocket` re-subscribes | Browser integration test |
| Health banner | Block `/api/status`; assert red banner; unblock; assert "Connection restored" toast | E2E (Playwright) |

### Rollback Notes

1. `has_host_policy_match` can be dropped from the `/api/routes` response — `RoutesPage` will show 0 orphans and no badges (safe degradation)
2. `X-Project-Id` header injection can be removed from `ApiClient` without breaking the server — server treats missing header as "no scope filter"
3. WebSocket bridge port 3001 can be stopped independently; the React app will show `connected: false` and fall back to REST polling on affected pages

### Operator-Visible Failure Signals

| Signal | Location | Meaning |
|---|---|---|
| Red "Server disconnected" banner | Top of every page | HTTP server unreachable |
| `connected: false` in App state | WS hook | Bridge on port 3001 is down |
| `⚠ N no host policy` badge | Routes page header | Routes exist with no matching host policy row |
| Yellow row highlight on Routes page | Routes table | Individual orphan route |
| `fallback_mode: true` in config | `/api/config` response | Server running in degraded mode |
| MCP error prefix `[dashboard]` | MCP tool errors | Dashboard MCP tools failing |

---

## Implementation Files

| File | Purpose |
|---|---|
| `src/apps/dashboard-web/App.tsx` | Root — route registration, WebSocket state fan-out |
| `src/apps/dashboard-web/components/RoutesPage.tsx` | Host policy UX, orphan detection, route toggle |
| `src/apps/dashboard-web/components/SettingsPage.tsx` | Config form with validated save |
| `src/apps/dashboard-web/components/DashboardPage.tsx` | Operational dashboard — agents, routes, dispatches, pulse |
| `src/apps/dashboard-web/components/HealthIndicator.tsx` | Disconnect banner + restored toast |
| `src/apps/dashboard-web/lib/api.ts` | `ApiClient` — retry, X-Project-Id injection, typed errors |
| `src/apps/dashboard-web/lib/project-scope-storage.ts` | Shared project ID storage (localStorage + event bus) |
| `src/apps/dashboard-web/websocket-server.ts` | WS bridge — Postgres reads, pg_notify, broadcast |
| `src/apps/dashboard-web/hooks/useWebSocket.ts` | WS client hook — typed message dispatch, reconnect |
| `src/apps/server/index.ts` | HTTP server — 30+ endpoints including routes, config, dispatches |
