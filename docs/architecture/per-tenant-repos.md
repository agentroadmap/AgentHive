# Per-Tenant Repository Architecture (P516)

## Overview

AgentHive moves toward **per-project code isolation** by enabling each tenant project to maintain its own git repository for application code, separate from the AgentHive control-plane codebase.

This document defines:
- **Code boundaries:** what lives in the control-plane repo vs. tenant repos
- **Worktree convention:** how agent worktrees map to per-project repositories
- **Shared library strategy:** how tenants consume common code via published packages

## Code Boundary Definition

### AgentHive Control-Plane Repo (`/data/code/AgentHive/`)

The control-plane houses all infrastructure and orchestration code:

- **MCP server** (agenthive-mcp service): handlers, validators, route/model management, proposal lifecycle
- **Core services:** orchestrator, agency lifecycle, config resolver, vault adapter
- **Database:** DDL for hiveControl (control_project, agent_registry, model_routes, etc.), plus tenant bootstrap templates
- **Shared libraries (published):** Extracted modules published to GitLab Package Registry with semver tags (e.g., `@agenthive/core@1.2.3`). Tenants depend on published packages only, never via symlinks or source imports.
- **Documentation:** Architecture, conventions, operations, publishing workflows

### Tenant Repos (`/data/code/<slug>/worktree/`)

Each tenant project owns its business logic and tenant-specific configuration:

- **Business logic:** Tenant-specific application code (audio processing, song generation, etc.)
- **Database:** Tenant-specific DDL beyond bootstrap templates; tenant-owned Postgres schema
- **Tests:** Unit, integration, e2e tests for tenant code only
- **CI:** Per-tenant `.gitlab-ci.yml` (copied from templates/tenant-ci.yml during provisioning)
- **Dependencies:** Pulled from published packages (npm, GitLab Package Registry) only; no source imports from AgentHive

## Worktree Convention

### Standard Per-Tenant Layout

Each tenant project has its own filesystem root and worktree:

```
/data/code/<slug>/                    # Project root (git repository clone)
  ├── worktree/                        # Primary working directory (git worktree)
  │   ├── .git/                        # Git worktree metadata
  │   ├── src/                         # Source code
  │   ├── tests/                       # Test suite
  │   ├── package.json                 # Dependencies (includes @agenthive/* packages)
  │   ├── .gitlab-ci.yml               # Per-tenant CI/CD
  │   └── README.md
  └── .git/                            # Git repository administrative files
```

Registry fields:
- `worktree_root`: `/data/code/<slug>/worktree` (resolves per-project agent working directory)
- `git_repo_url`: `gitlab.local/tenants/<slug>.git` (tenant's git repository)
- `git_default_branch`: `main` (branch for new agent worktrees)

### AgentHive Exception Note (P517 Future)

AgentHive itself currently lives at `/data/code/AgentHive/` without a `/worktree/` subdirectory. This is a legacy exception pending P517 (future standardization). Future work will align AgentHive to the per-project convention:
- Current: `/data/code/AgentHive/src/...`
- Future (P517): `/data/code/agenthive/worktree/src/...`

Until P517 lands, AgentHive is the only project that deviates from the `/data/code/<slug>/worktree/` convention.
