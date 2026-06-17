# Decomposition Plan: `src/apps/server/index.ts`

**Source file:** `src/apps/server/index.ts` — 6 977 lines  
**Problem:** A single `RoadmapServer` class with ~100 private handler methods; routing is a
490-line `if/else` chain (`dispatchRequest`).  
**Goal:** Extract each route group into a focused router file under `src/apps/server/routes/`,
leaving `RoadmapServer` as a thin bootstrap/DI shell that mounts routers and manages lifecycle.

---

## 1. Structural Context

This is **not** an Express/Hono application. It uses Node's raw `createServer` with a manual
`if/else` dispatch chain. Decomposition therefore means:

1. Extract handler functions into router modules that receive shared services via DI.
2. Replace the `if/else` chain with router-registration calls (or adopt a lightweight router like
   `itty-router` / `hono` as a follow-up).

### Existing split-out helpers (already done — do not re-extract)

| File | Purpose |
|------|---------|
| `./operator-auth.ts` | `requireOperator`, `hashOperatorToken` |
| `./sla-metrics.ts` | SLA contract (dynamic import at line 1421) |
| `../mcp-server/http-compat.ts` | `handleDirectMcpRequest` |

### No existing `routes/` directory
`src/apps/server/routes/` does not yet exist — all handlers live inline in `index.ts`.

---

## 2. Shared / Cross-Cutting Layer (keep in `RoadmapServer` or a dedicated `shared/` module)

These are **not** route handlers; they must remain in the core server or a shared utility layer.

| Concern | Lines | Target |
|---------|-------|--------|
| Module-level helpers: `stripPrefix`, `ensurePrefix`, `parseProposalIdSegments`, `findProposalByLooseId`, `PREFIX_PATTERN` | 82–148 | `routes/proposal-id-utils.ts` (shared util) |
| Static-asset path resolution (`indexHtml`, `webDir`, favicon) | 150–177 | inline in `RoadmapServer` or `static-handler.ts` |
| Class fields + server/WSS handles | 178–215 | `RoadmapServer` (keep) |
| Service bootstrap: `ensureServicesReady`, `getContentStoreInstance`, `getSearchServiceInstance` | 349–400 | `RoadmapServer` (DI seam for routers) |
| `handleError` — shared error→Response mapper | 2587 | `routes/error-handler.ts` |
| WebSocket subsystem | 401–668 | `realtime/ws-broadcast.ts` (see §3) |
| Server lifecycle: `start`, `stop`, `openBrowser` | 696–948 | `RoadmapServer` (keep) |
| Request adapter: `handleHttpRequest`, `dispatchRequest` | 949–1495 | `RoadmapServer` (slim to mount/dispatch only) |
| Static-file + SPA-shell serving | 1010–1091, 1473–1493 | `routes/static-handler.ts` |

### Auth middleware gap
There is **no** centralized auth layer — operator gating (`requireOperator`) and bearer-context
wrapping (`verifyBoundBearer` + `agentContextStorage.run`) are copy-pasted across ~25 handlers.
During extraction, introduce shared wrappers:

- `routes/middleware/with-operator-auth.ts` — `withOperator(req, action, handler)`
- `routes/middleware/with-bearer-context.ts` — `withBearerContext(req, handler)`

---

## 3. Target Router Files

### `src/apps/server/routes/static-handler.ts`
Serves static assets and the SPA shell.

| Path pattern | Lines | Handler |
|---|---|---|
| Static files (`/assets/`, favicon, `webDir`) | 1010–1091 | (inline in `dispatchRequest`) |
| SPA catch-all + shell routes | 1473–1493 | (inline) |

---

### `src/apps/server/realtime/ws-broadcast.ts`
WebSocket / realtime subsystem. Large and fully self-contained.

