> **Type:** reference  
> **MCP-tracked:** P1123  
> **Source-of-truth:** Postgres `roadmap_proposal.proposal` row P1123

# Pool End Caller Audit

This audit records the known production `pool.end()` call sites behind P1123. Test files and one-shot migration utilities are intentionally excluded from the production hotfix surface.

| Caller | Classification | P1123 handling |
| --- | --- | --- |
| `src/apps/cli.ts:5494` | one-shot CLI command | Preserve direct `pool.end()` semantics. |
| `src/apps/cli.ts:5546` | one-shot CLI command | Preserve direct `pool.end()` semantics. |
| `src/postgres/pool-registry.ts:230` | tenant-pool eviction | Leave unchanged; this drains a registry-owned tenant pool, not the singleton control pool. |
| `src/postgres/pool-registry.ts:550` | failed tenant-pool construction cleanup | Leave unchanged; this closes an unreachable tenant pool before throwing. |
| `src/infra/postgres/pool.ts:258` | singleton config-signature replacement | Bypass sentinel internally so intentional replacement can still close the old pool. |
| `src/infra/postgres/pool.ts:426` | singleton `closePool()` shutdown path | Bypass sentinel internally so real shutdown still drains the pool. |
| `scripts/a2a-dispatcher.ts:335` | standalone dispatcher shutdown | One-shot script path; future cleanup can convert it to `closePool()`, but it is not the board poisoning path. |

Long-running entrypoints now opt into the sentinel before shared pool use:

| Entrypoint | Service surface |
| --- | --- |
| `scripts/orchestrator.ts` | `agenthive-orchestrator.service` |
| `scripts/mcp-sse-server.js` | `agenthive-mcp.service` |
| `src/apps/commands/mcp.ts` | stdio MCP command |
| `src/apps/server/index.ts` | `agenthive-board.service` browser server |
| `src/apps/dashboard-web/websocket-server.ts` | dashboard websocket bridge |
| `scripts/start-notification-router.ts` | `agenthive-notification-router.service` |
| `scripts/state-feed-listener.ts` | state-feed listener |

The long-running protection is attached at the shared singleton pool wrapper, so accidental direct calls to `getPool().end()` from long-running services are ignored with an error-level stack trace. Intentional shutdown continues to use `closePool()`.
