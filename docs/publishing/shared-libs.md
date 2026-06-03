> **Type:** reference  
> **MCP-tracked:** P516  
> **Source-of-truth:** Postgres `roadmap_proposal.proposal` row P516

# Shared Library Publishing

Shared code used by tenant repositories is published as versioned npm packages in the GitLab Package Registry. Tenant repos consume packages through `package.json` and a private npm token; they must not symlink or import AgentHive source files.

## Package Contract

- Package names use the `@agenthive/*` scope, for example `@agenthive/core`.
- Versions follow semver. Breaking changes require a major version bump.
- Tenant repos pin normal semver ranges in `package.json`.
- Private registry access uses a GitLab npm token stored in CI secrets or the operator vault.

## Publish Flow

1. Extract shared code into a package directory with its own `package.json`.
2. Run package tests and type checks.
3. Tag and publish to the GitLab Package Registry.
4. Update tenant `package.json` versions in tenant repos.
5. Run tenant CI before merging the tenant repo change.

Control-plane runtime code is not a shared library. Tenant code depends on MCP contracts and published packages only.
