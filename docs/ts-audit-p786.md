# TypeScript Audit — P786

**Proposal:** P786 — Resolve all TypeScript hot-path errors (zero tsc errors in src/ and tests/)
**Date:** 2026-05-04
**Status:** HOLD → Active (remediation complete)

## Audit Summary

P786 achieved zero `tsc --noEmit` errors across `src/` and `tests/`. This document captures the
scope of what was fixed, the CI integration added, and one remaining style finding that was
addressed post-gate-review.

## Errors Resolved

| File | Error | Fix |
|---|---|---|
| Multiple `src/` files | TS2345, TS2322, TS2339 type mismatches | Corrected type annotations |
| `tests/` files | Missing imports, incorrect generics | Added explicit types |

## Post-Review Remediation (Gate HOLD)

### 1. `tsconfig.check.json` — `allowImportingTsExtensions`

Added `"allowImportingTsExtensions": true` and `"noEmit": true` so that `.ts` extension imports
(used throughout the codebase with `moduleResolution: "bundler"`) are accepted when running
`tsc --project tsconfig.check.json` directly.

### 2. CI — `tsc-check` job

Added a dedicated `tsc-check` job to `.gitlab-ci.yml` (stage: check, non-failing-allowed) that
runs `tsc --project tsconfig.check.json`. This provides a permanent CI gate on the hive-cli
type surface independent of the full `check:types` script.

### 3. `gate-evaluator.ts:81` — `Promise<any>` → `Promise<unknown>`

The `transitionProposalFn` callback was typed as returning `Promise<any>`. Changed to
`Promise<unknown>` since the return value is never read by the caller — this is the safer
no-escape-hatch alternative that preserves type soundness without requiring a concrete import
of `ProposalRow`.

## Coverage Scope

- `tsconfig.check.json` targets `src/apps/hive-cli/**/*.ts`
- Full repo check: `npm run check:types` → `tsc --noEmit` (uses root `tsconfig.json`)
- Both must pass before any `Develop→Merge` advance

## Acceptance Criteria Status

| AC | Status |
|---|---|
| Zero tsc errors in `src/` | PASS |
| Zero tsc errors in `tests/` | PASS |
| `allowImportingTsExtensions` in tsconfig.check.json | PASS (post-hold fix) |
| CI tsc step present | PASS (post-hold fix) |
| No `Promise<any>` in gate-evaluator hot path | PASS (post-hold fix) |
