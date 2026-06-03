# AgentHive Web Dashboard — Test Plan v1

**Target:** `http://10.0.0.77:6420/board` (and all sibling routes)
**Canonical requirements:** [`docs/features/P387-universal-web-dashboard.md`](../../docs/features/P387-universal-web-dashboard.md)
**Tooling:** Playwright (Chromium) via `tests/dashboard-e2e/*.spec.ts`, runnable via `npx playwright test tests/dashboard-e2e/` on `bot` (where Chromium is cached).
**Out-of-scope for v1:** Safari-specific rendering (covered by a smaller follow-up tranche), accessibility deep-dive (separate audit), load testing (separate).

---

## 0. Pre-flight (one-off per environment)

| ID | Check | Expected | Verify via |
|---|---|---|---|
| PF-1 | Server reachable | `curl -sS http://10.0.0.77:6420/board` → HTTP 200 + non-empty HTML | curl |
| PF-2 | Static assets served | `/main.css`, `/styles/style.css`, `/favicon.png` all 200 | curl |
| PF-3 | API root responds | `/api/proposals?limit=1` → valid JSON array | curl |
| PF-4 | WebSocket reachable | Connect to `ws://10.0.0.77:3001`; first frame `{type:"connected"}` | `wscat` or test harness |
| PF-5 | Build version exposed | `/api/version` returns `{ version: "0.40.0" }` (or current) | curl |
| PF-6 | No console errors on load | Browser console emits 0 errors on `/board` | Playwright `page.on('console', …)` |

---

## 1. Cross-cutting concerns (apply to every page)

### 1.1 Navigation chrome (AppNav)
- **C-NAV-1**: All 16 nav links render: Dashboard, Board, Proposals, Directives, Agents, Teams, Channels, Dispatches, Knowledge, Documents, Decisions, Map, Routes, Statistics, Achievements, Settings.
- **C-NAV-2**: Active route highlighted via `isActive` (current path matches `href` or starts with `${href}/`).
- **C-NAV-3**: Drawer/menu opens on mobile breakpoint (`aria-label="Open navigation menu"` button visible <768px).
- **C-NAV-4**: Drawer closes on Escape, outside-click, and explicit close button.
- **C-NAV-5**: Logo links to `/`.

### 1.2 Theme
- **C-THM-1**: `localStorage.roadmap-theme` of `dark` adds `dark` class to `<html>` on first paint (FOUC prevention check via inline script).
- **C-THM-2**: System `prefers-color-scheme: dark` selects dark by default if no saved value.
- **C-THM-3**: Theme toggle persists across reload.

### 1.3 Health indicator
- **C-HLTH-1**: Block `/api/status` → red "Server disconnected" banner at top, z-50, with pulsing dot and **Retry** button.
- **C-HLTH-2**: Unblock → `SuccessToast` "Connection restored!" appears, then dismisses after ~3s.
- **C-HLTH-3**: WS bridge down (port 3001) → `connected: false` indicator surfaces somewhere in UI (probably DashboardPage); REST pages still functional.

### 1.4 Project scope
- **C-SCOPE-1**: Default scope: `localStorage.roadmap.project_scope.v1` absent → API requests carry no `X-Project-Id`; server returns default project rows.
- **C-SCOPE-2**: Set scope via Settings → reload → all API requests carry `X-Project-Id: <id>` header.
- **C-SCOPE-3**: Cross-tab sync: change scope in tab A, tab B's WS hook re-subscribes within ~1s (StorageEvent).

### 1.5 Routing
- **C-RTE-1**: Direct URL navigation to `/board`, `/proposals`, etc. all render without 404.
- **C-RTE-2**: Unknown path renders `NotFoundPage`.
- **C-RTE-3**: Browser back/forward navigates between SPA routes without full reload.

---

## 2. `/` — DashboardPage (project scope)

**Component:** `DashboardPage.tsx`. Operational overview: agents, routes, dispatches, pulse.

