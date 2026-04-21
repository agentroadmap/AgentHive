# P307 Reviewer Assessment

**Reviewer:** worker-5071 (reviewer)
**Date:** 2026-04-20
**Proposal:** P307 — CLI state-machine commands use hardcoded PGPASSWORD=*** literal
**Phase:** REVIEW

---

## Bug Verification (Source Code Audit)

Read `src/apps/commands/state-machine.ts` (151 lines) and `src/infra/postgres/pool.ts` (518 lines).

### state-machine.ts Bugs — All 6 Confirmed Real

| Bug | Status | Evidence |
|-----|--------|----------|
| B1: PGPASSWORD=*** literal | CONFIRMED | Lines 88, 124, 140: `PGPASSWORD=***` is literal string, not interpolation. Line 87/122/138 declare `pgPass` but never use it in the command string. |
| B2: Wrong DB username | CONFIRMED | Lines 88, 124, 140: all use `-U admin`. DB has users xiaomi, andy, claude — no admin. |
| B3: Dead pgPass variable | CONFIRMED | Lines 87, 122, 138: `const pgPass = process.env.PG_PASSWORD \|\| ""` — declared 3x, never referenced. |
| B4: Missing register subcommand | CONFIRMED | Line 8 JSDoc documents `sm register`. No `.command("register")` or `.action()` handler exists. |
| B5: Silent failures | CONFIRMED | Lines 20-26: `run()` catches ALL errors, returns `""`. No stderr output, no diagnostics. |
| B6: execSync blocks event loop | CONFIRMED | Line 13: `execSync` with 10s timeout. Blocks Node event loop for entire duration of each psql call. |

### pool.ts Bugs — All 3 Confirmed Real

| Bug | Status | Evidence |
|-----|--------|----------|
| 0a: Line 44 literal *** | CONFIRMED | `process.env.PG_PASSWORD=***` — literal assignment, should be `process.env.PG_PASSWORD = match[1].trim()`. The regex on line 42 correctly captures the value but it's never used. |
| 0b: Line 266 truncated variable | CONFIRMED | `dbConf...ord` is literal truncated text, not a variable. Should be `dbConfig.password`. |
| 0c: Lines 168/276 default "admin" | CONFIRMED | Both fallback to `?? "admin"`. No admin user exists. Should be `?? "xiaomi"` (primary user). |

### Cross-File Interaction (Root Cause Chain)

Confirmed the two-layer root cause described in the architect review:

1. **AgentHive `.env` line 1:** `PG_PASSWORD=***` (sentinel value — intentional placeholder)
2. **pool.ts line 44:** `loadPGPassword()` reads `.env`, assigns `***` to `process.env.PG_PASSWORD` because the regex match result is discarded
3. **state-machine.ts lines 87-88:** Reads `process.env.PG_PASSWORD` into `pgPass`, then ignores it and uses literal `***`

The state-machine bugs would partially work IF pool.ts line 44 were fixed (correct PG_PASSWORD loaded from .env), but state-machine.ts still wouldn't use it because pgPass is never interpolated. Both layers must be fixed.

**Confirmed:** The .env sentinel `PG_PASSWORD=***` is the project convention — per-agent passwords live in `XIAOMI_PG_PASSWORD`, `ANDY_PG_PASSWORD`, `CLAUDE_PG_PASSWORD`. Pool.ts must skip the sentinel value during loading, not blindly assign it.

---

## Plan Quality Assessment

### Strengths

1. **Correct architectural choice:** pool.query over psql eliminates B1-B3 and B6 simultaneously. Reference implementation (`bootstrap-state-machine.ts`) already uses this pattern correctly.

2. **Root cause ordering:** Fixing pool.ts (Task 0) before state-machine.ts (Tasks 1-6) is correct — pool.ts bugs are upstream causes.

3. **Register subcommand: implement, don't remove.** Option A is correct. The subcommand is documented and genuinely needed. ON CONFLICT makes it idempotent.

4. **Error handling:** Keeping `run()` for systemctl (system binary, no Node equivalent) and adding stderr reporting is pragmatic.

5. **Verification criteria are testable.** Each AC maps to a specific task and has a concrete check (grep, runtime test, type check).

### Issues Found

#### Issue 1: VERIFICATION — `tsc --noEmit` on single file won't work

**AC-10 verification says:** `npx tsc --noEmit src/apps/commands/state-machine.ts`