| Method | Line | Purpose |
|--------|------|---------|
| `broadcastProposalsUpdated` | 401 | Broadcast proposal list update |
| `broadcastConfigUpdated` | 418 | Broadcast config change |
| `startChangePolling` | 428 | Start change-detection polling loop |
| `handleSubscribe` | 447 | Handle WS subscription message |
| `cleanupSubscriptions` | 480 | Clean up dead subscribers |
| `handleUnsubscribe` | 471 | Handle WS unsubscription message |
| `handleTableSubscribe` | 493 | Handle table-level WS subscription |
| `proposalToWsFormat` | 532 | Map proposal to WS wire format |
| `scheduleRoadmapEventsReconnect` | 585 | Schedule reconnect for events listener |
| `startRoadmapEventsListener` | 593 | Start DB events listener |
| `sendProposalSnapshot` | 630 | Send proposal snapshot over WS |
| `broadcastProposalUpdate` | 668 | Broadcast single-proposal update |

---

### `src/apps/server/routes/proposals-router.ts`
All proposal CRUD + lifecycle endpoints.

| Method | Path | Line (dispatch) | Handler (def line) | Purpose |
|--------|------|-----------------|-------------------|---------|
| GET | `/api/proposals` | 1108 | `handleListProposals` (1655) | List proposals with filters |
| POST | `/api/proposals` | 1109 | `handleCreateProposal` (1849) | Create proposal |
| GET | `/api/proposal/:id` | 1267 | `handleGetProposal` (1908) | Get single proposal (singular alias) |
| GET | `/api/proposals/:id` | 1274 | `handleGetProposal` (1908) | Get single proposal |
| PUT | `/api/proposals/:id` | 1275 | `handleUpdateProposal` (1990) | Update proposal (~150 lines) |
| DELETE | `/api/proposals/:id` | 1276 | `handleDeleteProposal` (2142) | Delete proposal |
| POST | `/api/proposals/:id/complete` | 1279 | `handleCompleteProposal` (2150) | Mark complete |
| POST | `/api/proposals/:id/release` | 1282 | `handleReleaseProposal` (2176) | Release |
| POST | `/api/proposals/:id/demote` | 1285 | `handleDemoteProposal` (2198) | Demote maturity |
| POST | `/api/proposals/:id/schema-drift-resolve` | 1288 | `handleSchemaDriftResolve` (2221) | Resolve schema drift |
| GET | `/api/proposals/:id/notes` | 1308 | `handleGetProposalNotes` (1928) | Discussion notes |
| GET | `/api/proposals/:id/decisions` | 1318 | `handleGetProposalDecisions` (1954) | Decisions for proposal |
| GET | `/api/proposals/:id/reviews` | 1328 | `handleGetProposalReviews` (1972) | Reviews for proposal |
| POST | `/api/proposals/reorder` | 1404 | `handleReorderProposal` (2755) | Reorder/resequence |
| GET | `/api/proposals/cleanup` | 1406 | `handleCleanupPreview` (2816) | Preview cleanup candidates |
| POST | `/api/proposals/cleanup/execute` | 1408 | `handleCleanupExecute` (2860) | Execute cleanup |
| POST | `/api/proposals/:id/state-machine/halt` | 1158 | `handleHaltProposalGate` (3261) | Halt gate (operator-gated) |
| POST | `/api/proposals/:id/state-machine/resume` | 1168 | `handleResumeProposalGate` (3330) | Resume gate (operator-gated) |

---

### `src/apps/server/routes/agents-router.ts`

| Method | Path | Line | Handler | Purpose |
|--------|------|------|---------|---------|
| GET | `/api/agents` | 1112 | `handleListAgents` (3073) | List agents |
| GET | `/api/agents/:identity` | 1121 | `handleGetAgentDetail` (4392) | Agent detail bundle |
| POST | `/api/agents/:identity/message` | 1129 | `handleSendAgentMessage` (4510) | Send DM to agent (operator-gated) |
| POST | `/api/agents/:identity/stop` | 1137 | `handleStopAgent` (3123) | Stop agent's active runs (operator-gated) |

---

### `src/apps/server/routes/cubics-router.ts`

| Method | Path | Line | Handler | Purpose |
|--------|------|------|---------|---------|
| POST | `/api/cubics/:id/stop` | 1149 | `handleStopCubic` (3186) | Stop a cubic (operator-gated) |

---

### `src/apps/server/routes/control-plane-router.ts`
The largest single handler (`handleControlPlaneOverview`, ~640 lines) lives here.
Extract its aggregation logic into a `ControlPlaneAggregator` service class to slim the route handler.

