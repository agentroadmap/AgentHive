# @agenthive/scan Changelog

All notable changes to the scanner packages are documented here. Each package is independently versioned; see individual package.json files for version pins.

## [1.0.0] — 2026-06-09

### Added

- **@agenthive/scan-core** 1.0.0
  - Generic scanner engine extracted from AgentHive repo
  - CLI tool: `scan-hardcoding` with commander-based arg parsing
  - Output formats: human, JSONL (schema_version=1 frozen), SARIF, MCP
  - Baseline comparison mode (`--baseline`, `--emit-baseline`) for CI gating
  - Git integration: `--git-changed`, `--git-staged` for incremental scanning
  - Allowlist support: `.scanignore.yaml` + inline suppression comments
  - Self-test: `--self-test` validates rule examples
  - Rule introspection: `--list-rules`, `--explain <rule-id>`

- **@agenthive/scan-rules-secrets** 1.0.0
  - 9 rules for secret detection
  - Covers: AWS keys, GCP service accounts, API keys (Anthropic, OpenAI), GitHub PATs, bearer tokens, .env files, private key blocks
  - All rules verified against examples as of 2026-04-25

- **@agenthive/scan-rules-multi-tenant** 1.0.0
  - 6 rules for multi-tenant patterns
  - Covers: hardcoded paths, identities, endpoints, ports
  - Generic patterns reusable across projects

- **@agenthive/scan-rules-workflow-states** 1.0.0
  - 8 rules for workflow-state literals
  - Covers: RFC states (DRAFT, REVIEW, etc.), hotfix markers, maturity fields, legacy issue statuses

- **@agenthive/scan-rules-agenthive** 1.0.0
  - 13 rules specific to AgentHive project
  - Covers: model name literals, agency identifiers, cubic paths, misc anti-patterns (unqualified table names, console.log in handlers, TODO without proposal IDs)

### Documentation

- docs/jsonl-schema.md: JSONL output format specification (schema_version=1, versioning policy, consuming JSONL examples)
- docs/integration-claude-code.md: Claude Code agent workflow (scan → triage → verify phases, suppression patterns, baseline mode for CI)
- packages/README.md: Package structure and versioning strategy

### Known Limitations (Phase 0)

- Auto-fix engine (`scan fix --auto`) not yet shipped (Phase 3 item)
- Single-binary releases not yet available (Phase 2 item)
- Container image not yet available (Phase 2 item)
- npm package publishing not yet set up (Phase 2 item)
- AgentHive MCP `mcp_scan` tool integration pending (AC-4, MCP server side)
- Rule pack consumer separation test pending (AC-4 on non-AgentHive repo)

### In-Repo Status

- Scanner remains in AgentHive repo during Phase 0 (transition to extracted repo in Phase 1)
- 48 rules passing self-test
- CI ready: `--baseline` mode available for migration gating

## Roadmap

### Phase 1 (Extraction) — ~2 weeks

- Split into separate GitHub/GitLab repo
- npm packages published under @agenthive scope
- CI green on each package

### Phase 2 (Distribution) — ~4 weeks after Phase 1

- Single-binary releases (bun --compile) for linux-x64, darwin-arm64, darwin-x64, windows-x64
- Container image (agenthive/scan:latest)
- GitHub Action and GitLab CI templates
- Install script (curl -sSL agenthive.dev/scan/install.sh | sh)

### Phase 3 (Auto-Fix) — ~6 weeks after Phase 1

- Auto-fix engine for deterministic mechanical replacements
- Transforms: path-replace, model-replace, state-name-replace
- Rules opt in via `auto_fix:` YAML field
- Safety verification across sample repos

---

For details on individual rule changes, see the YAML files in each rules-* package.
