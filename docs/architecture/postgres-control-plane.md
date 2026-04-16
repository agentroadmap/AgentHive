# PostgreSQL Control Plane

This repository now treats PostgreSQL as the authoritative control plane for live workflow state. Git-tracked files remain important, but they are projections, specifications, and durable artifacts rather than the coordination source of truth.

## Core principles

1. **Postgres is authoritative for live state.** Proposal status, leases, dependencies, queueing, messaging, budgets, and operational telemetry must be queryable from the database without reconstructing truth from markdown files.
2. **Files are durable projections.** Documentation, exported artifacts, design notes, and generated views should be synchronized from the control plane or authored as durable product documentation, not treated as competing workflow state.
3. **Worktrees are execution sandboxes.** Agent worktrees exist to isolate code changes and temporary execution context. They are not the shared state layer.
4. **Events must be durable.** State changes should produce append-only records or outbox-style events so downstream MCP, UI, and automation consumers can react without hidden side effects.
5. **Recovery must be operational, not tribal.** Lease expiry, queue recovery, export checks, and backup/PITR procedures should be explicit and repeatable.

## Current architectural boundary

| Concern | Authoritative home | Notes |
| --- | --- | --- |
| Proposal workflow state | PostgreSQL `roadmap` schema | Includes leases, transitions, dependencies, queue views, and structured proposal metadata |
| Canonical durable docs | Root `docs/` | Architecture, pillar docs, reviews, API/MCP references |
| Live roadmap workspace | `roadmap/` | Tool-managed workspace content and compatibility surface during migration |
| Schema definitions | `database/ddl/`, `database/dml/`, later `database/migrations/` | DDL/DML separated from general docs |
| Agent code sandboxes | Git worktrees | Ephemeral execution and code editing only |

## Operational rules carried forward

- **Single-writer state discipline:** avoid parallel state machines in markdown, temp files, or sidecar stores.
- **Lease-driven execution:** agents must acquire a lease before mutating proposal state.
- **Export discipline:** filesystem exports should be reproducible from the database and verifiable when needed.
- **Backup readiness:** schema and data operations must assume backup, restore, and point-in-time recovery are part of normal operations.
- **Fast wakeups over polling:** prefer evented or outbox-driven wakeups over ad hoc scan loops where possible.

## What this replaces

The archive contains several older models that are no longer canonical:

- SQLite-first or daemon-first coordination assumptions
- markdown/state-file workflows as the primary control plane
- legacy secondary-database pathing and migration assumptions
- mixed filesystem plus database truth models

Those documents remain useful as historical reasoning, but the active architecture should be interpreted through this Postgres-first control-plane model.