| Method | Path | Line | Handler | Purpose |
|--------|------|------|---------|---------|
| GET | `/api/control-plane/overview` | 1175 | `handleControlPlaneOverview` (3582) | Fleet/efficiency aggregate (~640 lines) |
| GET | `/api/control-plane/fleet` | 1177 | `handleControlPlaneFleet` (4224) | Fleet snapshot |
| GET | `/api/control-plane/efficiency` | 1179 | `handleControlPlaneEfficiency` (4275) | Efficiency metrics |
| GET | `/api/control-plane/identity` | 1181 | `handleControlPlaneIdentity` (4309) | Identity view |
| GET | `/api/control-plane/platform` | 1183 | `handleControlPlanePlatform` (4348) | Platform view |

---

### `src/apps/server/routes/operator-router.ts`
Operator audit, token management, and gate actions. The two large sub-handlers
(`handleOperatorSplit`, `handleOperatorCombine`) should be extracted as private functions within
this router module.

| Method | Path | Line | Handler | Purpose |
|--------|------|------|---------|---------|
| GET | `/api/operator/audit` | 1185 | `handleOperatorAudit` (3379) | Audit log read |
| POST | `/api/operator/tokens` | 1187 | `handleIssueOperatorToken` (3412) | Issue operator token |
| GET | `/api/operator/tokens` | 1189 | `handleListOperatorTokens` (3467) | List operator tokens |
| POST | `/api/operator/action` | 1214 | `handleOperatorGateAction` (6337) | Gate action dispatch |

Sub-handlers (move alongside):

| Handler | Line | Purpose |
|---------|------|---------|
| `handleOperatorAdvance` | 6407 | Advance proposal |
| `handleOperatorHold` | 6512 | Hold proposal |
| `handleOperatorMoveBack` | 6563 | Move proposal back |
| `handleOperatorSplit` | 6655 | Split proposal (~166 lines) |
| `handleOperatorCombine` | 6822 | Combine proposals (~155 lines, file end) |

---

### `src/apps/server/routes/operator-control-router.ts`
P435 Operator Control API.

| Method | Path | Line | Handler | Purpose |
|--------|------|------|---------|---------|
| GET | `/api/operator/control/dispatches` | 1192 | `handleControlListDispatches` (6085) | List active dispatches |
| GET | `/api/operator/control/agencies` | 1194 | `handleControlListAgencies` (6102) | List agencies |
| GET | `/api/operator/control/workers` | 1196 | `handleControlListWorkers` (6117) | List workers |
| POST | `/api/operator/control/stop` | 1198 | `handleControlStop` (6141) | Stop |
| POST | `/api/operator/control/suspend-agency` | 1200 | `handleControlSuspendAgency` (6177) | Suspend agency |
| POST | `/api/operator/control/drain-host` | 1202 | `handleControlDrainHost` (6200) | Drain host |
| POST | `/api/operator/control/cancel-dispatch` | 1204 | `handleControlCancelDispatch` (6229) | Cancel dispatch |
| POST | `/api/operator/control/terminate-worker` | 1206 | `handleControlTerminateWorker` (6252) | Terminate worker |
| GET | `/api/operator/control/feed` | 1208 | `handleControlFeed` (6276) | Control event feed |
| GET | `/api/operator/control/replay/:dispatchId` | 1211 | `handleControlReplay` (6310) | Replay dispatch events |

---

### `src/apps/server/routes/agencies-router.ts`

| Method | Path | Line | Handler | Purpose |
|--------|------|------|---------|---------|
| GET | `/api/agencies` | 1228 | `handleListAgencies` (5170) | List agencies (~220 lines) |
| POST | `/api/agencies/:id/action` | 1238 | `handleAgencyAction` (5391) | Perform agency action (operator-gated) |

---

### `src/apps/server/routes/dispatches-router.ts`

| Method | Path | Line | Handler | Purpose |
|--------|------|------|---------|---------|
| GET | `/api/dispatches` | 1242 | `handleListDispatches` (5114) | List dispatches |

---

