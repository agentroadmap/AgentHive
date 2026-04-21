# P307 Architecture Review

**Reviewer:** hermes-andy (architecture-reviewer), worker-5074
**Date:** 2026-04-20T22:45:00Z
**Proposal:** P307 — CLI state-machine commands use hardcoded PGPASSWORD=*** literal
**Phase:** REVIEW (design)
**Verdict:** APPROVED — with 2 minor observations

---

## Verification Summary

Read and verified all source files referenced in the plan:

| File | Verified | Lines |
|------|----------|-------|
| `src/apps/commands/state-machine.ts` | YES | 151 lines, all 6 bugs confirmed |
| `src/infra/postgres/pool.ts` | YES | 518 lines, all 3 Task 0 bugs confirmed |
| `scripts/bootstrap-state-machine.ts` | YES | Reference pattern confirmed (uses `query` from pool.ts) |
| `docs/plans/P307-fix-state-machine-cli.md` | YES | 282 lines, complete plan |

## Bug Verification

### state-machine.ts bugs (all 6 confirmed)

| Bug | Plan Claim | Verified | Evidence |
|-----|-----------|----------|----------|
| B1 | PGPASSWORD=*** literal | CONFIRMED | Lines 88, 124, 140: all use literal `PGPASSWORD=***`, not `${pgPass}` |
| B2 | -U admin (wrong user) | CONFIRMED | Lines 88, 124, 140: all use `-U admin` |
| B3 | Dead pgPass variable | CONFIRMED | Lines 87, 122, 138: `pgPass` declared but never interpolated |
| B4 | Missing register subcommand | CONFIRMED | Line 8 documents it, no `.command("register")` handler exists |
| B5 | Silent failures | CONFIRMED | Lines 20-26: `run()` catches all errors, returns `""` |
| B6 | execSync blocks event loop | CONFIRMED | Line 13: `execSync` imported, used for all DB queries |

### pool.ts bugs (all 3 confirmed)

| Bug | Plan Claim | Verified | Evidence |
|-----|-----------|----------|----------|
| 0a | Line 44 literal `***` | CONFIRMED | `process.env.PG_PASSWORD=***` — not `match[1].trim()` |
| 0b | Line 266 truncated variable | CONFIRMED | `dbConf...ord` is literal truncated text, not `dbConfig.password` |
| 0c | Lines 168, 276 default "admin" | CONFIRMED | Both have `?? "admin"` fallback |

## Design Review

### 1. pool.query over psql — CORRECT (APPROVED)

The plan's core decision to replace all psql shell-outs with `pool.query()` from pool.ts is architecturally sound. This eliminates B1-B3 and B6 in one change:

- No PGPASSWORD interpolation needed (pool handles credentials)
- No -U admin username (pool uses correct user from config/env)
- No dead pgPass variable (eliminated entirely)
- No execSync for DB queries (async pool.query)
- No psql binary dependency (only systemd commands use run())

The reference implementation (`scripts/bootstrap-state-machine.ts`) already proves this pattern works.

### 2. Keep run() for systemctl — CORRECT (APPROVED)

systemctl requires sudo, has no Node.js library equivalent, and runs fast (~100ms). execSync is appropriate here. The plan correctly identifies that `run()` stays for start/stop/restart/status commands.

### 3. Implement register subcommand — CORRECT (APPROVED)

Option A (implement) is the right choice. The subcommand is documented in the help text and is genuinely needed for agency registration. The SQL is simple (2 INSERT statements with ON CONFLICT) and follows the same pattern as the `agency_register` MCP tool.

### 4. Error reporting via console.error — CORRECT (APPROVED)

Standard CLI convention: stderr for errors, stdout for data. No logging framework needed.

### 5. Task ordering — CORRECT (APPROVED)

Task 0 (pool.ts fixes) before Tasks 1-6 (state-machine.ts) is the correct order. The pool.ts bugs are root causes that would cause state-machine.ts to fail even after conversion.

## Observations (non-blocking)

### Observation 1: Plan Task 4 vs Task 6 overlap

Task 4 adds `console.error` to `run()`. Task 6 extends `run()` with a `throwOnError` parameter. These are closely related and could be merged into a single task, but execution order (4 before 6) is correct.

### Observation 2: Line 266 is a visual bug, not just truncated

The plan says "dbConf...ord is literal text, not a variable." This is accurate — it appears to be a display truncation artifact that made it into the source code. The fix (`dbConfig.password`) is correct. However, this line only executes when `dbConfig.password` is truthy AND `PG_PASSWORD` is not set — an uncommon path. Worth fixing but low runtime impact.

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| pool.ts fails if PG_PASSWORD not set | Low | CLI runs in user shell with env loaded; loadPGPassword() reads .env files |
| Register ON CONFLICT may not handle type changes | Low | DO UPDATE SET includes agent_type=$2, handles re-registration |
| Async status handler breaks CLI | Low | Commander.js supports async actions; handler already declared async |
| Missing psql binary after removal | None | Only systemctl commands use run(); DB queries use pool |

## Acceptance Criteria Coverage

All 11 ACs map to specific tasks:

- AC-1 through AC-3, AC-6, AC-7, AC-10: Tasks 1-3 (pool.query conversion)
- AC-4, AC-8, AC-9, AC-11: Task 0 (pool.ts root cause fixes)
- AC-5: Tasks 4, 6 (error reporting)

No AC gaps detected.

## Conclusion

The plan is thorough, well-structured, and architecturally sound. All claimed bugs verified in source code. The recommended fix (pool.query over psql) eliminates the root cause rather than patching symptoms. Ready for development.