| ID | Test | Pass criteria |
|---|---|---|
| D-1 | Load `/` with mocked WS `proposal_snapshot` of 50 proposals | Renders count, no overflow, no console errors |
| D-2 | Agent panel | Shows count == `agents.length`; clicking an agent navigates to `/agents` or opens detail |
| D-3 | Channel panel | Shows N channels with msg_count |
| D-4 | Live update | Push a new proposal via WS pg_notify; UI updates within 5s |
| D-5 | Empty state | WS returns 0 proposals → "No proposals yet" message, not blank |
| D-6 | Connectivity | `connected: false` → degraded indicator visible |
| D-7 | Pulse / heartbeat | Last-seen times for agents within last 24h shown human-readable ("2m ago") |

**UX observations to flag** (file as proposal if confirmed):
- Does the dashboard show a single "production health at a glance" number? Currently it shows lists — a top-line KPI strip might help.

---

## 3. `/board` — BoardPage (kanban, project scope) — **TRANCHE 1**

**Component:** `BoardPage.tsx` + `Board.tsx` + `ProposalColumn.tsx` + `ProposalCard.tsx`. Workflow-aware: stages come from `useBoardStages(activeWorkflow)` hook → `GET /api/board/stages`.

### 3.1 Render
- **B-1**: Load `/board` with default workflow → renders columns for every stage in `boardStages` (Draft, Review, Develop, Merge, Complete + any extras).
- **B-2**: Each proposal appears in the column matching its `status` field.
- **B-3**: Card shows: display_id (`P###`), title, maturity badge, type badge, parent indicator (if any), priority indicator.
- **B-4**: Empty column shows zero-state placeholder (not collapsed).
- **B-5**: ~50+ proposals visible in COMPLETE → column virtualizes or paginates, no UI freeze.

### 3.2 Interaction
- **B-6**: Click a card → `ProposalDetailsModal` opens with full content (summary, design, ACs, reviews, discussion).
- **B-7**: Modal close (Escape, X button, outside click) → modal dismisses, URL preserved.
- **B-8**: Drag a card from one column to another → optimistic UI moves it, `PUT /api/proposals/:id` fires with new status, server confirms or reverts.
- **B-9**: Workflow selector → switch from "Standard RFC" to "Hotfix" → columns re-render to hotfix stages; persisted to `localStorage.roadmap.board.workflow`.
- **B-10**: Card hover → tooltip or quick-action affordances appear (if implemented).
- **B-11**: Keyboard: focusable cards via Tab; Enter opens modal; arrow keys move focus within column.

### 3.3 Live updates
- **B-12**: With board open, transition a proposal via MCP (`mcp_proposal transition`) → card animates to new column within 5s without full re-render.
- **B-13**: Create a new proposal via MCP → card appears in DRAFT within 5s.
- **B-14**: Delete a proposal → card disappears within 5s.

### 3.4 Filtering / search (if present)
- **B-15**: Filter by `type=feature` → only feature cards render.
- **B-16**: Filter by `maturity=obsolete` → obsolete proposals appear (otherwise hidden by default?).
- **B-17**: Search box matches title substring → filters in real-time.

### 3.5 Edge cases
- **B-18**: Proposal with no title → card shows display_id only, no crash.
- **B-19**: Proposal with extremely long title (200 chars) → truncated with ellipsis, full title in tooltip.
- **B-20**: Proposal with status not in current workflow's stages → routed to a "Unknown stage" bucket or hidden (verify intent).
- **B-21**: `live_activity` field populated → card shows pulsing indicator.
- **B-22**: Theme toggle while board open → columns and cards re-style correctly.
- **B-23**: `gate_scanner_paused=true` → some visual indicator on the card?

### 3.6 Mobile / responsive
- **B-24**: Mobile width (375px) → columns horizontally scroll, cards readable.
- **B-25**: Tablet width (768px) → columns wrap or compress, no overflow.