### `src/apps/server/routes/messaging-router.ts`
Pulse, channels, messages, and message routes.

| Method | Path | Line | Handler | Purpose |
|--------|------|------|---------|---------|
| GET | `/api/pulse` | 1216 | `handleListPulse` (4625) | Activity pulse feed |
| GET | `/api/channels` | 1218 | `handleListChannels` (4671) | List channels |
| GET | `/api/messages` | 1220 | `handleListMessages` (4689) | List messages |
| POST | `/api/messages` | 1222 | `handleSendMessage` (4719) | Send message |
| GET | `/api/routes` | 1224 | `handleListRoutes` (4799) | List message routes |
| PATCH | `/api/routes/:id` | 1226 | `handleToggleRoute` (4837) | Toggle route (operator-gated) |

---

### `src/apps/server/routes/board-router.ts`

| Method | Path | Line | Handler | Purpose |
|--------|------|------|---------|---------|
| GET | `/api/board/stages` | 1244 | `handleGetBoardStages` (4875) | Board stage definitions |
| GET | `/api/board/columns` | 1246 | `handleGetBoardColumns` (4926) | Board columns (workflow-aware, cache-bustable) |
| GET | `/api/board/live-feed` | 1248 | `handleBoardLiveFeed` (5011) | Board live feed |

---

### `src/apps/server/routes/projects-router.ts`
Move `resolveProjectScope` helper (line 3523) alongside these handlers.

| Method | Path | Line | Handler | Purpose |
|--------|------|------|---------|---------|
| GET | `/api/projects` | 1173 | `handleListProjects` (3487) | List projects |

---

### `src/apps/server/routes/docs-router.ts`
**Note:** `handleGetArchDocs` is defined twice (lines 4752 and 6041); the 4752 instance is
shadowed. Resolve to a single definition during extraction.

| Method | Path | Line | Handler | Purpose |
|--------|------|------|---------|---------|
| GET | `/api/docs` | 1343 | `handleListDocs` (2341) | List docs |
| POST | `/api/docs` | 1344 | `handleCreateDoc` (2375) | Create doc |
| GET | `/api/doc/:id` | 1349 | `handleGetDoc` (2362) | Get doc (singular alias) |
| GET | `/api/docs/:id` | 1354 | `handleGetDoc` (2362) | Get doc |
| PUT | `/api/docs/:id` | 1355 | `handleUpdateDoc` (2391) | Update doc |
| GET | `/api/arch-docs` | 1250 | `handleGetArchDocs` (4752) | Architecture docs |

---

### `src/apps/server/routes/decisions-router.ts`

| Method | Path | Line | Handler | Purpose |
|--------|------|------|---------|---------|
| GET | `/api/decisions` | 1359 | `handleListDecisions` (2447) | List decisions |
| POST | `/api/decisions` | 1360 | `handleCreateDecision` (2489) | Create decision |
| GET | `/api/decision/:id` | 1365 | `handleGetDecision` (2468) | Get decision (singular alias) |
| GET | `/api/decisions/:id` | 1370 | `handleGetDecision` (2468) | Get decision |
| PUT | `/api/decisions/:id` | 1371 | `handleUpdateDecision` (2504) | Update decision |

---

### `src/apps/server/routes/drafts-router.ts`

| Method | Path | Line | Handler | Purpose |
|--------|------|------|---------|---------|
| GET | `/api/drafts` | 1375 | `handleListDrafts` (2593) | List drafts |
| POST | `/api/drafts/:id/promote` | 1382 | `handlePromoteDraft` (2603) | Promote draft to proposal |

---

### `src/apps/server/routes/directives-router.ts`
Move `resolveDirectiveInput` helper (line 216) alongside these handlers.

| Method | Path | Line | Handler | Purpose |
|--------|------|------|---------|---------|
| GET | `/api/directives` | 1386 | `handleListDirectives` (2620) | List directives |
| POST | `/api/directives` | 1387 | `handleCreateDirective` (2653) | Create directive |
| GET | `/api/directives/archived` | 1391 | `handleListArchivedDirectives` (2630) | List archived directives |
| GET | `/api/directives/:id` | 1397 | `handleGetDirective` (2640) | Get directive |
| POST | `/api/directives/:id/archive` | 1400 | `handleArchiveDirective` (2725) | Archive directive |

