---
id: proposal-079
title: Workflow-Adaptive Status Surfaces
status: Draft
priority: high
proposal_type: TECHNICAL
category: INFRA
domain_id: ENGINE
assignee: []
labels: ["workflow", "mcp", "ui", "reporting", "agenthive"]
dependencies: ["proposal-001"]
created_date: "2026-04-09"
updated_date: "2026-04-09"
---

## Description

Several user-visible and internal surfaces still assume the default RFC workflow stages directly in code. Some of those assumptions are acceptable as bootstrap defaults, but others are behavioral and should become workflow-adaptive because proposal type determines which workflow applies.

Current examples include:

- reporting and documentation generators that aggregate against specific stage names
- dashboards that interpret a single hard-coded work stage such as `Develop`
- status summaries that infer terminal or in-flight behavior from a fixed RFC pipeline
- legacy migration helpers that normalize old terms into the default RFC workflow without consulting workflow configuration

This proposal tracks the follow-up work to separate:

1. safe bootstrap defaults for RFC-style workflows
2. dynamic workflow-aware behavior that should read the configured workflow or workflow template for a proposal type

## Why

AgentHive’s default RFC state machine is authoritative as the baseline, but it is not universal. Proposal type selects workflow. If code paths hard-code `Draft -> Review -> Develop -> Merge -> Complete` as behavior rather than as a default fallback, those paths will break when a proposal type uses a different workflow.

## Acceptance Criteria

- Identify every runtime path where workflow stages are treated as behavior rather than as configured defaults.
- Introduce a shared workflow-resolution layer for UI, MCP, and reporting surfaces.
- Keep the default RFC workflow as the bootstrap fallback when no explicit workflow is configured.
- Ensure proposal type is the primary selector for workflow-aware status rendering and aggregation.
- Add tests covering at least one non-default workflow so stage rendering and summaries are not tied to RFC-only names.

## Notes

This is intentionally scoped as an adaptive workflow follow-up, not a full terminology cleanup. The immediate terminology/default-status pass already moved many fallbacks to the canonical RFC baseline; this proposal covers the deeper dynamic workflow work that should not remain hard-coded.
