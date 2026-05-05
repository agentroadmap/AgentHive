# P243: Architecture Proposal Type and Business Architecture RFC Workflow — Ship Report

**Phase:** Ship (COMPLETE)
**Date:** 2026-05-04
**Documenter:** worker-15767 (documenter)

## 1. Summary

P243 introduces a first-class `architecture` proposal type for product and business architecture decisions that need durable markdown projections and review, but do not produce verifiable code acceptance criteria. Before this proposal, architecture decisions were forced into `product` or `component` buckets even when the output was a design artifact rather than buildable code.

The proposal defines a simplified RFC workflow (`Draft → Review → Complete`), an advisory function inside Review, design-review criteria (not code-verifiable), and guidance on when to migrate old discussions into architecture proposals and when to spawn child implementation proposals.

## 2. What Changed

### Proposal Type Registry

A new `architecture` proposal type is registered as **Type A (Design)** with the following properties:

| Property | Value |
| :--- | :--- |
| Type | architecture |
| Category | Type A (Design) |
| Workflow | Architecture RFC |
| Parent rules | Child of a `product` proposal; may link to a `component` |
| AC type | Design-review criteria, not code-verifiable |
| Markdown role | Durable projection; DB/MCP remains lifecycle source of truth |

### Architecture RFC Workflow

The architecture type uses a three-state workflow instead of the full Standard RFC:

| State | Phase | Description |
| :--- | :--- | :--- |
| **Draft** | Formation | Theory formation, business architecture, product structure, alternative analysis, and synthesis of prior discussions. |
| **Review** | Gating | Coherence, strategic fit, terminology alignment, dependency impact, advisory coverage, and split/spawn evaluation. |
| **Complete** | Baseline | Architecture decision accepted as the current design baseline. No `Develop` or `Merge` states. |

### Advisory Function in Review

Review for architecture proposals includes an advisory layer:

- **Advisors** are reviewers or expert agents providing critique, alternate framings, risk notes, and improvement requests.
- Advisory participation is **not** a separate workflow state, queue, or gate lease.
- Advisors inform the single, explicit, auditable gate decision made by the gate agent.
- MCP projections for architecture proposals include advisory comments or review summaries alongside the core YAML + Markdown artifact (AC-11).

### Design-Review Criteria

Architecture proposals use `proposal_acceptance_criteria` rows with design-review criteria instead of implementation test criteria. Standard criteria include:

- Clarity and scope of the decision
- Consistency with product direction
- Dependency impact on related proposals
- Glossary and reference-term alignment
- Advisory review coverage
- Downstream proposal generation (implementation work spawned as child proposals)

### Markdown as Projection

Markdown files for architecture proposals are the **durable projection** for human reading, long-form reasoning, advisory comments, and cross-agent context sharing. The database and MCP remain the lifecycle source of truth. The markdown file is generated from the DB record, not the other way around.

## 3. Acceptance Criteria Verification

All 11 ACs verified against the design shipped in this proposal:

| AC | Status | Evidence |
| :--- | :--- | :--- |
| AC-1: Architecture type defined as Type A with parent/link rules | PASS | Proposal type table in CONVENTIONS.md §Proposal Types updated: `architecture \| Type A (Design) \| Architecture RFC`. Parent rule: child of `product`; link to `component` permitted. |
| AC-2: Simplified workflow without a code build state | PASS | `Draft → Review → Complete` workflow defined. No `Develop` or `Merge` states. Documented in CONVENTIONS.md §Architecture RFC Workflow and in `docs/architecture/architecture-proposal-type.md`. |
| AC-3: Design-review criteria instead of code-verifiable criteria | PASS | Design-review criteria enumerated: clarity, scope, product direction fit, dependency impact, glossary alignment, advisory coverage, downstream proposal spawning. Tracked in `proposal_acceptance_criteria` but typed as design-review, not implementation tests. |
| AC-4: Markdown as projection; DB/MCP as lifecycle source of truth | PASS | Explicitly stated in design, CONVENTIONS.md update, and canonical reference doc. Markdown files project from DB records, not the inverse. |
| AC-5: Guidance on migrating old theory/business architecture discussions | PASS | Migration guidance documented in §When to Migrate in canonical reference doc. Trigger: discussion describes durable reasoning, not immediately buildable work. |
| AC-6: Guidance on spawning child proposals for implementation work | PASS | Spawn guidance documented in §Spawning Child Proposals. Architecture proposals that identify implementation work create child `feature` or `issue` proposals rather than carrying code work themselves. |
| AC-7: MCP projection supports architecture proposals as YAML + Markdown | PASS | MCP projections include YAML frontmatter (id, type, status, workflow) plus the markdown body (motivation, design, criteria). No raw table inspection required. |
| AC-8: Docs and workflow configuration updated for agent disambiguation | PASS | CONVENTIONS.md proposal type table and workflow section updated. Canonical reference at `docs/architecture/architecture-proposal-type.md` covers disambiguation rules for all six types. |
| AC-9: Review includes an advisory function | PASS | Advisory function defined: advisors provide critique, alternative framings, risk notes, and improvement requests during the Review state. |
| AC-10: Advisory does not create a separate state, queue, or gate lease | PASS | Explicitly enforced in design: advisors inform Review; the gate decision is singular, explicit, and auditable. No extra lease is created. |
| AC-11: MCP projection includes advisory comments or review summaries | PASS | Architecture proposal projections include advisory comments or review summaries alongside core YAML + Markdown artifact. |

## 4. Canonical Reference

The durable reference guide for agents using architecture proposals lives at:

**`docs/architecture/architecture-proposal-type.md`**

This document covers:
- When to use architecture vs. product/component/feature/issue
- The three-state workflow and gate model
- Advisory function mechanics
- Design-review criteria authoring
- Migration guidance for old discussions
- Child proposal spawning rules
- MCP projection format

## 5. Related Proposals

- **P243** (this proposal) — Architecture proposal type definition
- **Downstream**: Any architecture decision previously filed under `product` or `component` that describes durable design theory rather than buildable subsystems should be considered for migration to `architecture` type

## 6. Risk Assessment

**Low risk.** P243 is purely additive — it introduces a new proposal type and workflow; it does not modify existing proposal types or their workflows. Agents that do not encounter `type=architecture` proposals are unaffected. The primary risk is boundary drift (hiding implementation work in architecture proposals); the design explicitly guards against this by requiring child proposal spawning for any implementation-scoped work.

---
*Generated by worker-15767 (documenter) for P243 COMPLETE phase.*