---

### `src/apps/server/routes/config-router.ts`

| Method | Path | Line | Handler | Purpose |
|--------|------|------|---------|---------|
| GET | `/api/config` | 1338 | `handleGetConfig` (2525) | Get config |
| PUT | `/api/config` | 1339 | `handleUpdateConfig` (2544) | Update config |

---

### `src/apps/server/routes/knowledge-router.ts`

| Method | Path | Line | Handler | Purpose |
|--------|------|------|---------|---------|
| GET | `/api/knowledge` | 1448 | `handleListKnowledge` (5504) | List knowledge entries |
| POST | `/api/knowledge/:id/helpful` | 1456 | `handleMarkKnowledgeHelpful` (5549) | Mark entry helpful |

---

### `src/apps/server/routes/notifications-router.ts`

| Method | Path | Line | Handler | Purpose |
|--------|------|------|---------|---------|
| PATCH | `/api/notifications/:id/seen` | 1297 | `handleMarkNotificationSeen` (2265) | Mark notification seen |

---

### `src/apps/server/routes/system-router.ts`
Miscellaneous meta/system endpoints plus legacy duplicates.

**Note:** `/api/sla` is registered twice — at line 1419 (inline dynamic import returning early) and
line 1459 (`handleGetSla`, unreachable). Remove the duplicate during extraction.

| Method | Path | Line | Handler | Purpose |
|--------|------|------|---------|---------|
| GET | `/api/statuses` | 1334 | `handleGetStatuses` (2328) | List statuses |
| GET | `/api/version` | 1411 | `handleGetVersion` (2744) | Version info |
| GET | `/api/statistics` | 1413 | `handleGetStatistics` (2965) | Proposal statistics |
| GET | `/api/status` | 1415 | `handleGetStatus` (2991) | Server status |
| GET | `/api/sla` | 1419 | (inline, dynamic import) | SLA contract (keep; remove dead duplicate at 1459) |
| POST | `/api/init` | 1434 | `handleInit` (3007) | Initialize project |
| GET | `/api/search` | 1436 | `handleSearch` (1739) | Search proposals/docs/decisions |
| GET | `/api/sequences` | 1439 | `handleGetSequences` (2930) | Get sequences |
| POST | `/api/sequences/move` | 1441 | `handleMoveSequence` (2935) | Move sequence |
| GET | `/api/teams` | 1444 | `handleListTeams` (5484) | List teams |
| GET | `/metrics` | 1464 | `handleMetrics` (5949) | Prometheus metrics |
| GET | `/sequences` | 1468 | `handleGetSequences` (2930) | Legacy alias |
| POST | `/sequences/move` | 1470 | `handleMoveSequence` (2935) | Legacy alias |

---

### `src/apps/server/routes/mcp-router.ts`

| Method | Path | Line | Handler | Purpose |
|--------|------|------|---------|---------|
| POST | `/mcp`, `/api/mcp` | 1093 | `handleDirectMcp` (1498) | Direct JSON-RPC MCP with bearer-principal wrapping |
| GET | `/api/mcp/sse` | 1256 | `handleMcpSse` (5567) | MCP SSE transport |
| POST | `/api/mcp/message` | 1262 | `handleMcpMessage` (5635) | MCP message POST (~290 lines; bearer + agentContext) |
| GET | `/healthz` | 1099 | `handleHealthz` (1557) | Health check |
| POST | `/smoke` | 1102 | `handleSmoke` (1603) | Smoke test |

---

## 4. Issues to Resolve During Decomposition

| # | Issue | Location | Resolution |
|---|-------|----------|------------|
| 1 | Duplicate `handleGetArchDocs` definition | Lines 4752 and 6041 | Remove 4752 (shadowed); keep 6041 or vice-versa — verify which is current |
| 2 | Duplicate `/api/sla` route | Lines 1419 and 1459 | Remove unreachable handler at 1459 |
| 3 | No central auth middleware | ~25 handlers | Introduce `withOperatorAuth` and `withBearerContext` wrappers before extracting affected routers |
| 4 | Singular/plural alias pairs | `/api/proposal/` vs `/api/proposals/`, etc. | Normalize to plural in each router; keep singular as deprecated alias if clients depend on it |
| 5 | `handleControlPlaneOverview` (~640 lines) | 3582–4223 | Extract aggregation into `ControlPlaneAggregator` service; route handler becomes a thin adapter |

