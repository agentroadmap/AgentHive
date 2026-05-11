# P143 — CLI Help Text: Wrong Proposal Types and Maturity Values

**Status:** COMPLETE
**Commit:** `9189d4fe` (`fix: CLI proposal create type case mismatch and help text`, 2026-04-10)
**Companion fix:** P144 (FK violation from `.toUpperCase()` on write path — fixed in the same commit)

---

## Problem

`roadmap proposal create --help` and `roadmap proposal edit --help` displayed stale enum values that had been superseded when the schema migrated from a legacy design to the current `roadmap.proposal_type_config` table.

### `--type` (wrong → correct)

| Displayed (wrong) | Actual DB values |
|---|---|
| `DIRECTIVE` | `product` |
| `CAPABILITY` | `component` |
| `TECHNICAL` | `feature` |
| `COMPONENT` | `issue` |
| `OPS_ISSUE` | — |

### `--maturity` (wrong → correct)

| Displayed (wrong) | Actual values |
|---|---|
| `skeleton` | `new` |
| `contracted` | `active` |
| `audited` | `mature` |
| — | `obsolete` |

The stale help strings caused confusion for operators and masked a co-located write-path bug (P144): the CLI was also calling `.toUpperCase()` on the user-supplied `--type` value before writing to Postgres, producing FK violations on every `proposal create` and `proposal edit` call.

---

## Root Cause

Six locations in `src/apps/cli.ts` were never updated after the schema migrated:

| Location | Defect |
|---|---|
| `buildProposalFromOptions()` ~line 1772 | `.toUpperCase()` applied to `options.type` before DB write |
| `proposal create --type` help ~line 1823 | Listed `DIRECTIVE, CAPABILITY, TECHNICAL, COMPONENT, OPS_ISSUE` |
| `proposal create --maturity` help ~line 1927 | Listed `skeleton, contracted, audited` |
| `proposal edit --type` help ~line 3044 | Same stale ALLCAPS list |
| `proposal edit --maturity` help ~line 3183 | Same stale maturity list |
| `proposal edit` handler ~line 3651 | `.toUpperCase()` applied to `options.type` before DB write |

---

## Fix — commit `9189d4fe`

**File:** `src/apps/cli.ts` (12-line diff, no schema changes, no migration required)

### Help text corrections

| Command | Flag | Before | After |
|---|---|---|---|
| `proposal create` | `--type` | `"proposal type (DIRECTIVE, CAPABILITY, ...)"` | `"proposal type (product, component, feature, issue)"` |
| `proposal create` | `--maturity` | `"proposal maturity level (skeleton, contracted, audited)"` | `"proposal maturity level (new, active, mature, obsolete)"` |
| `proposal edit` | `--type` | same stale string | `"proposal type (product, component, feature, issue)"` |
| `proposal edit` | `--maturity` | same stale string | `"proposal maturity level (new, active, mature, obsolete)"` |

### Write-path corrections (P144)

| Handler | Before | After |
|---|---|---|
| `buildProposalFromOptions()` (create) | `String(options.type).toUpperCase()` | `String(options.type).toLowerCase()` |
| `proposal edit` handler | `String(options.type).toUpperCase()` | `String(options.type).toLowerCase()` |

---

## Canonical Values (post-fix)

### Proposal types (`roadmap.proposal_type_config`)

| Value | Meaning |
|---|---|
| `product` | Product-level initiative or outcome |
| `component` | Infrastructure or reusable system component |
| `feature` | User-facing feature addition or change |
| `issue` | Bug, regression, or operational issue |

### Maturity levels

| Value | Meaning |
|---|---|
| `new` | Proposal just entered its current workflow state; not yet claimed |
| `active` | Under active lease; work is in progress |
| `mature` | Agent self-declares done; awaiting gating decision to advance |
| `obsolete` | Superseded or invalidated; no further work expected |

---

## Verification (post-merge code audit, 2026-05-04)

All six ACs confirmed present in `src/apps/cli.ts`:

| AC | File location | Evidence |
|---|---|---|
| AC1 — `proposal create --type` help | line 1823 | `"proposal type (product, component, feature, issue)"` |
| AC2 — `proposal edit --type` help | line 3077 | `"proposal type (product, component, feature, issue)"` |
| AC3 — `proposal create --maturity` help | line 1927 | `"proposal maturity level (new, active, mature, obsolete)"` |
| AC4 — `proposal edit --maturity` help | line 3216 | `"proposal maturity level (new, active, mature, obsolete)"` |
| AC5 — create write path | line 1775 | `proposalType: String(options.type).toLowerCase()` |
| AC6 — edit write path | line 3681 | `editArgs.proposalType = String(options.type).toLowerCase()` |

No legacy uppercase references remain in the CLI write paths.

---

## Scope and Limitations

The fix is **CLI-scoped only**. Two lower-level paths remain unnormalized (see P144 for details):

- `src/apps/mcp-server/tools/proposals/pg-handlers.ts` — `prop_create` MCP tool passes `type` raw
- `src/infra/postgres/proposal-storage-v2.ts` — storage INSERT receives `input.type` without `.toLowerCase()`

Callers that bypass the CLI and supply an uppercase type will still receive an FK violation.

---

## Related Proposals

| Proposal | Relationship |
|---|---|
| P144 | FK violation from `.toUpperCase()` on write path — fixed in the same commit `9189d4fe` |
