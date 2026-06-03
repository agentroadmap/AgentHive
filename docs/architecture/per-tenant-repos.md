> **Type:** design note  
> **MCP-tracked:** P516  
> **Source-of-truth:** Postgres `roadmap_proposal.proposal` row P516

# Per-Tenant Repositories

P516 separates tenant application code from the AgentHive control-plane repository. AgentHive remains the runtime and governance plane; each tenant owns a separate git repository and worktree for tenant-specific code, schema, tests, and CI.

## Registry Fields

`roadmap.project` records the tenant repository boundary:

| Column | Meaning |
| --- | --- |
| `git_repo_url` | Tenant repository remote URL. Operators set this after creating the repo. |
| `git_default_branch` | Default branch used for provisioning and repair. Defaults to `main`. |
| `worktree_root` | Local tenant worktree path. Defaults to `/data/code/<slug>/worktree` for tenant projects. |

AgentHive is the current exception: its control-plane checkout may still live at `/data/code/AgentHive` or `/data/code/worktree` depending on host setup. A separate migration should standardize the AgentHive path if the operator chooses to adopt `/data/code/agenthive/worktree`.

## Repository Boundary

The AgentHive repository contains:

- MCP server, proposal handlers, gate logic, pool registry, vault adapter, config resolver, and dispatch plumbing.
- Control-plane DDL for `hiveControl` and tenant bootstrap templates.
- Shared libraries only until they are extracted into published packages.

Tenant repositories contain:

- Tenant business logic.
- Tenant-specific Postgres DDL beyond bootstrap.
- Tenant tests and fixtures.
- Tenant CI configuration copied from `templates/tenant-ci.yml` and adapted as needed.

Tenant code must not import AgentHive source files. If tenant code needs a reusable runtime utility, extract it into a semver package such as `@agenthive/core` and publish it to the GitLab Package Registry.

## Operator Provisioning

Provisioning is manual for v1 and must be idempotent:

```bash
git clone <git_repo_url> /data/code/<slug>
git -C /data/code/<slug> worktree add worktree main
```

Then update the registry:

```sql
UPDATE roadmap.project
   SET git_repo_url = '<git_repo_url>',
       git_default_branch = 'main',
       worktree_root = '/data/code/<slug>/worktree'
 WHERE slug = '<slug>';
```

Before dispatching tenant work, smoke test the registry/worktree pair:

```text
mcp_ops action=health_check project_id=N
```

The health check returns `ERROR_WORKTREE_NOT_FOUND` when the configured `worktree_root` is absent. Operators should repair the tenant checkout with `git worktree repair` or reprovision the worktree before dispatch.

## Dispatch Rule

`cubic_create` accepts `project_id`. When provided, it resolves the active `roadmap.project` row and creates the cubic under that row's `worktree_root`. Missing project rows fail with `ERROR_PROJECT_NOT_FOUND`; missing worktrees fail with `ERROR_WORKTREE_NOT_FOUND`. Dispatch must not silently fall back to the AgentHive worktree for tenant work.