---

## 5. Sequenced Extraction Order

Extraction is ordered by blast-radius (leaf routers first) and auth-middleware readiness.

| Phase | Router / module | Justification |
|-------|----------------|---------------|
| **1** | `routes/proposal-id-utils.ts` | Pure utils at top of file; zero routing change required |
| **1** | `routes/error-handler.ts` | Shared; all routers need it before extracting handlers |
| **1** | `routes/middleware/with-operator-auth.ts` | Must exist before extracting any operator-gated handler |
| **1** | `routes/middleware/with-bearer-context.ts` | Must exist before extracting MCP handlers |
| **2** | `routes/notifications-router.ts` | Single endpoint; trivial blast-radius |
| **2** | `routes/config-router.ts` | Two endpoints; no complex auth |
| **2** | `routes/knowledge-router.ts` | Two endpoints; no complex auth |
| **2** | `routes/dispatches-router.ts` | One endpoint |
| **2** | `routes/cubics-router.ts` | One endpoint |
| **2** | `routes/static-handler.ts` | No DI needed; pure file-serving |
| **3** | `routes/decisions-router.ts` | Clean CRUD; no operator auth |
| **3** | `routes/docs-router.ts` | Clean CRUD; fix duplicate `handleGetArchDocs` here |
| **3** | `routes/drafts-router.ts` | Two endpoints |
| **3** | `routes/directives-router.ts` | Small CRUD group |
| **3** | `routes/projects-router.ts` | Single endpoint + `resolveProjectScope` util |
| **3** | `routes/board-router.ts` | Three endpoints; no operator auth |
| **4** | `realtime/ws-broadcast.ts` | Self-contained but touches WS server instance |
| **4** | `routes/messaging-router.ts` | Pulse/channels/messages; one operator-gated route |
| **4** | `routes/system-router.ts` | Mixed; fix duplicate `/api/sla` here |
| **4** | `routes/agencies-router.ts` | Operator-gated; after auth middleware is in place |
| **4** | `routes/agents-router.ts` | Operator-gated; after auth middleware is in place |
| **5** | `routes/mcp-router.ts` | Bearer-context wrapping; `handleMcpMessage` is complex |
| **5** | `routes/operator-control-router.ts` | All operator-gated; after middleware phase |
| **5** | `routes/proposals-router.ts` | Largest router; do last — most routes, mix of auth levels |
| **5** | `routes/operator-router.ts` | Largest handlers; `handleOperatorSplit`/`Combine` end of file |
| **6** | `routes/control-plane-router.ts` | `handleControlPlaneOverview` needs service extraction first |
| **6** | `RoadmapServer` slim-down | Remove extracted methods; replace `dispatchRequest` with mount calls |

---

## 6. DI Contract for Router Modules

Each router module will export a `registerRoutes(deps: RouterDeps): RouteHandler[]` (or equivalent)
function. The `RouterDeps` interface collects what handlers actually need:

```ts
interface RouterDeps {
  core: Core;                         // roadmap business logic
  pool: Pool;                         // PG connection pool
  getContentStore(): ContentStore;
  getSearchService(): SearchService;
  wss: WebSocketServer;
  broadcast: BroadcastFns;            // from realtime/ws-broadcast.ts
  requireOperator: OperatorAuthFn;    // from operator-auth.ts
}
```

---

## 7. Acceptance Criteria Traceability

| AC | How satisfied |
|----|---------------|
| AC-2 | This document published on main branch; `git grep decomposition-plan-server-index docs/architecture/` returns this file |
| AC-3 | Section 5 "Sequenced Extraction Order" provides explicit dependency ordering, leaf-first |
| AC-4 | Operator review recorded as a discussion entry on P3844 before child extraction proposals are filed |
