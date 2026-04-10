# AgentHive MCP Implementation (MVP)

This directory exposes a minimal stdio MCP surface so local agents can work with the AgentHive roadmap workflow without duplicating business logic.

## What’s included

- `server.ts` / `createMcpServer()` – bootstraps a stdio-only server that extends `Core` and registers filesystem-backed `proposal_*` tools plus AgentHive Postgres `prop_*` tools depending on backend configuration.
- `proposals/` – consolidated proposal tooling that delegates to shared Core helpers (including plan/notes/AC editing).
- `documents/` – document tooling layered on `Core`’s document helpers for list/view/create/update/search flows.
- `tools/dependency-tools.ts` – dependency helpers reusing shared builders.
- `resources/` – lightweight resource adapters for agents.
- `guidelines/mcp/` – proposal workflow content surfaced via MCP.

Everything routes through existing Core APIs so the MCP layer stays a protocol wrapper while AgentHive proposal workflows remain centralized.

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
