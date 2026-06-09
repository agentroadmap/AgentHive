# @agenthive/scan Packages

The hardcoding scanner is split into a generic engine and independently-versioned rule packs.

## Structure

```
packages/
  agenthive-scan-core/           @agenthive/scan-core
    - Scanner engine, CLI, JSONL output, allowlist
    - Zero hardcoded AgentHive dependencies
    - Exports: runScan, loadRules, writeOutput, etc.

  agenthive-scan-rules-secrets/  @agenthive/scan-rules-secrets
    - AWS, GCP, Anthropic, OpenAI, GitHub, bearer tokens, .env

  agenthive-scan-rules-multi-tenant/  @agenthive/scan-rules-multi-tenant
    - Hardcoded paths, identities, endpoints
    - Generic patterns usable across any project

  agenthive-scan-rules-workflow-states/  @agenthive/scan-rules-workflow-states
    - RFC states, hotfix/maturity markers, legacy patterns
    - Generic workflow patterns

  agenthive-scan-rules-agenthive/  @agenthive/scan-rules-agenthive
    - AgentHive-specific rules
    - Model names, agency names, cubic paths, schema drift

  agenthive-scan-fix/            @agenthive/scan-fix  [Phase 3]
    - Auto-fix engine for deterministic mechanical replacements
    - path-replace, model-replace, state-name-replace transforms
```

## Dependency Graph

```
@agenthive/scan-core (no AgentHive dependencies)
  ├─ commander, glob, js-yaml
  └─ (accepts rule packs as peer deps)

@agenthive/scan-rules-secrets
  └─ peer: @agenthive/scan-core

@agenthive/scan-rules-multi-tenant
  └─ peer: @agenthive/scan-core

@agenthive/scan-rules-workflow-states
  └─ peer: @agenthive/scan-core

@agenthive/scan-rules-agenthive
  └─ peer: @agenthive/scan-core
```

## Versioning

Each package is independently versioned per semver. A consumer can pin specific versions:

```bash
npm install @agenthive/scan-core@1.0.0 \
  @agenthive/scan-rules-secrets@1.0.0 \
  @agenthive/scan-rules-multi-tenant@1.1.0
```

Breaking changes in a rule pack (e.g., rule ID rename) bump the pack's major version. Engine changes bump @agenthive/scan-core.

## Consumer Scenarios

### Generic Security Scanning (non-AgentHive)

```bash
npm install -g @agenthive/scan-core @agenthive/scan-rules-secrets
scan-hardcoding --format jsonl
```

### Multi-Tenant Pattern Detection

```bash
npm install -g @agenthive/scan-core \
  @agenthive/scan-rules-multi-tenant \
  @agenthive/scan-rules-secrets
scan-hardcoding --format jsonl
```

### AgentHive Consumer (Full Suite)

```bash
npm install -g @agenthive/scan-core \
  @agenthive/scan-rules-secrets \
  @agenthive/scan-rules-multi-tenant \
  @agenthive/scan-rules-workflow-states \
  @agenthive/scan-rules-agenthive
scan-hardcoding --format jsonl
```

## Development

Each package is built independently:

```bash
cd packages/agenthive-scan-core
npm install
npm run build
npm test
```

## Distribution

Packages are published to npm under the @agenthive scope. Single-binary releases (via bun --compile) and container images are distributed separately from the npm packages.

See top-level CHANGELOG.md for release history.