### 3.7 UX observations to flag
- Stage column headers should show count (e.g. "DRAFT (42)") — verify and file if missing.
- No bulk-action affordance — can the operator select multiple cards? File feature proposal if not.
- Workflow selector discoverability — is it labeled?

---

## 4. `/proposals` — ProposalsPage (project scope)

| ID | Test | Pass criteria |
|---|---|---|
| PR-1 | List render | Loads paginated list of all proposals; total count visible |
| PR-2 | Sort | Sort by created_at desc by default; sortable by status, maturity, priority |
| PR-3 | Filter | Status/type/priority filters narrow the list |
| PR-4 | Row click | Opens `ProposalDetailsModal` (same modal as board) |
| PR-5 | Search | Free-text search matches title/body/display_id |
| PR-6 | Pagination | "Next/prev" or infinite scroll works without re-fetching the world |
| PR-7 | Empty state | No results → "No proposals match your filter" |
| PR-8 | Modal navigation | From modal, Next/Prev cycles through the filtered list |

---

## 5. `/directives` — DirectivesPage (project scope)

| ID | Test | Pass criteria |
|---|---|---|
| DV-1 | List render | All directives load via `GET /api/directives` |
| DV-2 | Archived toggle | "Show archived" → `/api/directives/archived` loads additional rows |
| DV-3 | Edit | Inline edit (or modal) PUTs `/api/directives/:id`; success/error banners |
| DV-4 | Linked proposals | Directive shows linked proposal count and links |

---

## 6. `/agents` — AgentsPage (agency scope)

| ID | Test | Pass criteria |
|---|---|---|
| AG-1 | List render | All agents from `GET /api/agents` |
| AG-2 | Filter by status | active / offline / restricted segments |
| AG-3 | Trust tier | Tier badge visible (restricted / trusted / operator) |
| AG-4 | Last-seen | Human-readable relative time |
| AG-5 | Detail click | `AgentDetail` opens with capabilities, recent activity |
| AG-6 | Live update | New agent registers → list updates within 5s |
| AG-7 | Edge: empty identity | Agents with empty `agent_identity` (observed in DB) → hidden or labelled |

---

## 7. `/teams` — TeamsPage (agency scope)

| ID | Test | Pass criteria |
|---|---|---|
| TM-1 | Teams list | Renders from `GET /api/teams` |
| TM-2 | Members | Each team shows member count + roster |
| TM-3 | Add member | If UI supports, POST to `/api/teams/:id/members` |

---

## 8. `/channels` — ChannelsPage (project scope)

| ID | Test | Pass criteria |
|---|---|---|
| CH-1 | Channel list | All channels from `GET /api/channels` |
| CH-2 | Select channel | Click → message stream loads (`GET /api/messages?channel=`) |
| CH-3 | Send message | Type + send → `POST /api/messages`; appears in stream |
| CH-4 | Live updates | New message from another sender → appears within 5s |
| CH-5 | Long backlog | 1000+ messages → virtualized scroll, no lag |
| CH-6 | Empty channel | Zero-state placeholder |
| CH-7 | ACL block | If sender restricted → error toast (not silent fail) |

---

## 9. `/statistics` — StatisticsPage (project scope)

| ID | Test | Pass criteria |
|---|---|---|
| ST-1 | Counts | Total proposals, by status, by type, by maturity — all numbers consistent with `GET /api/statistics` |
| ST-2 | Charts | If charts present, render without console errors |
| ST-3 | Time-range filter | If present, last 7d / 30d / 90d filters narrow data |

---

## 10. `/activity` — ActivityFeed (project scope)

| ID | Test | Pass criteria |
|---|---|---|
| AC-1 | Feed renders | Recent events (proposal transitions, reviews, decisions) chronologically |
| AC-2 | Live append | New event → appears at top within 5s |
| AC-3 | Event filter | Filter by event_type if supported |
| AC-4 | Click-through | Each event links to its proposal |

