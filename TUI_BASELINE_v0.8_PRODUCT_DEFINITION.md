# TUI Baseline v0.8 — Product Definition

**Proposal:** P1383  
**Anchor:** git tag `v0.8-tui-baseline` on commit `78b350e4`  
**Date:** 2026-05-23  
**Version:** 0.34.0

## Purpose

This document anchors the working TUI baseline at commit `78b350e4` (tagged `v0.8-tui-baseline` on 2026-05-23). It documents user-visible TUI behaviors and structural invariants so a future regression has a clear restore point and a playbook to avoid re-debugging blessed library quirks.

The TUI is NOT under active development — we document it to preserve hard-won knowledge about neo-neo-bblessed edge cases discovered during prior implementation phases.

## Architecture Overview

The TUI is invoked via `roadmap board` and implemented in `src/apps/ui/`. The entry point is `cli.ts:handleBoardView()`, which calls `runUnifiedView()` from `unified-view.ts`. The unified view manages a state machine that cycles through six views:

```
kanban → cockpit → headlines → chat → proposal-list → kanban (repeat)
```

Each view owns its screen (created via `createScreen()` from `tui.ts`). On Tab press, the current screen is destroyed (`screen.destroy()`) and the next view creates a fresh screen. This is the current contract — P1139 tracks a single-screen refactor.

## View Behaviors

### View 1: Kanban (RFC Board)

**Command:** `roadmap board`  
**Initial view:** Kanban  
**Cycle position:** 1 of 6  

#### Filters (Header)

The kanban board displays seven filter controls in the header, in this order:

