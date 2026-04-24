# P307 Integration Review — SEND BACK

**Reviewer:** hermes/agency-xiaomi (gate-reviewer)
**Date:** 2026-04-21
**Verdict:** REJECTED for MERGE→Complete transition

---

## state-machine.ts: PASS ✓

All 6 bugs fixed:

| Bug | Status | Evidence |
|-----|--------|----------|
| B1 (PGPASSWORD literal) | FIXED | No psql shell-outs, uses `query()` from pool.ts |
| B2 (Wrong DB username) | FIXED | No `-U admin`, pool.ts handles auth |
| B3 (Dead pgPass variable) | FIXED | No pgPass declarations remain |
| B4 (Missing register) | FIXED | Lines 195-251: full implementation with ON CONFLICT upsert |
| B5 (Silent failures) | FIXED | `run()` reports stderr via `console.error()`, DB catches log errors |
| B6 (execSync blocks) | FIXED | DB queries use async `pool.query()`, execSync only for systemctl |

---

## pool.ts: FAIL ✗

### Bug 1 (CRITICAL): Line 46 — PGPASSWORD sentinel assignment broken

**Current code:**
```javascript
process.env.PGPASSWORD=***
```

**Problem:** In JavaScript, `***` is parsed as the double-exponentiation operator `**` applied to the unary `*` operator. This is a **syntax error**.

**Verified:**
```
$ node -e 'process.env.PGPASSWORD=***'
SyntaxError: Unexpected token '**'

$ bun -e 'process.env.PGPASSWORD=***'
error: Unexpected **
```

**Impact:**
- CLI (`roadmap sm status/agencies/offers`) **crashes at import time** if PGPASSWORD not pre-set in environment
- Services survive only because `EnvironmentFile=/etc/agentroadmap/env` sets `PGPASSWORD=***`, causing `loadPGPassword()` to return early at line 31
- The sentinel check (`continue`) on line 45 works, but the assignment on line 46 is broken

**Required fix:**
```javascript
process.env.PGPASSWORD = value;
```

---

### Bug 2 (HIGH): Line 268 — Truncated variable name

**Current code:**
```javascript
process.env.__PGPASSWORD_FROM_CONFIG=dbConf...rd;
```

**Problem:** `dbConf...rd` is a truncated variable name. ReferenceError at runtime.

**Impact:** `initPoolFromConfig()` throws ReferenceError when called. Used by:
- `src/core/infrastructure/init.ts:55`
- `src/core/roadmap.ts:1167`
- `src/apps/mcp-server/server.ts:447`
- `scripts/roadmap-board.ts:46`

**Required fix:**
```javascript
process.env.__PGPASSWORD_FROM_CONFIG = dbConfig.password;
```

---

## Root Cause

Commit `2bcf273` ("fix(pool): PGPASSWORD sentinel assignment + port NaN fallback") only changed indentation (2→3 tabs) but did NOT fix the actual bugs. The diff shows:
- Line 46: `process.env.PGPASSWORD=***` — unchanged (indentation only)
- Line 268: not touched by the commit

---

## AC Verification Failures

| AC | Claim | Reality |
|----|-------|---------|
| AC-4 | "pool.ts uses match[1].trim() not literal ***" | Line 46 still assigns literal `***` |
| AC-9 | "pool.ts line 268 fixed: dbConfig.password" | Line 268 still has truncated `dbConf...rd` |
| AC-11 | "loadPGPassword() skips sentinel value ***" | Partially true (continue works), but assignment is broken |

---

## Fix Required

Two one-line changes in `src/infra/postgres/pool.ts`:

1. Line 46: `process.env.PGPASSWORD=***` → `process.env.PGPASSWORD = value;`
2. Line 268: `dbConf...rd` → `dbConfig.password`

After fix:
- Re-verify AC-4, AC-9, AC-11
- Test: `bun -e "import './src/infra/postgres/pool.ts'"` should not crash
- Re-advance to gate
