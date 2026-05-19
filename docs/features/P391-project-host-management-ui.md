# P391 — Project & Host Management UI

**Status:** COMPLETE  
**Domain:** dashboard / control-plane  

---

## Overview

P391 adds three management pages to the AgentHive web dashboard, giving operators a graphical interface over the control-plane tables that govern projects, host routing policy, and provider registry membership. Before this work, all three tables were mutated exclusively via `psql` or direct API calls.

**Pages shipped:**

| Route | Source table | Primary operations |
|---|---|---|
| `/projects` | `roadmap_workforce.projects` | CRUD + soft-delete/restore |
| `/hosts` | `roadmap.host_model_policy` | CRUD + dispatch-guard on delete |
| `/providers` | `roadmap_workforce.provider_registry` | Read + inline activate/deactivate |

---

## Data Layer

### Tables (no schema migrations — additive API + UI only)

**`roadmap_workforce.projects`** (13 columns)  
Columns surfaced in UI: `id`, `name`, `description`, `owner`, `is_active`, `db_host`, `db_port`, `db_name`, `db_user`, `git_root`, `discord_channel_id`, `created_at`, `updated_at`.

**`roadmap.host_model_policy`**  
Primary key: `host_name`. PG arrays: `allowed_providers[]`, `forbidden_providers[]`. Scalar: `default_model`, `updated_at`.  
Live data (at implementation): 4 hosts — `hermes`, `gary-main`, `claude-box`, `bot`.

**`roadmap_workforce.provider_registry`** (8 columns)  
Agency ↔ project join: `agency_id`, `project_id`, `squad_name`, `capabilities[]`, `is_active`, `registered_at`, `updated_at`.

**`roadmap.model_routes`**  
Validation reference only — not mutated by this feature. Used to populate the `default_model` dropdown in the host form and to validate POSTed values.

### Source of Truth Rule

`project_id` in `hiveCentral` tables is a pointer to a tenant DB, not a row discriminator (per P590 keystone invariant). No `WHERE project_id = $1` filter is applied to control-plane tables beyond `project.*` itself.

---

## API Endpoints

All mutation endpoints require the operator flag. Reads are unauthenticated.

### Projects

```
GET    /api/projects              → all rows from roadmap_workforce.projects
POST   /api/projects              → create (validates db_host reachability + db_name uniqueness)
PUT    /api/projects/:id          → full update
PATCH  /api/projects/:id          → toggle is_active (soft-delete / restore)
```

**No hard delete is exposed.** Operators soft-delete via `PATCH is_active=false`. Active leases continue; new dispatches to the project are rejected with `project_inactive`.

### Hosts

```
GET    /api/hosts                 → all rows from roadmap.host_model_policy
POST   /api/hosts                 → create (validates default_model against model_routes, validates provider names)
PUT    /api/hosts/:host_name      → full update
DELETE /api/hosts/:host_name      → delete (HTTP 409 while active dispatches reference host)
```

### Providers

```
GET    /api/providers             → provider_registry joined with projects (squad_name, project name)
PATCH  /api/providers/:id         → toggle is_active (optimistic update with rollback)
```

---

## Edit Semantics

All mutations are **immediate** — writes go directly to the control-plane DB. There is no staging layer or approval gate.

- **Host policy changes** take effect on the next dispatch cycle. Agents mid-flight are not interrupted.
- **Project deactivation** (`is_active=false`) blocks new dispatches immediately; in-flight leases run to completion.
- **Provider toggle** uses optimistic UI update: the toggle flips instantly in the browser and rolls back if the PATCH fails.

---

## Component Architecture

```
ProjectsPage.tsx
├── ProjectsTable        — sortable/filterable list; columns: name, owner, status, db_host:port, git_root
├── ProjectForm          — create/edit modal; inline validation
└── ProjectDetail        — expanded row: db_name, git_root, discord_channel_id

HostsPage.tsx
├── HostsTable           — list with provider chips (green = allowed, red = forbidden)
├── HostForm             — create/edit modal; ChipInput for provider arrays; ModelSelector dropdown
└── ModelSelector        — dropdown populated from model_routes

ProvidersPage.tsx
├── ProvidersTable       — list with agency/project join; capabilities chips
└── ProviderStatusToggle — optimistic inline toggle

ChipInput.tsx (shared)  — comma- or Enter-separated input; keyboard removal (Backspace)
```

---

## Edge Cases

### Offline hosts

Server performs a TCP reachability check on project save. If unreachable: HTTP 422 with inline form error on the `db_host` field. A `skip_reachability: true` flag is available for pre-registering a host before it is live; the bypass is logged in `control_audit`.

### Duplicate db_names

PG unique constraint violation → HTTP 409 with `{"error": "db_name already exists: <name>"}`. Form highlights the `db_name` field.

### Route-policy conflicts

After a host policy PUT, `/api/routes` recomputes `has_host_policy_match` for each route. Orphaned routes (routes on a host where no provider is now allowed) appear with a yellow badge on the Routes page. A dashboard alert fires if all routes on a host become orphaned.

### Deleting a host with active dispatches

`DELETE /api/hosts/:host_name` returns HTTP 409 until all `open` / `assigned` / `active` dispatches for that host complete.

### Deleting projects with active work

Hard delete is not exposed. `PATCH is_active=false` is the only removal path. See "Edit Semantics" above.

---

## Navigation

The sidebar gains three entries under a **Management** group:

- Projects → `/projects`
- Hosts → `/hosts`
- Providers → `/providers`

These do not modify existing dashboard routes.

---

## Verification Plan

| Test | Type | Assertion |
|---|---|---|
| `GET /api/projects` returns all rows with correct columns | Backend | 200, correct schema |
| `GET /api/hosts` deserializes provider arrays correctly | Backend | PG array → JSON array |
| `POST /api/projects` rejects unreachable `db_host` | Backend | HTTP 422 |
| `POST /api/projects` rejects duplicate `db_name` | Backend | HTTP 409 |
| `POST /api/hosts` rejects unknown `default_model` | Backend | HTTP 400 |
| `DELETE /api/hosts` blocked when active dispatches exist | Backend | HTTP 409 |
| Projects page renders status badges | Frontend | active = green, inactive = grey |
| Hosts page renders provider chips with correct colours | Frontend | allowed = green, forbidden = red |
| Providers page optimistic toggle + rollback | Frontend | toggle reverts on PATCH failure |
| `ChipInput` handles comma- and Enter-separated input | Unit | chips created, Backspace removes last |
| Sidebar shows Projects, Hosts, Providers links | Frontend | links render, routes load |
| Orphaned routes appear with yellow badge after host policy edit | Integration | badge visible on Routes page |

---

## Rollback

All changes are additive (new endpoints + new pages). To roll back: revert the source files. No data migrations to undo. `is_active=false` on any project or provider is reversible via `PATCH is_active=true`.

---

## Related Proposals

| Proposal | Relation |
|---|---|
| P590 | hiveCentral data-model; defines `projects`, `host_model_policy` as control-plane tables |
| P235 | Platform-aware model constraints; `model_routes` is the validation reference for `default_model` |
| P383 | Proposal detail view — same dashboard, different page family |
