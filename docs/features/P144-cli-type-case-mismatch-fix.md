# P144 — CLI Proposal Create: Type Case Mismatch Fix

**Status:** COMPLETE (gate decision: OBSOLETE — bug fixed before proposal was reclassified)
**Commit:** `9189d4fe` (2026-04-10)
**Also fixes:** P143 (wrong `--type` / `--maturity` help text)

---

## Overview

`roadmap proposal create --type feature` raised a Postgres FK violation:

```
Key (type)=(FEATURE) is not present in table "proposal_type_config"
```

`buildProposalFromOptions()` in `src/apps/cli.ts` applied `.toUpperCase()` to the user-supplied `--type` value before passing it to the proposal backend. The `roadmap.proposal_type_config` table stores types in lowercase (`product`, `component`, `feature`, `issue`). Sending `FEATURE` violated the FK constraint and blocked every `roadmap proposal create` call on the Postgres backend.

The same bug existed on the `proposal edit` path.

---

## Fix — commit `9189d4fe`

**File:** `src/apps/cli.ts`

| Location | Before | After |
|---|---|---|
| `buildProposalFromOptions()` — create path (~line 1777) | `String(options.type).toUpperCase()` | `String(options.type).toLowerCase()` |
| `proposal edit` path (~line 3651) | `String(options.type).toUpperCase()` | `String(options.type).toLowerCase()` |

The same commit corrected misleading help text in both create and edit commands:

| Flag | Before (wrong) | After (correct) |
|---|---|---|
| `--type` | `DIRECTIVE`, `CAPABILITY`, `TECHNICAL`, `COMPONENT`, `OPS_ISSUE` | `product`, `component`, `feature`, `issue` |
| `--maturity` | `skeleton`, `contracted`, `audited` | `new`, `active`, `mature`, `obsolete` |

---

## Scope and Limitations

The fix is **CLI-scoped only**. Two lower-level paths pass `type` raw without case normalization:

| Layer | File | Location | Issue |
|---|---|---|---|
| MCP tool handler | `src/apps/mcp-server/tools/proposals/pg-handlers.ts` | line 301 — `type: proposalType` | No `.toLowerCase()` applied |
| Storage layer | `src/infra/postgres/proposal-storage-v2.ts` | line 349 — `input.type` in INSERT | No `.toLowerCase()` applied |

Any caller that bypasses the CLI — the `prop_create` MCP tool, direct SDK usage — and passes an uppercase type will still receive an FK violation. This gap was out of scope for P144 and was not addressed in `9189d4fe`.

---

## Gate Decision

**2026-04-21 — OBSOLETE**

The original CLI bug was already corrected in commit `9189d4fe` before this proposal was reclassified. The MCP/storage normalization gap is a latent correctness risk but was not in scope of this report.

---

## No Regression Tests

Commit `9189d4fe` added no test coverage for:
- `roadmap proposal create --type FEATURE` (uppercase input via CLI)
- `prop_create` MCP tool called with `type=FEATURE`

Both paths remain uncovered.

---

## Related Proposals

| Proposal | Relationship |
|---|---|
| P143 | Wrong `--type` / `--maturity` help text — fixed in the same commit |
