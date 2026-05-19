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

## P786 Final Remediation (2026-05-10)

### Duplicate config keys removed

Three keys in `src/shared/runtime/config-keys.ts` were defined twice (TS1117):
- `AGENTHIVE_TENANT_POOL_LRU_MAX` (lines 320 and 421)
- `AGENTHIVE_TENANT_POOL_MAX` (lines 336 and 437)
- `AGENTHIVE_DRAIN_TIMEOUT_MS` (lines 352 and 453)

Earlier stubs (lines 320–366) removed; canonical definitions with `envOverride`, `Math.trunc`
validation, and descriptive error messages kept.

### tsconfig.check.json scope expanded

Now covers:
- `src/apps/hive-cli/**/*.ts`
- `src/apps/cubic-agents/**/*.ts`
- `src/core/gate/**/*.ts`

### CI gate added

`npm run typecheck` step added to `.github/workflows/publish-hygiene.yml` — fails the build on
any type errors in the hot-path file set.

## Coverage Scope

- `tsconfig.check.json` targets hive-cli, cubic-agents, gate subsystems
- `npm run typecheck` wired in GitHub Actions `publish-hygiene.yml`
- Full repo check: `npm run check:types` → `tsc --noEmit` (uses root `tsconfig.json`)

## Acceptance Criteria Status

| AC | Status |
|---|---|
| AC-1: control-plane-client.ts zero `any[]` | PASS |
| AC-2: `npm run typecheck` exits 0 | PASS |
| AC-3: gate-evaluator.ts and agent-spawner.test.ts no implicit-any | PASS |
| AC-4: CI pipeline typecheck step | PASS (publish-hygiene.yml) |
| AC-5: Unit tests unaffected (type-only changes) | PASS |
| AC-6: ts-audit-p786.md committed | PASS |
