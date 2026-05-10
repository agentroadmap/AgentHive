# P276: Proposal Detail Timeline and Canonical Export

## Status
- Proposal: P276 (COMPLETE)
- SQL View: DEPLOYED (migration 041 — `v_proposal_detail`)
- Export Module: DEPLOYED (`src/shared/proposal-markdown-export.ts`)
- MCP Tool: DEPLOYED (`prop_get_detail` — registered in P383)
- Web UI: DEPLOYED (`ProposalDetailsModal.tsx`)

---

## Problem

Before P276, no single source of truth existed for a proposal's full working history. Getting a complete picture required multiple separate queries for discussions, reviews, gate decisions, criteria, dispatches, and lease state. The web dashboard showed only the core proposal fields; the export format was not guaranteed to match what was shown in the UI.

---

## Solution

A three-layer canonical projection:

1. **Database layer** — `v_proposal_detail` (migration 041) aggregates every child entity for a proposal into a single row using `LEFT JOIN LATERAL` + `jsonb_agg`.
2. **Export layer** — `buildProposalMarkdown()` (`src/shared/proposal-markdown-export.ts`) produces an identical canonical `.md` representation in both the TUI and the web dashboard.
3. **UI layer** — `ProposalDetailsModal` fetches decisions, reviews, and discussions from dedicated REST endpoints and renders them as sections below the core content.

---

## Database Layer: `v_proposal_detail`

**Location:** `scripts/migrations/041-proposal-detail-view.sql`  
**Schema:** `roadmap_proposal.v_proposal_detail`

### What it aggregates

| Column | Source table | Notes |
| :--- | :--- | :--- |
| Core fields | `roadmap_proposal.proposal` | id, display_id, type, status, maturity, title, summary, motivation, design, drawbacks, alternatives, dependency_note, priority, tags, audit, timestamps, required_capabilities |
| `dependencies` | `proposal_dependencies` ⨯ `proposal` | JSONB array: `{to_display_id, dependency_type, resolved}` |
| `acceptance_criteria` | `proposal_acceptance_criteria` | JSONB array ordered by `item_number`: `{item_number, criterion_text, status, verified_by}` |
| `latest_decision` | `proposal_decision` | Legacy: most recent decision text + timestamp |
| `gate_decisions` | `roadmap.gate_decision_log` | Full gate history ordered DESC: decision, from/to state, maturity, gate, rationale, AC verification, dependency check, design review, challenges, blockers |
| `discussions` | `proposal_discussions` | JSONB array ordered DESC: `{id, author_identity, body, created_at}` |
| `reviews` | `proposal_reviews` | JSONB array ordered DESC: `{reviewer_identity, verdict, findings, notes, is_blocking, reviewed_at}` |
| `leased_by` / `lease_expires` | `proposal_lease` | Current active lease (unreleased, most recent) |
| `active_dispatches` | `roadmap_workforce.squad_dispatch` | Open / assigned / active dispatches: `{id, dispatch_role, dispatch_status, agent_identity, worker_identity, assigned_at}` |
| `workflow_name` / `current_stage` | `roadmap.workflows` ⨯ `workflow_templates` ⨯ `proposal_type_config` | Active workflow stage |

All child aggregations use `LEFT JOIN LATERAL` so the view never drops the proposal row even when no child records exist.

### Accessing the view

```sql
SELECT * FROM roadmap_proposal.v_proposal_detail WHERE display_id = 'P276';
-- or by numeric PK:
SELECT * FROM roadmap_proposal.v_proposal_detail WHERE id = 276;
```

---

## MCP Tool: `prop_get_detail`

**Registered in:** `src/apps/mcp-server/tools/proposals/backend-switch.ts`  
**Handler:** `src/apps/mcp-server/tools/proposals/pg-handlers.ts` (`getProposalDetail`)

```typescript
// JSON (machine-readable — default)
prop_get_detail({ id: "P276" })

// YAML + Markdown (human-readable — for agent context pickup)
prop_get_detail({ id: "P276", format: "yaml_md" })
```

The `yaml_md` format renders the full canonical markdown (same output as `buildProposalMarkdown`) directly in the MCP response. Agents picking up a leased proposal use this to get complete context — ACs to verify, prior gate rationale, active dispatches — in one call.

**Gate decision visibility example:**
```json
{
  "gate_decisions": [
    {
      "decision": "hold",
      "from_state": "develop",
      "to_state": "merge",
      "decided_by": "gate-agent",
      "rationale": "No implementation code found. See blockers.",
      "blockers": ["No implementation code"],
      "challenges": ["Complex dependency chain"]
    }
  ]
}
```

---

## Export Layer: `buildProposalMarkdown()`

**Location:** `src/shared/proposal-markdown-export.ts`

Pure function — no Node-only or browser-only imports. Works identically in the TUI, the web dashboard download, and the MCP `yaml_md` response.

### Input: `ProposalExportBundle`

```typescript
interface ProposalExportBundle {
  proposal: Proposal;
  decisions?: DecisionExport[];
  reviews?: ReviewExport[];
  discussions?: DiscussionExport[];
  criteria?: AcceptanceCriterion[];
  activityLog?: ActivityLogEntry[];
}
```

### Output sections (in order)