TypeScript project references and path aliases mean single-file type checking won't resolve imports correctly. Should use project-wide check:
```
npx tsc --noEmit
```
Or at minimum verify the import path resolves: `grep getPool src/infra/postgres/pool.ts`.

**Severity:** Low (verification step only, not a code bug)

#### Issue 2: PGPASSWORD env var interaction not addressed

The plan fixes pool.ts to skip `***` sentinel, but doesn't document the env variable naming conflict:

- `PGPASSWORD` (psql env var — used by the old state-machine code)
- `PG_PASSWORD` (pool.ts convention — used by the new code)

After the fix, state-machine.ts uses pool.ts which uses `PG_PASSWORD`. Users who have `PGPASSWORD` set in their shell (common for psql users) won't get it picked up by pool.ts. This is correct behavior but should be documented to prevent confusion.

**Severity:** Low (documentation gap, not a code bug)

#### Issue 3: Task 5 register — missing project_id join

The register implementation inserts into `agent_registry` and `agent_capability` but doesn't join to any project. The existing `agency_register` MCP tool also does project join. Plan should clarify whether register should auto-join a default project or require a separate `sm join` command.

Looking at the SQL in state-machine.ts lines 140-148 (the Join project section), there's already a pattern for joining. The register command should at minimum document this gap.

**Severity:** Low (feature scope question, not blocking)

#### Issue 4: No guard for pool.ts loadPGPassword sentinel skip

Task 0a fixes the `match[1].trim()` issue but the plan's AC-11 says "loadPGPassword() skips sentinel value ***". The current code assigns the match result to `PG_PASSWORD`. If the match result IS `***` (from `.env`), it should skip. The fix should add:
```typescript
const password = match[1].trim();
if (password === '***') continue;  // skip sentinel
process.env.PG_PASSWORD = password;
```

**Severity:** Medium — without this guard, fixing the match[1] bug still loads `***` as the real password from .env.

---

## Acceptance Criteria Review

| AC | Verdict | Notes |
|----|---------|-------|
| AC-1: state-machine.ts uses getPool() | PASS | Correct approach |
| AC-2: Eliminates psql shell-outs | PASS | All 3 replaced |
| AC-3: Register subcommand implemented | PASS | Option A with ON CONFLICT |
| AC-4: pool.ts line 44 uses match[1].trim() | CONDITIONAL | Need sentinel skip guard (Issue 4) |
| AC-5: run() reports errors to stderr | PASS | console.error in catch |
| AC-6: execSync replaced with pool.query() | PASS | For DB queries; kept for systemctl |
| AC-7: Dead pgPass removed | PASS | All 3 declarations removed |
| AC-8: pool.ts default user changed to xiaomi | PASS | Lines 168, 276 |
| AC-9: pool.ts line 266 fixed | PASS | dbConfig.password |
| AC-10: No psql shell-outs remain | PASS | Grep verification |
| AC-11: loadPGPassword() skips sentinel | CONDITIONAL | Needs sentinel guard (Issue 4) |

---

## Verdict

**APPROVED WITH CONDITIONS**

The plan is sound. The architectural decision to use pool.query is correct and eliminates the majority of bugs. The 4 issues found are non-blocking:

- **Issue 4 (sentinel guard) is the only medium-severity item** — must be added to Task 0a. Without it, fixing the regex match still loads `***` as the password.
- Issues 1-3 are documentation and verification improvements.

### Required Before Merge

1. Add sentinel skip guard to Task 0a in pool.ts `loadPGPassword()`:
   ```typescript
   const password = match[1].trim();
   if (password === '***') continue;
   process.env.PG_PASSWORD = password;
   ```

2. Fix verification step for AC-10: use `npx tsc --noEmit` (project-wide) not single-file.

### Recommended Improvements

3. Document PGPASSWORD vs PG_PASSWORD naming convention in the plan's Design Notes.
4. Clarify whether `sm register` should auto-join a default project.

---

## Risk: Pool init failure in stripped environments

If pool.ts fails because PG_PASSWORD isn't set (no .env, no env var), the `getPool()` call throws at pool creation. For systemctl start/stop commands that don't need DB, this would crash the CLI unnecessarily. Consider lazy pool initialization or try/catch around DB-dependent commands only.

**Severity:** Low (edge case, unlikely in practice — CLI runs in user shell with .env loaded)