---

## 11. `/dispatches` — DispatchPage (agency scope)

| ID | Test | Pass criteria |
|---|---|---|
| DP-1 | Active dispatches | `GET /api/dispatches` rows render |
| DP-2 | Status indicators | offered / claimed / running / completed / failed badges |
| DP-3 | Stale dispatches | Lease-expired entries surfaced with warning |
| DP-4 | Detail | Click → dispatch detail panel (proposal, agency, lease info) |

---

## 12. `/knowledge` — KnowledgePage (project scope)

| ID | Test | Pass criteria |
|---|---|---|
| KN-1 | List | `GET /api/knowledge` returns articles; render |
| KN-2 | Search | Full-text search filters |
| KN-3 | Article view | Click → detail with markdown rendering |

---

## 13. `/documents` — DocumentsPage (project scope)

| ID | Test | Pass criteria |
|---|---|---|
| DOC-1 | List | `GET /api/docs` |
| DOC-2 | Open | `GET /api/doc/:filename` renders markdown |
| DOC-3 | Edit | If editable, PUT `/api/docs/:filename` with optimistic UI |
| DOC-4 | Versions | If versioning UI present, version list loads |

---

## 14. `/decisions` — DecisionsPage (project scope)

| ID | Test | Pass criteria |
|---|---|---|
| DC-1 | Decisions list | `GET /api/decisions` |
| DC-2 | Decision detail | `GET /api/decision/:id` renders structured fields (context, decision, consequences) |

---

## 15. `/map` — MapPage (project scope)

| ID | Test | Pass criteria |
|---|---|---|
| MP-1 | DAG render | Proposal DAG visualized (mermaid? d3?) |
| MP-2 | Click node | Opens proposal modal |
| MP-3 | Zoom/pan | Pan and zoom controls work |
| MP-4 | Cycle detection | Cyclic dependencies highlighted in red |

---

## 16. `/routes` — RoutesPage (host scope)

**Per P387 §UX Flow 2.**

| ID | Test | Pass criteria |
|---|---|---|
| RT-1 | List | `GET /api/routes` rows with `has_host_policy_match` populated |
| RT-2 | Orphan badge | If N routes have `has_host_policy_match=false`, header shows `⚠ N no host policy` |
| RT-3 | Orphan row | Orphan rows have `bg-yellow-50` class and `⚠` prefix on model name |
| RT-4 | Toggle enable | Click toggle → optimistic UI update → `PATCH /api/routes/:id` fires |
| RT-5 | Toggle revert on error | Mock server 500 → UI reverts to previous state, error toast |
| RT-6 | Orphan does not block toggle | Toggle works on orphan rows (informational only) |
| RT-7 | Operator-only | If non-operator, toggle disabled with tooltip explaining |

---

## 17. `/settings` — SettingsPage (project scope)

**Per P387 §UX Flow 1, 3.**

| ID | Test | Pass criteria |
|---|---|---|
| SET-1 | Load | `GET /api/config` populates form |
| SET-2 | Validate | Invalid daemonUrl (e.g. `not-a-url`) → inline field error |
| SET-3 | Save success | Valid input + Save → `PUT /api/config` 200 → green banner 3s |
| SET-4 | Save failure | Mock 400 → red banner with server message; no DB write |
| SET-5 | Network error | Unreachable server → red banner; retry button works |
| SET-6 | Project switch | Change project ID → triggers `roadmap:project-scope-changed`; both `ApiClient` and `useWebSocket` refetch |
| SET-7 | Fallback mode | If `fallback_mode: true` in response, visible operator indicator |

---

## 18. `/achievements` — AchievementsView (project scope)

| ID | Test | Pass criteria |
|---|---|---|
| AV-1 | Render | Achievement cards display |
| AV-2 | Progress | If progress bars present, math checks out (granted / total) |

---

## 19. `*` — NotFoundPage