1. YAML frontmatter — id, title, status, maturity, type, priority, assignee, reporter, dates, labels, directive, dependencies, references, parent, builder, auditor, branch
2. `# {id} — {title}`
3. `## Summary` (or `## Description` if no summary)
4. `## Motivation`
5. `## Design`
6. `## Drawbacks`
7. `## Alternatives`
8. `## Dependency Notes`
9. `## Dependencies` (list)
10. `## References` (list)
11. `## Required Capabilities` (list)
12. `## Unlocks` (list)
13. `## Acceptance Criteria` — `- [x]` / `- [ ]` with optional `role:` and `evidence:` metadata
14. `## Implementation Plan`
15. `## Implementation Notes`
16. `## Audit Notes`
17. `## Final Summary`
18. `## Decisions` — per-decision `###` heading with binding flag, authority, timestamp, rationale
19. `## Reviews` — per-review `###` heading with verdict, reviewer, blocking flag, notes, findings
20. `## Discussions` — per-discussion `###` heading with author, context prefix, timestamp, body (chronological)
21. `## Activity` — per-event `- \`timestamp\` **actor** action — reason`
22. Export footer: `_Exported {ISO timestamp}_`

Sections with no data are omitted entirely. Consecutive blank lines are collapsed.

### Filename helper

```typescript
proposalExportFilename(proposal)
// → "P276-proposal-detail-timeline-and-canoni-2026-05-09T12-30-00.md"
```

---

## Web UI Layer: `ProposalDetailsModal`

**Location:** `src/apps/dashboard-web/components/ProposalDetailsModal.tsx`

### Sections rendered

**Main column (left 2/3):**
- Summary, Motivation, Design, Drawbacks, Alternatives, Dependency Note — all editable Markdown fields (MDEditor in edit mode, `MermaidMarkdown` renderer in preview mode)
- References — inline add/remove
- Documentation — read-only links
- Acceptance Criteria — checkbox toggle (optimistic update) or `AcceptanceCriteriaEditor` in edit mode
- Implementation Plan, Implementation Notes, Final Summary
- Decisions — blue left-border cards with binding badge, authority, timestamp, rationale
- Reviews — colour-coded left-border cards (green = approve, yellow = request_changes, red = other) with verdict badge, reviewer, notes, findings (JSON-pretty-printed if parseable)
- Discussions — purple left-border entries (max-height 384 px, scrollable), truncated at 500 chars

**Sidebar (right 1/3):**
- Dates (created, updated, last activity — computed from decisions/reviews/discussions)
- Title (inline blur-save)
- Status + maturity badge + type badge
- Closure reason (when maturity = obsolete)
- Assignee, Labels, Priority, Directive, Dependencies, Required Capabilities

### Actions

| Action | Availability |
| :--- | :--- |
| Export MD | Preview mode, existing proposals, same-branch only |
| Edit | Preview mode, existing proposals, same-branch only |
| Save / Cancel | Edit and create modes |
| Mark as Completed | Preview mode, status contains "complete" |
| Archive | If `onArchive` prop provided, same-branch only |

**Export MD** calls `buildProposalMarkdown()` with in-flight edits merged over the saved proposal, then triggers a browser download. The filename is generated by `proposalExportFilename()`.

### Keyboard shortcuts (preview mode)
- `e` — enter edit mode
- `Escape` (edit mode) — cancel edit (with dirty-check confirm)
- `Ctrl+S` / `Cmd+S` (edit mode) — save

### Data loading

On open, the modal fires three parallel API calls:
- `GET /api/proposals/{id}/decisions`
- `GET /api/proposals/{id}/reviews`
- `GET /api/proposals/{id}/notes` (discussions)

These populate the Decisions / Reviews / Discussions sections independently of the main proposal refresh.

---

## Activity Timeline Event Types

**Location:** `src/apps/dashboard-web/lib/proposal-activity.ts`

| `event_type` | Human label |
| :--- | :--- |
| `proposal_created` | created proposal |
| `lease_claimed` | lease claimed |
| `lease_released` | lease released |
| `decision_made` | decision recorded |
| `dependency_added` | dependency added |
| `dependency_resolved` | dependency resolved |
| `ac_updated` | acceptance criteria updated |
| `review_submitted` | review submitted |
| `maturity_changed` | maturity changed |
| `status_changed` | status changed |
| `milestone_achieved` | milestone achieved |
| _(other)_ | raw value with underscores replaced by spaces |

Events are stored in `proposal_event` (append-only outbox) and exposed via `v_proposal_activity` (migration 035) for the live board feed.

---

## Related Proposals and Migrations

| Artifact | Description |
| :--- | :--- |
| P272 — `v_proposal_activity` | Live board feed: who's working on a proposal right now, in which cubic, on which model, last heartbeat |
| P383 — `prop_get_detail` | Single-call MCP tool wrapping `v_proposal_detail`; also introduced migration 041 |
| migration 035 | `v_proposal_activity` — live activity projection |
| migration 041 | `v_proposal_detail` — full child-entity aggregation |
| migration 082–083 | `proposal_version` index + `fn_version_on_update` trigger for proposal edit history |

---

## Design Decisions

**Why `LEFT JOIN LATERAL` over subquery or separate queries?**  
LATERAL joins let each subquery reference the outer row (`p.id`) while remaining independent — if any child table is empty, the outer row is preserved with `'[]'::jsonb`. This eliminates N+1 patterns and keeps the view single-query.

**Why a shared `buildProposalMarkdown()` instead of separate TUI and web formatters?**  
Export fidelity: the `.md` file a user downloads from the dashboard must be identical to the `yaml_md` format returned by `prop_get_detail`. A single pure function with no runtime-specific imports guarantees this.

**Why discussions are fetched via REST, not bundled in the main proposal object?**  
The main proposal WebSocket payload is already substantial. Discussions are lazy-loaded on modal open to keep the board feed lean.
