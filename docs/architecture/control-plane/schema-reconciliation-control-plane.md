# P436 — Schema Reconciliation for Control Plane

> **Type:** issue  **Parent:** P429  **MCP-tracked:** Yes  **Source-of-truth:** Postgres `roadmap_proposal.proposal` row P436

This is a design note paired with MCP proposal P436. The MCP/Postgres record is canonical (CONVENTIONS.md §0); this file is a synced projection of the design context.

## Problem

The current migration set has schema drift around multi-project and agency/provider tables. Examples:

- `provider_registry.project_id` appears as `TEXT` in one migration and is treated as project `BIGINT` elsewhere.
- The early multi-project registry design (now superseded by P429/P483) said `squad_dispatch`, leases, model routes, host policy, agent registry, provider registry, and projects are central, while older text suggests proposals or workflow state may move to project databases.
- Some offer inserts still omit `project_id`.
- Multiple DDL roots make it unclear which migration line is authoritative.

## Proposal

Reconcile the schema around one rule: AgentHive control-plane state stays in the control database with `project_id`. Project databases contain only project domain/runtime data.

## Acceptance Criteria

1. `provider_registry.project_id` has one canonical type: `BIGINT REFERENCES control_project.project(project_id)` or the compatibility equivalent.
2. `squad_dispatch`, transition queue, leases, model routes, host policy, agencies, provider registry, budgets, context logs, and run logs are classified as control-plane tables.
3. Proposals, workflow state, acceptance criteria, reviews, discussions, and gate decisions are classified as control-plane tables with `project_id`.
4. Project-domain tables are explicitly separated from AgentHive proposal/workflow tables.
5. Claim fallback is fail-closed or defaults to project 1 only for legacy agencies; unregistered agencies must not claim all projects.
6. One authoritative migration path is documented across `database/ddl/v4`, `database/migrations`, and `scripts/migrations`.

## Dependencies

- P410 Control Database Boundary
- P411 Control Database Bootstrap
