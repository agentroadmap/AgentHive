---
mcp_id: P243
type: architecture
status: COMPLETE
---

# Architecture Proposal Type

This document is the canonical reference for the `architecture` proposal type introduced in P243. It covers when to use the type, how the workflow operates, advisory mechanics, criteria authoring, migration guidance, and child proposal spawning rules.

## Overview

The `architecture` type is a **Type A (Design)** proposal for product and business architecture decisions that need durable markdown projections and review, but do not produce verifiable code acceptance criteria. It gives first-class lifecycle tracking to decisions that explain theory, structure, tradeoffs, business architecture, and product intent — decisions that were previously forced into `product` or `component` buckets despite producing design artifacts rather than buildable code.

**Key invariant:** The database and MCP remain the lifecycle source of truth. Markdown is the durable projection for human reading, long-form reasoning, advisory comments, and cross-agent context. The markdown file projects from the DB record; the DB record does not derive from the file.

## When to Use Architecture vs. Other Types

| If the output is… | Use type |
| :--- | :--- |
| Top-level product vision, pillars, constraints | `product` |
| Major subsystem or architectural pillar with code deliverables | `component` |
| **Durable design artifact, theory, business architecture, tradeoff analysis** | **`architecture`** |
| Concrete capability to build (feature branch, tests, code) | `feature` |
| Problem requiring code changes | `issue` |
| Localized operational fix to a running instance | `hotfix` |

Use `architecture` when:
- The output is a decision document, not a code deliverable.
- The primary work is reasoning, alternative analysis, and alignment — not implementation.
- The decision needs MCP lifecycle tracking but the acceptance criteria are design-review criteria, not implementation test results.
- The decision is a prerequisite for spawning child `feature` or `issue` proposals.

Do **not** use `architecture` when:
- The proposal identifies work that an agent must build and test. Spawn a `feature` or `issue` instead.
- The scope is top-level product direction. Use `product`.
- The scope is a major buildable subsystem. Use `component`.

## Parent and Link Rules

- Architecture proposals are normally children of a **`product`** proposal.
- They may also be linked to a **`component`** when the architecture decision is subsystem-specific.
- They can spawn child **`feature`** or **`issue`** proposals when implementation work is identified.
- They do not carry code work themselves.

## Architecture RFC Workflow

Architecture proposals use a three-state workflow:

```
Draft  →  Review  →  Complete
```

| State | Phase | Description |
| :--- | :--- | :--- |
| **Draft** | Formation | Theory formation, business architecture, product structure, alternative analysis, and synthesis of prior discussions. Enhancement agents research, propose framing, and mature the document. |
| **Review** | Gating | Coherence check, strategic fit, terminology alignment, dependency impact assessment, advisory coverage evaluation, and spawn/split evaluation. Gate agent makes the advance or hold decision. |
| **Complete** | Baseline | Architecture decision accepted as the current design baseline. This is a terminal stable state — no `Develop` or `Merge` states follow. |

**There is no `Develop` or `Merge` state for architecture proposals.** If an architecture decision produces implementation work, that work is tracked in child `feature` or `issue` proposals with the full Standard RFC workflow.

### Maturity inside each state

Maturity (`new → active → mature → obsolete`) applies inside each state as with all proposals:

- `Draft/new` — freshly created, waiting for an enhancement agent to claim it.
- `Draft/active` — under lease; agent is researching, framing, and drafting alternatives.
- `Draft/mature` — ready for gate review to advance to `Review`.
- `Review/active` — gate agent is running coherence and advisory checks.
- `Review/mature` — gate decision made; ready to advance to `Complete` or return to `Draft`.
- `Complete/mature` — terminal. No further gates are queued.

## Advisory Function in Review

The Review state includes an advisory layer. Advisors are reviewers or expert agents who provide:

- Critique of the framing, scope, or terminology
- Alternative approaches or framings
- Risk notes and dependency concerns
- Improvement requests before the gate decision

### Advisory constraints

- Advisory participation is **not** a separate workflow state, queue, or gate lease.
- Advisors inform the single, explicit, auditable gate decision.
- The gate agent collects advisory input and then makes one decision: advance, hold, or reject.
- Advisory comments are persisted as proposal discussion entries or review records in the DB.
- MCP projections for architecture proposals include advisory comments or review summaries alongside the core YAML + Markdown artifact.

### How to contribute as an advisor

1. Read the proposal via `mcp_proposal action="detail" id="<Pxxx>"`.
2. Post critique or recommendations via `mcp_proposal action="add_discussion"`.
3. Optionally submit a formal review via `mcp_proposal action="submit_review"`.
4. The gate agent reads all advisory input before calling the gate decision.

