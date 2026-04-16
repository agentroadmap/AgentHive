# AgentHive MCP Implementation (MVP)

This directory exposes a minimal stdio MCP surface so local agents can work with the AgentHive roadmap workflow without duplicating business logic.

## What’s included

- `server.ts` / `createMcpServer()` – bootstraps a stdio-only server that extends `Core` and registers filesystem-backed `proposal_*` tools plus AgentHive Postgres `prop_*` tools depending on backend configuration.
- `tools/consolidated.ts` – public domain routers that keep the MCP interface small while delegating to the existing implementation handlers.
- `proposals/` – consolidated proposal tooling that delegates to shared Core helpers (including plan/notes/AC editing).
- `documents/` – document tooling layered on `Core`’s document helpers for list/view/create/update/search flows.
- `tools/dependency-tools.ts` – dependency helpers reusing shared builders.
- `resources/` – lightweight resource adapters for agents.
- `guidelines/mcp/` – proposal workflow content surfaced via MCP.

Everything routes through existing Core APIs so the MCP layer stays a protocol wrapper while AgentHive proposal workflows remain centralized.

## Public tool surface

When the Postgres AgentHive backend is active, MCP clients see a small set of domain tools by default:

- `mcp_project` – common cross-domain reads and reports.
- `mcp_proposal` – proposal CRUD, projected detail, maturity, leases, criteria, dependencies, reviews, discussion, and worktree merge.
- `mcp_message` – messages, channels, subscriptions, protocol threads, mentions, and notifications.
- `mcp_agent` – agent registry, teams, pulse health, fleet status, and cubic workspaces.
- `mcp_memory` – memory, knowledge search, decisions, and patterns.
- `mcp_document` – versioned documents, document search, versions, and notes.
- `mcp_ops` – spending, models, escalation, tests, workflow loading, and federation.

Each router accepts `action` and `args`. Use `action: "list_actions"` on any router to inspect the actions it supports. Set `MCP_LEGACY_TOOLS=1` to expose the underlying granular tools during migration or debugging. Filesystem fallback mode keeps the legacy tools visible because the consolidated routers depend on the Postgres AgentHive read model.

## Development workflow

```bash
# Run the stdio server from the repo
bun run cli mcp start

# Or via the globally installed CLI
roadmap mcp start

# Tests
bun test src/test/mcp-*.test.ts
```

The test suite keeps to the reduced surface area and focuses on happy-path coverage for proposals, dependencies, and server
bootstrap.
