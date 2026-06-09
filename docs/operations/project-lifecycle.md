# Project Lifecycle Operations Playbook (P483)

**Scope:** Multi-project lifecycle management for agentHive2. Post-P893 (tenant lifecycle state machine). Foundation for cross-project dispatch, agency registration, and budget isolation.

## Table of Contents

1. [Quick Reference](#quick-reference)
2. [Create a Project](#create-a-project)
3. [List & Inspect Projects](#list--inspect-projects)
4. [Archive a Project](#archive-a-project)
5. [Reactivate an Archived Project](#reactivate-an-archived-project)
6. [Delete a Project](#delete-a-project)
7. [Worktree Permissions](#worktree-permissions)
8. [Post-Provisioning Setup](#post-provisioning-setup)
9. [Failure Modes & Recovery](#failure-modes--recovery)
10. [Related Playbooks](#related-playbooks)

---

## Quick Reference

### MCP Tools

All project lifecycle operations are exposed via `mcp_project` tool:

```bash
# Create
mcp_project action=project_create \
  slug=audiobook name="Audiobook Platform" \
  worktree_root=/data/code/audiobook/worktree

# List
mcp_project action=project_registry_list include_archived=false limit=50

# Archive
mcp_project action=project_archive project=audiobook reason="Seasonal pause"

# Reactivate
mcp_project action=project_reactivate project=audiobook

# Delete
mcp_project action=project_delete \
  project=audiobook \
  confirm_slug=audiobook \
  force=true
```

### Environment Variables

Set these on the orchestrator/MCP server host:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENTHIVE_WORKTREES_ROOT` | `/data/code` | Base directory for worktree creation |
| `AGENTHIVE_HOST` | (unset) | When set to `bot`, dispatch uses shared operator host |
| `AGENTHIVE_TENANT_SAGA` | `false` | If `true`, use P495 saga for full tenant DB bootstrap |

---

## Create a Project

### Basic Flow

1. **Call `project_create`** with slug, name, and optional worktree_root.
2. **Transactional insert** into `roadmap.project` with status=active.
3. **Worktree directory creation** (best-effort, post-commit).
4. **Repair queue** if directory doesn't exist or mkdir fails.

### Example

```bash
mcp_project action=project_create \
  slug=audiobook \
  name="Audiobook Platform" \
  worktree_root=/data/code/audiobook/worktree
```

**Response:**

```json
{
  "ok": true,
  "project": {
    "project_id": 42,
    "slug": "audiobook",
    "name": "Audiobook Platform",
    "worktree_root": "/data/code/audiobook/worktree"
  },
  "worktree_created": true,
  "repair_needed": false
}
```

### Slug Rules

- **Pattern:** `^[a-z][a-z0-9-]*[a-z0-9]$`
- **Length:** 3–64 characters
- **Examples:** `audiobook`, `ml-ops-v2`, `xyz`
- **Invalid:** `Audiobook` (uppercase), `audio book` (space), `audio-` (trailing dash)

### Errors

| Error | Cause | Recovery |
| --- | --- | --- |
| `slug_collision` | Slug already exists | Use a unique slug |
| `Invalid slug` | Pattern mismatch | Follow slug rules (lowercase, alphanumeric + hyphens) |
| `Missing or invalid name` | Name is empty or not a string | Provide non-empty string name |
| `slug_already_exists` | PG unique constraint | Slug is taken; use different slug |

### Transaction Boundary (AC-100)

- **Commit:** `roadmap.project` INSERT + worktree directory stat happen in one transaction.
- **Repair:** If directory doesn't exist at commit time, a `project_repair_queue` row is inserted (within same transaction).
- **Post-commit:** `mkdir -p` with mode 0o775 is best-effort; failures are logged but don't roll back the registry insert.

---

## List & Inspect Projects

### List All Projects

```bash
mcp_project action=project_registry_list \
  include_archived=false \
  limit=50
```

**Response:**

```json
{
  "total": 2,
  "returned": 2,
  "truncated": false,
  "limit": 50,
  "items": [
    {
      "project_id": 1,
      "slug": "agenthive",
      "name": "AgentHive Control Plane",
      "worktree_root": "/data/code/agenthive/worktree",
      "status": "active",
      "created_at": "2026-04-01T10:00:00Z",
      "archived_at": null
    },
    {
      "project_id": 42,
      "slug": "audiobook",
      "name": "Audiobook Platform",
      "worktree_root": "/data/code/audiobook/worktree",
      "status": "active",
      "created_at": "2026-06-08T14:30:00Z",
      "archived_at": null
    }
  ]
}
```

### Health Check

Validate registry and worktree alignment:

```bash
mcp_project action=project_health_check project=audiobook
```

**Response (OK):**

```json
{
  "ok": true,
  "error": null,
  "project": {
    "project_id": 42,
    "slug": "audiobook",
    "name": "Audiobook Platform",
    "worktree_root": "/data/code/audiobook/worktree",
    "git_repo_url": "https://gitlab.local/audiobook/monorepo",
    "git_default_branch": "main"
  },
  "checks": [
    { "name": "registry_row", "ok": true },
    { "name": "worktree_root", "ok": true },
    { "name": "git_remote", "ok": true }
  ],
  "message": "Project registry and worktree are in sync."
}
```

**Response (FAIL - missing worktree):**

```json
{
  "ok": false,
  "error": "ERROR_WORKTREE_NOT_FOUND",
  "checks": [
    {
      "name": "worktree_root",
      "ok": false,
      "code": "ERROR_WORKTREE_NOT_FOUND",
      "detail": "/data/code/audiobook/worktree does not exist or is not a directory"
    }
  ]
}
```

---

## Archive a Project

### When to Archive

- Project is paused temporarily (not deleted, may resume).
- Dispatch should refuse claims for this project.
- Proposals remain intact but untouchable.

### Flow

```bash
mcp_project action=project_archive \
  project=audiobook \
  reason="Seasonal pause until Q3"
```

**Response:**

```json
{
  "ok": true,
  "project": {
    "project_id": 42,
    "slug": "audiobook",
    "name": "Audiobook Platform",
    "status": "archived",
    "archived_at": "2026-06-08T15:45:00Z"
  },
  "message": "Project 'audiobook' archived. Dispatch will refuse claims for archived projects."
}
```

### Dispatch Behavior

Once archived, dispatch handler (AC-101) refuses cubic claims:

- `cubic_create` / `cubic_focus` / `cubic_acquire` check `roadmap.project.status` before proceeding.
- Structured error: `{error: "project_archived", project_id: 42, message: "..."}`.
- No side effects (no partial state changes).

---

## Reactivate an Archived Project

### Flow

```bash
mcp_project action=project_reactivate project=audiobook
```

**Response:**

```json
{
  "ok": true,
  "project": {
    "project_id": 42,
    "slug": "audiobook",
    "name": "Audiobook Platform",
    "status": "active"
  },
  "message": "Project 'audiobook' reactivated. Dispatch will accept claims for this project again."
}
```

### Idempotent

Reactivating an already-active project returns `{ok: true, already_active: true, ...}` with no changes.

---

## Delete a Project

### Prerequisites

1. **Zero non-archived proposals.** Archive or delete all proposals first.
2. **Cascade scope confirmed.** Run preflight to understand dependent rows.
3. **Slug confirmation.** Pass `confirm_slug` exactly matching the project slug.

### Preflight: Check Cascade Scope (AC-102)

Before deletion, inspect dependent data:

```bash
mcp_project action=project_delete \
  project=audiobook \
  confirm_slug=audiobook \
  force=false
```

If dependencies exist, response shows:

```json
{
  "ok": false,
  "error": "cascade_dependencies_exist",
  "project_id": 42,
  "slug": "audiobook",
  "cascade_checks": {
    "safe": false,
    "dependencyCount": 3,
    "non_archived_proposals": 1,
    "non_recycled_cubics": 2,
    "non_empty_message_channels": 0,
    "project_owned_templates": 0
  },
  "message": "Project has dependent data. Use force=true and confirm_slug to cascade-delete."
}
```

### Cascade Scope (AC-102)

Per-table behavior **with `force=true`**:

| Related Table | Behavior | Notes |
| --- | --- | --- |
| `roadmap_proposal.proposal` (non-archived) | **BLOCK** (always) | Operator must archive/delete manually first |
| `roadmap.cubics` (non-recycled) | **CASCADE-DELETE** | Cubics are work units; safe to delete with project |
| `roadmap.message_channels` | **CASCADE-DELETE** | Project-owned channels; safe to delete |
| `roadmap.workflow_templates` (project-owned) | **CASCADE-DELETE** | Templates are project metadata; safe to delete |
| `roadmap.project_route_allowlist` | **CASCADE-DELETE** | Allowlist is project-scoped; auto-deleted |
| `roadmap.project_route_policy` | **CASCADE-DELETE** | Policy is project-scoped; auto-deleted |
| `roadmap.project_capability_scope` | **CASCADE-DELETE** | Capability scope is project-scoped; auto-deleted |
| `roadmap.project_budget_cap` | **CASCADE-DELETE** | Budget is project-scoped; auto-deleted |

### Full Deletion

Once preflight passes or dependencies are removed:

```bash
mcp_project action=project_delete \
  project=audiobook \
  confirm_slug=audiobook \
  force=true
```

**Response:**

```json
{
  "ok": true,
  "deleted": true,
  "project_id": 42,
  "slug": "audiobook",
  "message": "Project 'audiobook' deleted along with dependent routes, capabilities, and budgets."
}
```

### Errors

| Error | Cause | Recovery |
| --- | --- | --- |
| `confirm_slug_mismatch` | `confirm_slug` doesn't match project slug | Pass exact slug string (case-sensitive) |
| `project_not_found` | Project ID/slug doesn't exist | Check project exists with `project_registry_list` |
| `non_archived_proposals_exist` | Non-archived proposals remain | Archive or delete all proposals first; then retry |
| `cascade_dependencies_exist` | Dependent cubics/templates/channels exist | Either: (1) manually clean them, OR (2) pass `force=true` for cascade-delete |

---

## Worktree Permissions

### Directory Creation (AC-103)

`project_create` creates worktree directory with:

- **Mode:** `0o775` (rwxrwxr-x)
- **Group:** `dev` (if chgrp is available; otherwise mode 0o775 allows dev group to write if umask is permissive)

### Permission Contract

**Agency users must be able to create cubic worktrees without sudo:**

```bash
# Agency user (e.g., claude) runs:
cd /data/code/audiobook/worktree
mkdir my-cubic-workspace
```

### Manual Fix (if needed)

If worktree directory permissions are wrong:

```bash
sudo chgrp dev /data/code/audiobook/worktree
sudo chmod g+w /data/code/audiobook/worktree
```

### Note on chown

Changing ownership (chown) requires root. Project creation does **not** chown; it only sets group and mode. If you need a specific owner, run:

```bash
sudo chown -R owner:dev /data/code/audiobook/worktree
```

---

## Post-Provisioning Setup

### Agency Liaison Registration (P918)

After `project_create`, agencies must be registered to claim work:

**See:** `docs/operations/agency-deployment.md` (P918)

**Summary:**

```bash
mcp_agent action=register \
  agency_slug=audiobook_agency \
  project_id=42 \
  liaison_config={...}
```

### Default Budget Allocation (P484)

After project creation, assign budget caps and route allowlists:

**See:** `docs/operations/project-lifecycle.md` (later section)

**Summary:**

```bash
# Add a route to allowlist
mcp_project action=project_route_add \
  project_id=42 \
  route_name=claude-opus \
  max_calls_per_day=100 \
  max_tokens_per_day=1000000

# Set a budget cap
mcp_project action=project_cap_set \
  project_id=42 \
  period=day \
  max_usd_cents=5000  # $50/day
```

### Model Route Allowlist (P484)

By default, new projects have **no routes**. Explicitly add routes:

```bash
mcp_project action=project_route_list project_id=42
# Returns: {total: 0, returned: 0, items: []}

# Add a route
mcp_project action=project_route_add \
  project_id=42 \
  route_name=claude-opus

# Verify
mcp_project action=project_route_list project_id=42
# Returns: {total: 1, items: [{route_name: "claude-opus", ...}]}
```

---

## Failure Modes & Recovery

### Failure Mode: Worktree Directory Doesn't Exist

**Symptom:**

- `project_create` returns `{ok: true, worktree_created: false, repair_needed: true}`.
- `project_health_check` returns `ERROR_WORKTREE_NOT_FOUND`.
- Dispatch cannot create cubics under the project.

**Root Cause:**

- `mkdir` post-commit failed (e.g., permission denied, ENOSPC).
- Worktree is on an unavailable mount.

**Recovery:**

1. Check `project_repair_queue` for the pending repair:

   ```bash
   mcp_project action=project_repair_queue  # (Phase 2 action, deferred)
   ```

2. Manually create the directory:

   ```bash
   sudo mkdir -p /data/code/audiobook/worktree
   sudo chgrp dev /data/code/audiobook/worktree
   sudo chmod 0775 /data/code/audiobook/worktree
   ```

3. Verify health:

   ```bash
   mcp_project action=project_health_check project=audiobook
   # Should return ok=true
   ```

### Failure Mode: Slug Collision

**Symptom:**

- `project_create` returns `{ok: false, error: "slug_collision"}`.

**Root Cause:**

- Slug already exists in `roadmap.project`.

**Recovery:**

- Choose a unique slug and retry.
- Or, delete the old project first (if safe).

### Failure Mode: Partial Provisioning (Transaction Rollback)

**Symptom:**

- `project_create` fails with database error mid-transaction.
- `roadmap.project` row was NOT inserted (transaction rolled back).
- No worktree directory was created.

**Root Cause:**

- Constraint violation (e.g., invalid name).
- Disk space exhausted during INSERT.

**Recovery:**

- Fix the error (e.g., provide valid name).
- Retry `project_create`.

### Failure Mode: Cannot Delete — Non-Archived Proposals

**Symptom:**

- `project_delete` returns `{ok: false, error: "non_archived_proposals_exist", non_archived_count: 5}`.

**Root Cause:**

- Project has active or pending proposals.

**Recovery:**

1. Archive or complete all proposals:

   ```bash
   mcp_proposal action=set_maturity proposal_id=P100 maturity=mature
   mcp_proposal action=transition proposal_id=P100 reason="Archived"
   ```

2. Retry `project_delete`.

### Failure Mode: Cannot Delete — Cascade Dependencies

**Symptom:**

- `project_delete` with `force=false` returns `{ok: false, error: "cascade_dependencies_exist"}`.
- Shows dependent cubics, templates, channels.

**Root Cause:**

- Project owns dependent data that would be deleted.
- Operator didn't pass `force=true`.

**Recovery:**

**Option 1: Manual Cleanup**

- Delete cubics:

  ```bash
  mcp_agent action=cubic_delete cubic_id=my-workspace
  ```

- Delete templates:

  ```bash
  mcp_project action=project_template_delete project_id=42 template_name=standard
  ```

- Re-run preflight:

  ```bash
  mcp_project action=project_delete \
    project=audiobook confirm_slug=audiobook force=false
  ```

**Option 2: Cascade Delete**

- Pass `force=true` to cascade-delete all dependent data:

  ```bash
  mcp_project action=project_delete \
    project=audiobook confirm_slug=audiobook force=true
  ```

- **Warning:** This is irreversible.

---

## Related Playbooks

- **P918 (Agency Liaison Registration):** `docs/operations/agency-deployment.md` — How to register a liaison for a new project.
- **P484 (Budget & Route Allowlist):** `docs/operations/project-lifecycle.md` (Phase 2) — How to set budget caps and route allowlists.
- **P893 (Tenant Lifecycle State Machine):** `docs/architecture/control-plane/tenant-lifecycle.md` — Underlying state machine (provisioning, archived, retiring, retired).
- **P482 (Multi-Project Registry):** `docs/design/P482-multi-project-registry.md` — Project registry design and data model.

---

## Summary

| Action | When | Command |
| --- | --- | --- |
| **Create** | Onboard a new project | `project_create slug=X name=Y worktree_root=Z` |
| **List** | Inspect all projects | `project_registry_list include_archived=false` |
| **Archive** | Pause a project | `project_archive project=X reason=Y` |
| **Reactivate** | Resume a paused project | `project_reactivate project=X` |
| **Delete** | Remove a project entirely | `project_delete project=X confirm_slug=X force=true` |
| **Health Check** | Validate registry/worktree sync | `project_health_check project=X` |

**Remember:** Deletion is irreversible. Always run preflight (`force=false`) before final deletion.
