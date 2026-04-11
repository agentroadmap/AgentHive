# Team Memory — Sprint 2026-04-01

## Process Rules (carry forward)

1. **Test framework**: only `node:test` + `node:assert/strict`
2. **Type changes**: run `grep -rn "TypeName" src/` before modifying an interface
3. **Scope discipline**: only edit files assigned to your proposal
4. **Pre-push check**: `npm run check:types && npm test` must pass
5. **Commit messages**: include error count for tracking (e.g. "89 → 42 errors")
6. **CI**: `npm run check` (biome) is soft-fail for now

## What Worked

- GitLab CI: type-check + test + build + security scans on every push
- Pre-push local check as first line of defense
- gitleaks + npm audit in security stage
- GitLab runner on local server (shell executor)

## Known Issues

- Knowledge Base SQLite removed — `knowledge_add` MCP tool broken