## Design-Review Criteria

Architecture proposals use `proposal_acceptance_criteria` rows with design-review criteria rather than implementation test criteria. These criteria are still tracked in the DB; they are verified by the gate agent during Review, not by a test runner.

Standard design-review criteria for an architecture proposal:

| Criterion | What to check |
| :--- | :--- |
| **Clarity** | Is the decision clearly stated and unambiguous? |
| **Scope** | Is the scope bounded? Does it avoid mixing design intent with implementation detail? |
| **Product direction consistency** | Does the decision align with the active product and component proposals? |
| **Dependency impact** | Have downstream proposals been identified and linked? Are blockers noted? |
| **Glossary and term alignment** | Do the terms used match the project glossary and existing conventions? |
| **Advisory coverage** | Has at least one advisory review been submitted and addressed? |
| **Downstream proposal generation** | Has any identified implementation work been broken out into child `feature` or `issue` proposals? |

When authoring criteria for a specific architecture proposal, select the subset that applies and add domain-specific criteria as needed. Use `mcp_proposal action="add_criteria"` to record them.

## When to Migrate Old Discussions

Old theory and business architecture discussions in proposal comments, design files, or informal notes can be migrated into architecture proposals when:

- The discussion describes **durable reasoning** that should survive the current sprint.
- The reasoning is a **prerequisite or constraint** for future implementation proposals.
- The discussion reached a **decision or baseline** that agents need to reference.
- The discussion is currently buried in a `product` or `component` proposal that has already moved to `Develop` or later, making the design reasoning hard to find.

Do **not** migrate discussions that:
- Describe immediately buildable work (create a `feature` or `issue` instead).
- Are ephemeral (spike notes, dead-end explorations with no lasting decision).
- Duplicate an existing architecture proposal in scope.

### Migration procedure

1. Create the architecture proposal with `mcp_proposal action="create" type="architecture"`.
2. Set `parent_id` to the appropriate `product` proposal.
3. Populate `design` with the synthesized reasoning from the original discussion.
4. Add design-review ACs.
5. Link the original proposal(s) as dependencies or related proposals.
6. Advance to `Draft/active`, then `Draft/mature` for gate review.

## Spawning Child Proposals for Implementation Work

Architecture proposals are design artifacts. When they identify implementation work, they spawn child proposals rather than carrying code deliverables themselves.

**Rule:** If an architecture decision requires code, database changes, or testable deliverables, create a child `feature` or `issue` proposal for that work.

### Spawn procedure

1. While drafting or reviewing the architecture proposal, identify the implementation scope.
2. Create the child proposal: `mcp_proposal action="create" type="feature" parent_id="<arch_id>"`.
3. Set `depends_on` on the child to the architecture proposal's ID so the child waits until the architecture decision reaches `Complete`.
4. Add a note in the architecture proposal's `design` or discussion referencing the child proposal IDs.

### Example

An architecture proposal for "Event sourcing strategy for the audit ledger" might spawn:
- `feature`: Implement `audit_event` table and migration
- `feature`: Add event replay endpoint to MCP audit surface
- `issue`: Backfill existing rows to the new schema

These children do the building; the architecture proposal holds the reasoning.

## MCP Projection Format

When fetched via `mcp_proposal action="detail"`, architecture proposals return:

```yaml
---
id: P<nnn>
title: "<decision title>"
type: architecture
status: Draft | Review | Complete
maturity: new | active | mature | obsolete
parent: P<product_id>
---
```

Followed by the markdown body:
- **Motivation** — why this decision is needed
- **Design** — the decision itself, alternatives considered, and rationale
- **Drawbacks** — risks and tradeoffs
- **Acceptance Criteria** — design-review criteria with pass/fail status
- **Advisory Comments** — reviewer and advisor discussion summaries
- **Child Proposals** — links to downstream feature/issue proposals

No raw table inspection is required. The projection is the complete information surface for agents reading or reviewing an architecture proposal.

## Disambiguation Quick Reference

| Type | Workflow | Has Develop/Merge? | AC type | Primary output |
| :--- | :--- | :--- | :--- | :--- |
| `product` | Standard RFC | Yes | Design + impl | Vision, pillars, constraints |
| `component` | Standard RFC | Yes | Design + impl | Buildable subsystem |
| **`architecture`** | **Architecture RFC** | **No** | **Design-review** | **Decision document** |
| `feature` | Standard RFC | Yes | Impl (code tests) | Concrete capability |
| `issue` | Standard RFC | Yes | Impl (code tests) | Code fix |
| `hotfix` | Hotfix | No (Triage/Fix/Deployed) | Ops verification | Operational fix |