1. **Search** — full-text proposal search
2. **Workflow** — dropdown to select workflow template (RFC | Hotfix | Obsolete)
3. **Status** — dropdown to filter by proposal status (populated from current workflow's statuses)
4. **Maturity** — dropdown (new | active | mature | obsolete)
5. **Priority** — dropdown (high | medium | low)
6. **Directive** — dropdown (populate from loaded directives)
7. **Labels** — multi-select (populated from configured labels and proposals)

Source: `src/apps/ui/components/filter-header.ts`  
Implementation: `createFilterHeader()` function

#### Board Display

- **Columns** — dynamic, reflect current workflow's statuses. Each column header shows status name.
- **Hidden-empty toggle** (`~`) — shows/hides empty columns
- **Hidden-terminal toggle** (`=`) — shows/hides terminal-status columns (COMPLETE, BLOCKED, WONT_FIX, NON_ISSUE)
- **Feed pane** (right side) — shows live system events (state/maturity transitions, agent_runs, proposal_event, token_ledger, cache_hit_log)

#### Feed Pane Details

- **Source:** `getBoardLiveFeed()` (same query as Headlines view)
- **Caching:** Module-scope cache (`live-feed.ts:lastSuccessfulFeed`) — re-entry after transient DB-pool failure does NOT blank the feed
- **Auto-refresh:** Events every 3s, proposals every 5s
- **Message format:**
  - Agent runs: `P### run-##### <stage> <status> (<route_provider>/<agent_provider>) [<duration>s]`
  - State/maturity transitions: `P### moved from OLD to NEW by <actor>`
  - Legacy identity masking: obfuscated hash identities (e.g., `ccs46ant-bot-archi-a`) are hidden; sender shown as CLI name (`claude`/`codex`/`gemini`) for legacy routes

#### Mouse Interaction

- **Column click** — focuses the column
- **Proposal row click** — moves selection to that row
- **Double-click** (within 400ms) — opens quick-edit popup
- **Drag-drop** — drag a proposal between columns → invokes move_proposal flow

#### Keyboard Interaction

- **Tab** — cycle to next view (cockpit)
- **q** / **Ctrl+C** — exit TUI cleanly

---

### View 2: Cockpit (Engineer's Cockpit)

**Cycle position:** 2 of 6  
**Initial load time:** ~100ms (import) + ~50ms (screen create) + ~50ms (render) = ~200ms typical

#### Workforce Panel (F1)

Header format:  
```
<N> agencies · <N> agents · <N> online · <N> working · <N> ready
```

Field definitions:
- **agencies** — count of rows in `roadmap.agency` table
- **agents** — count of distinct agencies with status updates
- **online** — count where `presenceOnline = true`
- **working** — count where `status='active'` AND `currentProposal IS NOT NULL`
- **ready** — count where `status='active'` AND `currentProposal IS NULL` (idle agents)

All status markers are **ASCII-only** (`[*]`, `[ ]`, `(.)`) — no emoji in side-by-side panels (emoji shifts adjacent columns in blessed).

#### Layout

- Configurable via `FlagKeys.TUI_COCKPIT_LAYOUT` (runtime config flag)
- Values: `grid` (default) or `stacked`
- Fallback chain: `FlagKeys.TUI_COCKPIT_LAYOUT` → env `AGENTHIVE_COCKPIT_LAYOUT` → `grid`

#### Panels (F1–F4)

- **F1** — Workforce (agency roster grouped by provider@host)
- **F2** — Ledger (spending summary; shows top 10 agents by spend today)
- **F3** — Pipeline (status counts: DRAFT, REVIEW, DEVELOP, MERGE, COMPLETE, BLOCKED, etc.)
- **F4** — Recent Activity (last 5–50 proposals + messages)

#### Refresh

- 1.5s interval (all queries are small aggregations / LIMIT N, ~10–20ms total)
- Queries are **sequential**, NOT parallel (pool hang on writePoolAudit step under parallel load)
- Defensive flag: skip a tick if previous refresh is stuck

#### Keyboard Interaction

- **Tab** — cycle to headlines
- **q** / **Ctrl+C** — exit TUI cleanly

---

### View 3: Headlines (System Feed)

**Cycle position:** 3 of 6  

#### Rendering

Full-width event stream. Each row format:  
```
[timestamp] sender ❯ message
```

#### Data Source

- **Shared query:** `getBoardLiveFeed()` (same source as kanban Feed pane)
- **No separate query** — Headlines view reuses the kanban feed logic
- **Events included:** state/maturity transitions, agent_runs, proposal_event, token_ledger, cache_hit_log

#### Sender Column (Agent Identity)

For legacy hash identities (regex match: `^[a-z0-9]{6,10}-bot-[a-z]{3,6}-[a-z]`):
- Display CLI name from `model_routes.agent_cli` (`claude`/`codex`/`gemini`/`copilot`/`hermes`)
- Omit the obfuscated hash from message body

For permanent agent names (`andy`, `mimo`, `skeptic-beta`):
- Pass through unchanged

For cron-driven transitions:
- Show `system`

**Note:** Operator/CLI-driven transitions append ` by <transitioned_by>` so actor is never missing.

#### Refresh

- 1s interval
- 100 most recent events

#### Keyboard Interaction

- **Tab** — cycle to chat
- **q** / **Ctrl+C** — exit TUI cleanly

---

### View 4: Chat

**Cycle position:** 4 of 6  

#### Layout

- **Left sidebar** — channel list (populated from `message_ledger.channel` DISTINCT)
- **Main pane** — message log (conversation history)
- **Bottom** — input textbox (`readInput()`)

#### Focus & Navigation

- **Esc from input** — defocuses input, focuses sidebar (via textbox `cancel` event)  
  *Note:* `readInput()` silently consumes Esc; no callback fires. Listen on textbox `cancel`.
- **Tab from input** — cycles view (triggers `onSwitchView` callback)
- **Ctrl+C from input** — exits TUI cleanly

#### Channel Switching

- **Keyboard:** Esc, ↓ (or ↑), Enter (3 keystrokes)
- **Mouse:** single click on channel name in sidebar

#### Mouse Implementation

- **Sidebar selection** uses screen-level `mousedown` + bounding-box hit-test
- **NOT `blessed.list` click events** — `blessed.list.mousedown` only moves cursor, never emits `select`
- **Input/Log interaction** — input click focuses + starts reading; log click defocuses input for scrolling

#### Refresh Decoupling

- **Refresh loop** (1s interval) updates message log + channel list ONLY
- **Never calls** `.focus()` or `.readInput()` from refresh loop (caused recursive stack overflow before fix)
- **Border colors** signal focus:
  - Bright yellow = focused
  - Dim/cyan = idle

#### Keyboard Interaction

- **Tab** — cycle to proposal-list
- **q** / **Ctrl+C** — exit TUI cleanly

---

### View 5: Proposal-List (Master–Detail)

**Cycle position:** 5 of 6  

#### Filters

Same **7 filters** as kanban view (shared header):
1. Search
2. Workflow
3. Status
4. Maturity
5. Priority
6. Directive
7. Labels

#### Display

- **Left pane** — list of proposals (filtered/sorted per filter settings)
- **Right pane** — selected proposal markdown (detail view)

#### Behavior

- Search-focused when launched via `roadmap board <query>`
- Initial focus: search box or proposal list (context-dependent)

#### Keyboard Interaction

- **Tab** — cycle to kanban
- **q** / **Esc** — exit TUI cleanly

---

## Structural Invariants (The Hard-Won Blessed Rules)

These are **not** implementation details — they are facts about neo-neo-bblessed discovered over multiple sessions. Any future contributor MUST honor them:

1. **`box({...})` MUST pass `parent: screen`** or it's silently orphaned and renders invisible.

2. **Emoji in side-by-side panels** shifts adjacent column content. Use **ASCII markers** only.

3. **`readInput()` silently consumes `Esc`** — no callback, no `screen.key('esc')` bubble. Listen for the textbox's `cancel` event instead.

4. **`readInput.grabKeys` blocks `screen.key('tab')`** too. Bind `tab` on the textbox element via a callback to the caller.

5. **`blessed.list` mousedown only moves cursor, never emits `select`.** Use screen-level mousedown + bounding-box hit-test for sidebar selection.

6. **`roadmap` bin runs `scripts/cli.cjs.js`** (a 4MB pre-built bundle), NOT the TS source.
   - Edits to `src/apps/ui/*.ts` need `node scripts/build-dist.cjs` (~100ms) before the live binary picks them up
   - The bundle is gitignored

7. **`screen.destroy()` between view switches** is the current contract.
   - P1139 tracks a single-screen refactor
   - Until that lands, every view owns its screen and is responsible for clearing its timers on destroy

---

## Filter Header (All Views that Use It)

The filter header is shared across **Kanban** and **Proposal-List** views.

### Filter Items (7 total, in order)

Source: `src/apps/ui/components/filter-header.ts:ALL_FILTER_ITEMS`

| # | Name | Type | Source | Values |
|---|------|------|--------|--------|
| 1 | Search | Text input | User input | Any string |
| 2 | Workflow | Dropdown | `getAvailableWorkflows()` | RFC, Hotfix, Obsolete |
| 3 | Status | Dropdown | `currentStatuses` (from active workflow) | DRAFT, REVIEW, DEVELOP, ... |
| 4 | Maturity | Dropdown | Fixed enum | new, active, mature, obsolete |
| 5 | Priority | Dropdown | Fixed enum | high, medium, low |
| 6 | Directive | Dropdown | Loaded directives | [all available directives] |
| 7 | Labels | Multi-select popup | Proposal + config labels | [available labels] |

**Note:** AC-11 corrects an earlier version that claimed "six controls" — the canonical source is filter-header.ts, which has 7.

---

## Live-Feed Module Details

**Source:** `src/apps/ui/live-feed.ts`

### Cache Behavior

The feed pane and Headlines view both use `getBoardLiveFeed()`, which:

- Queries the live event tables (state_transitions, agent_runs, proposal_event, token_ledger, cache_hit_log)
- Caches the last-good result at module scope (`lastSuccessfulFeed`)
- On transient DB-pool failure (ECONNREFUSED, timeout), returns cached result instead of rendering blank
- Cache is NOT TTL'd — it persists until a successful query overwrites it

This defensive behavior prevents flicker when the pool hiccups during a re-entry or refresh.

### Message Formatting

Each event is formatted as `{id, message, timestamp, agentId, type}`:

**Agent Run:**  
`P### run-##### <stage> <status> (<route_provider>/<agent_provider>) [<duration>s]`

**State/Maturity Transition:**  
`P### moved from OLD_STATE to NEW_STATE by <actor>`

**Legacy Identity Masking:**  
If `agent_identity` matches regex `^[a-z0-9]{6,10}-bot-[a-z]{3,6}-[a-z]`:
- Substitute `agentId` = `COALESCE(route.agent_cli, route.route_provider, 'agent')`
- CASE statement → empty string (omit obfuscated hash from body)

---

## Performance Characteristics

### Build & Bundle

- **Source:** TypeScript in `src/apps/ui/*.ts`
- **Build:** `node scripts/build-dist.cjs` (~100ms)
- **Bundle:** `scripts/cli.cjs.js` (4.47 MB, 4471975 bytes as of 2026-06-10)
- **Binary:** `/data/code/AgentHive/scripts/cli.cjs.js` (executable)

### Refresh Intervals

| View | Refresh Interval | Query Cost | Purpose |
|------|------------------|-----------|---------|
| Kanban | 5s (proposals), 3s (events) | ~100–200ms | Keep board current |
| Headlines | 1s | ~50ms | Near-live feed |
| Cockpit | 1.5s | ~10–20ms (small aggregations) | Quick status snapshot |
| Chat | 1s | ~20ms | Message + channel list |

### Stability Checks

- **Snapshot test:** Two snapshots of any view at rest, 6 seconds apart, are byte-identical (no flicker, no unintended renders)
- **Multi-cycle stability:** 3 full Tab rotations with `AGENTHIVE_TUI_PERF=1` produce zero error/undefined/TypeError/RangeError lines to stderr

---

## Restoration Procedure

If a future change breaks any AC behavior:

```bash
git checkout v0.8-tui-baseline -- src/apps/ui/ src/apps/cli.ts
node scripts/build-dist.cjs
```

This restores ALL AC behaviors documented above. Then re-apply only the diffs your change needed, instead of re-debugging blessed quirks from scratch.

### Notes on Branch Divergence

The tag `78b350e4` was created on `main` (2026-05-23). If you're on a diverged branch (e.g., `codex-one`):

- The restore command still works (git copies file content by object hash)
- BUT any non-TUI commits on that branch will remain
- If you need full baseline parity, merge from `main` first

---

## Related Proposals (Do Not Re-File)

These proposals address specific aspects mentioned in AC:

- **P247** — Tab/W duplicate key registration (COMPLETE, foundational)
- **P777** — TUI Board force Workflow filter + dynamic columns (COMPLETE)
- **P1065** — TUI Board agent presence & per-agent messaging (REVIEW)
- **P1066** — TUI Config Flag Editor (DRAFT mature)
- **P1067** — TUI Operator Shell (DRAFT)
- **P1139** — TUI single-screen refactor (DRAFT) — removes per-view screen.destroy() contract
- **P1377** — TUI workforce panel count math (DRAFT mature)
- **P1374** — Cockpit ready/cooling split (DRAFT)

---

## Version Bumping

Version bumped from **0.33.0 → 0.34.0** to mark this baseline.  
**v1.0** is reserved for the new-orchestration cutover.

---

## Acceptance Criteria Verification Map

This product definition satisfies the 12 ACs of P1383:

| AC # | Title | Section | Status |
|------|-------|---------|--------|
| 1 | View rotation cycle & screen.destroy() | View Behaviors, Structural Invariants | Documented |
| 2 | View 1 mouse interactions | View 1: Kanban | Documented |
| 3 | View 1 Feed pane & View 3 Headlines share getBoardLiveFeed() | View 1 & 3, Live-Feed Module | Documented |
| 4 | Feed message format (no obfuscated hash) | Live-Feed Module | Documented |
| 5 | Headlines sender column (agent_cli for legacy IDs) | View 3: Headlines, Live-Feed Module | Documented |
| 6 | Cockpit Workforce header + layout + ASCII markers | View 2: Cockpit | Documented |
| 7 | Chat channel switching (keyboard + mouse) | View 4: Chat | Documented |
| 8 | Chat refresh decoupling (1s loop, no .focus() from loop) | View 4: Chat | Documented |
| 9 | Snapshot stability (2× byte-identical, 3-cycle no errors) | Performance Characteristics | Verifiable via test |
| 10 | Restore procedure & rebuild | Restoration Procedure | Documented |
| 11 | Filter header: 7 controls in correct order | Filter Header section | Documented |
| 12 | Cockpit Workforce header (ready/working definitions) | View 2: Cockpit, Workforce Panel | Documented |

---

**Document Author:** Claude Code (Developer Agent)  
**P1383 Status:** AC documentation phase  
**Last Updated:** 2026-06-10  