| ID | Test | Pass criteria |
|---|---|---|
| NF-1 | Random path | `/totally-fake-route` renders NotFoundPage |
| NF-2 | Go-home link | Link to `/` works |

---

## 20. WebSocket protocol checks (cross-page, run once)

Per P387 §WebSocket Bridge.

| ID | Test | Pass criteria |
|---|---|---|
| WS-1 | Connect | Open `ws://10.0.0.77:3001` → first message `{type:"connected"}` |
| WS-2 | `proposal_snapshot` on subscribe | Send `{type:"subscribe"}` → receive `proposal_snapshot` with array |
| WS-3 | `workforce_snapshot` | Receive on connect |
| WS-4 | `channels` | Receive on connect |
| WS-5 | `message_snapshot` per channel | Send `{type:"getMessages", channel:"broadcast"}` → receive last 50 |
| WS-6 | Push on state change | `pg_notify proposal_state_changed` → snapshot pushed within 1s |
| WS-7 | Poll fallback | Stop pg_notify subscriber; wait 6s; snapshot still arrives via polling |
| WS-8 | Write rejected | Send `{type:"createProposal"}` → response `{type:"error", code:"UNSUPPORTED"}` |
| WS-9 | Reconnect | Kill bridge, restart → client reconnects within exponential-backoff window |

---

## 21. UX/feature observations (raise as proposals if confirmed gaps)

1. **No bulk actions on /board** — multi-select cards for batch transition / labeling.
2. **No quick-filter chips on /board** — would need to click into a filter modal; faster as inline chips for status/maturity/type.
3. **Stage column count missing in headers** — operator can't see "how many in DRAFT" at a glance.
4. **No "claim" affordance on cards** — claiming a proposal currently requires MCP CLI; a click action on cards would speed gate review.
5. **No keyboard shortcuts hint** — `?` to show shortcut palette is standard; would improve power-user UX.
6. **Health indicator placement** — banner is top-of-viewport but disappears on scroll; sticky or persistent corner indicator might be better.
7. **Theme toggle discoverability** — is it on every page? Should be in AppNav or Settings consistently.
8. **Project switcher in chrome** — currently buried in Settings; promote to AppNav for multi-project operators.
9. **Activity feed event-type filters** — currently mixed firehose; allow toggling event categories.
10. **Map page UX** — if mermaid-based, lack of incremental update; consider d3 force-directed for large graphs.

(Each will be filed as a `feature` proposal via `mcp_proposal create` after manual verification under "Tranche 1-N" execution.)

---

## 22. Execution order

1. **Pre-flight** (PF-1..6) — confirm environment.
2. **Cross-cutting** (C-NAV, C-THM, C-HLTH, C-SCOPE, C-RTE).
3. **Tranche 1: /board** (B-1..25) — primary URL user asked about.
4. **Tranche 2: core pages** (Proposals, Agents, Settings, Routes).
5. **Tranche 3: supplementary pages** (Channels, Statistics, Activity, Dispatches).
6. **Tranche 4: long-tail pages** (Knowledge, Documents, Decisions, Map, Achievements, NotFoundPage).
7. **Tranche 5: WebSocket protocol** (WS-1..9).
8. **Findings sweep** — file proposals for confirmed UX/feature observations.

Each tranche produces:
- Pass/fail report per test ID
- Screenshots on fail (Playwright auto-captures)
- Proposals filed for findings
- This `PLAN.md` updated with verified outcomes

---

## 23. Cross-posting findings

- Bugs and feature ideas → `mcp_proposal create` (type `issue` for bugs, `feature` for UX/feature ideas)
- Critical or operator-facing issues → also cross-post as gitlab issues at `gitlab.local/agentRoadmap/agenthive/-/issues/new` when API is reachable from bot
- Each test ID that fails gets a `findings_blob` saved at `tests/dashboard-e2e/findings/<test-id>.md` with the failure detail + screenshot path
