# Copilot Instructions — AgentHive v2 Schema Migration

## Context
You are helping migrate the AgentHive roadmap application from a disk-based storage layer to a fully PostgreSQL-native system using the **v2 data model**. The live database is `agenthive`, schema `roadmap`, running on PostgreSQL 16 via Docker (host: 127.0.0.1, port: 5432).

## Data Model Source
Schema artifacts are split between `/database/ddl/`, `/database/dml/`, and canonical proposal docs:
- `database/ddl/roadmap-ddl-v2.sql` — Full v2 schema (~30 tables)
- `database/ddl/roadmap-ddl-v2-additions.sql` — Additions (~12 tables)
- `docs/pillars/1-proposal/data-model-change.md` — Migration analysis
- `docs/pillars/1-proposal/new-data-model-guide.md` — Implementation rules
- `database/dml/init.yaml` — 4 module definitions

## Critical Breaking Changes (v1 → v2)
| v1 (OLD) | v2 (NEW) |
|---|---|
| `proposal.assigned_to`, `proposal.assigned_at` | `proposal_lease` (claim/replace model) |
| `proposal.status` CHECK constraint | `proposal_valid_transitions` (state machine edges) |
| `proposal.maturity` INTEGER | `proposal.maturity` JSONB (stage→label map) |
| `proposal.priority` stored column | DAG-derived from `proposal_dependencies` |
| Direct status transitions | `proposal_state_transitions` (append-only log) |
| 22 tables | ~51 tables across 4 pillars |

## 4 Pillar Modules
- **Product Development** (P074): proposal, proposal_lease, DAG, workflow_templates, state machine
- **Workforce** (P075): agents, teams, resources, ACL, budget, agent_capability
- **Efficiency** (P076): models, context, cache, memory, pgvector
- **Utility** (P077): MCP tools, messaging, notifications, outbox pattern

## Architecture
- Config: `provider: Postgres`, `schema: roadmap` at `/roadmap.yaml`
- MCP server: port 6421 (`agenthive-mcp.service`)
- WS bridge: port 3001
- Environment: `.env` file at repo root

## Key Files to Rewrite
- `src/infra/postgres/proposal-storage-v2.ts` — Postgres storage adapter
- `src/apps/mcp-server/tools/rfc/pg-handlers.ts` — MCP tool handlers
- `src/core/roadmap.ts` — core query layer
- `src/apps/cli.ts` — CLI commands
- `scripts/roadmap-board.ts` — board script

## Important Column Changes
- `blocked_by_dependencies` column added to `proposal` (sync'd via `fn_sync_blocked_flag` trigger)
- `id` columns: `BIGINT GENERATED ALWAYS AS IDENTITY`
- Timestamps: `timestamptz`
- Metadata: `jsonb`
- New tables: `proposal_event`, `run_log`, `agent_capability`, `proposal_lease`

## DDL Already Applied
- Schema `roadmap` is live in the `agenthive` database
- Do NOT re-apply DDL; update application code to match

## Testing
- 220 test files exist; ensure tests pass after changes
- 2 known failures: `mcp-proposals.test.ts` (pickup), `mcp-drafts.test.ts` (promotion assertion)

## Coding Standards
- TypeScript throughout
- PostgreSQL-native (no retired secondary-database references)
- Use connection pooling from `.env` credentials
- Maintain backward compatibility where possible for migration
- All new code must use `roadmap.` schema prefix in queries
