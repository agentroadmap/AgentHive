# Shared Library Publishing Strategy (P516)

## Overview

This document describes how to extract, publish, and consume shared libraries in the AgentHive multi-tenant architecture.

## When to Extract a Library

Extract code into a shared library when:

1. **Code reuse:** The code is actually used by **2 or more tenant projects** (not speculative)
2. **Stability:** The code is stable and unlikely to change frequently
3. **Independence:** The code is independent of project-specific configuration
4. **Maintainability:** The extracted code can be reasoned about and tested independently

**Examples of extraction candidates:**
- Token/quota utilities (shared by monkeyKing-audio and georgia-singer)
- Shared database models or migration utilities
- Common API client wrappers (e.g., for external services)
- Logging, metrics, and telemetry utilities

**Examples of NOT extraction candidates:**
- Code used by only one tenant project
- Highly experimental or volatile code
- Code tightly coupled to a specific tenant's schema or business logic

## Publishing Workflow

### Step 1: Extract the Code

Identify the reusable module in an existing repository (AgentHive or a tenant repo):

```
src/shared/quota-utils/
  ├── quota-manager.ts
  ├── quota-check.ts
  ├── test/
  └── README.md
```

### Step 2: Create a New Repository

Create a new GitLab repository for the library (e.g., `gitlab.local/agenthive/quota-utils`).

```bash
git clone --mirror gitlab.local/agenthive/quota-utils.git
cd quota-utils.git
git config core.bare false
mkdir -p src
```

### Step 3: Set Up package.json

Create a `package.json` with proper naming convention (`@agenthive/<library-name>`):

```json
{
  "name": "@agenthive/quota-utils",
  "version": "1.0.0",
  "description": "Shared quota management utilities for AgentHive tenants",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "test": "node --test",
    "prepublishOnly": "npm run build"
  },
  "dependencies": {
    "pg": "^8.11.0"
  },
  "devDependencies": {
    "typescript": "^5.3.0"
  },
  "publishConfig": {
    "registry": "https://gitlab.local/api/v4/projects/agenthive/quota-utils/packages/npm"
  }
}
```

### Step 4: Tag Releases with Semver

When the library is stable and ready for release:

```bash
git tag v1.2.3
git push origin v1.2.3
```

GitLab CI (or a manual publish job) will publish this version as `@agenthive/quota-utils@1.2.3` to the GitLab Package Registry.

### Step 5: Tenants Add Dependency

In a tenant project's `package.json`:

```json
{
  "dependencies": {
    "@agenthive/quota-utils": "^1.2.3"
  }
}
```

Ensure `.npmrc` contains the private token:

```
//gitlab.local/api/v4/projects/agenthive/quota-utils/packages/npm/:_authToken=<gitlab-token>
```

Install:

```bash
npm install
```

### Step 6: Use in Tenant Code

Tenants import from the published package:

```typescript
import { QuotaManager } from "@agenthive/quota-utils";

const manager = new QuotaManager();
const available = await manager.getAvailableQuota(projectId);
```

## Semver Convention

**Version format:** `MAJOR.MINOR.PATCH`

- **MAJOR:** Breaking changes (e.g., renamed exports, removed functions)
- **MINOR:** Backward-compatible additions (e.g., new optional parameters)
- **PATCH:** Bug fixes and non-breaking refinements

**Example progression:**
- `v1.0.0` → First stable release
- `v1.1.0` → Add new export `TokenBucket` (backward-compatible)
- `v1.1.1` → Bug fix in quota calculation logic
- `v2.0.0` → Rename `QuotaManager` to `QuotaOrchestrator` (breaking)

## Private npm Token Management

Shared libraries are published to GitLab Package Registry, which requires authentication:

1. **Generate token:** GitLab → Settings → Access Tokens → create with `read_package_registry` scope
2. **Store securely:** Add to `.npmrc` in the tenant repo (or CI/CD secrets)
3. **Format:** `//gitlab.local/api/v4/projects/<project>/packages/npm/:_authToken=<token>`
4. **Rotate regularly:** Update token quarterly or when team membership changes

## Example: @agenthive/core Extraction

Suppose we identify core utilities that both monkeyKing-audio and georgia-singer use:

**From AgentHive (`src/shared/core/`):**
```
├── vault-adapter.ts       (reads secrets from Postgres)
├── quota-check.ts         (token budget enforcement)
├── logging.ts             (structured logging)
└── database.ts            (tenant DB connection helpers)
```

**Extraction steps:**
1. Create `gitlab.local/agenthive/core`
2. Copy files, create `package.json` with `"name": "@agenthive/core"`
3. Tag `v1.0.0` and push
4. Both monkeyKing-audio and georgia-singer add `"@agenthive/core": "^1.0.0"`
5. Both remove their local copies and import from `@agenthive/core`

## Versioning and Updates

### Rolling Out a New Version

1. **Increment version** in library repo `package.json`
2. **Commit and tag:** `git tag v1.2.0 && git push --tags`
3. **GitLab CI publishes** to Package Registry (automated)
4. **Tenants update** their `package.json`: `"@agenthive/core": "^1.2.0"`
5. **Run tests:** `npm test` to ensure compatibility

### Breaking Changes

For major version bumps (breaking changes):

1. **Tag:** `git tag v2.0.0`
2. **Document migration** in `CHANGELOG.md` (e.g., "QuotaManager renamed to QuotaOrchestrator")
3. **Tenants review migration guide** before updating
4. **Gradual adoption:** Tenants can stay on v1.x during transition period

## Troubleshooting

### "Cannot find module @agenthive/..."

Check:
- `.npmrc` has correct GitLab Package Registry URL and token
- Package name matches exactly (case-sensitive)
- Version specifier in `package.json` matches a published tag

### "Authentication failed"

- Verify token is not expired: `npm token list` (if using npm account) or check GitLab Access Tokens
- Regenerate token if needed: GitLab → Settings → Access Tokens
- Ensure token has `read_package_registry` scope

### "Version X.Y.Z not found"

- Confirm tag was pushed to origin: `git tag -l | grep vX.Y.Z`
- Check GitLab CI publish job succeeded: GitLab → CI/CD → Pipelines
- Verify GitLab Package Registry lists the package: GitLab → Packages & Registries

## Best Practices

1. **Minimal, focused scope:** Each library should do one thing well (SRP)
2. **Comprehensive tests:** Shared libraries must have >80% test coverage
3. **Clear documentation:** Include README with usage examples and API reference
4. **Changelog discipline:** Update CHANGELOG.md with every release
5. **Backward compatibility:** Avoid breaking changes in minor/patch versions
6. **Dependency hygiene:** Keep dependencies minimal; avoid cascading upgrades
7. **Regular audits:** Periodically review which libraries are actually used vs. abandoned

## References

- **P516:** Per-project git repo separation
- **P429:** Multi-tenant topology
- **GitLab Package Registry:** https://docs.gitlab.com/ee/user/packages/npm_registry/
- **Semantic Versioning:** https://semver.org/
