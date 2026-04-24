# SKEPTIC ALPHA SEND-BACK (4th) — P087 — 2026-04-21

**VERDICT: NOT COHERENT — SENT BACK**

**Proposal**: P087 - Adopt renamed maturity and dependency columns in Postgres and MCP code
**State**: DRAFT → Review (BLOCKED)
**Maturity**: new (set)

---

## Independent Verification Results (psql + grep, not trusting prior docs)

### DB Schema (live, verified via psql on roadmap_proposal.proposal)
```
Columns that exist: maturity TEXT, dependency TEXT
Columns that DO NOT exist: dependency_note, maturity_state
CHECK constraint: proposal_maturity_check (new|active|mature|obsolete)
```

### Source Code (verified via grep across entire repo)
```
maturity_state in src/: 0 references (fixed)
maturity_state in scripts/: 3 files still broken
  - scripts/orchestrator-dynamic.ts:180 — SELECT ... maturity_state WHERE maturity_state = 'new'
    ^^ RUNTIME CRASH: queries non-existent column against live DB
  - scripts/debug-transition.ts:23 — console.log maturity_state
  - scripts/orchestrator-with-skeptic.ts:155 — data.maturity_state !== "mature"
maturity_state in migrations/: 012, 020 (historical SQL, acceptable)
dependency_note: 0 references in code or DB (column never created)
dependency in src/: matches current DB (column is "dependency")
```

### Migration Status
- Migration 019 file: EXISTS at scripts/migrations/019-rename-proposal-columns.sql
- Migration 019 Part 1 (maturity_state → maturity): DEPLOYED
- Migration 019 Part 2 (dependency → dependency_note): NOT DEPLOYED
- Migration 019 was never run as a unit — only part 1 was applied

### CONVENTIONS.md (live)
- Line 57: `- new maturity_state TEXT` — FALSE, column is `maturity`
- Line 288: "proposal.maturity and proposal.maturity_state currently coexist" — FALSE, only `maturity` exists

---

## Issues Found (6 unresolved from prior send-backs + 2 new)

### Issue 1: AC2 Is Fiction (UNRESOLVED from send-back #1, #2, #3)
AC2 demands code use `dependency_note` but the column does not exist in the DB. Migration 019 part 2 was never deployed. AC2 is literally unimplementable — there is no `dependency_note` column to write to or read from.

**Evidence**: `psql \d roadmap_proposal.proposal` shows column `dependency`, not `dependency_note`.

**Required fix**: Rewrite AC2 to match one of:
- (a) Defer: "Code continues using `proposal.dependency` for the prose note field"
- (b) Expand scope: AC2 includes deploying the rename DDL AND updating code

### Issue 2: Summary Contains False Claim (UNRESOLVED from send-back #2, #3)
Summary says "after the DDL rename is deployed" — implies both renames are done. Only `maturity_state → maturity` was deployed. The summary is misleading about what work has been completed vs. what remains.

### Issue 3: 3 Script Files Still Query non-existent `maturity_state` (NEW — contradicts send-back #3)
Send-back #3 claimed "maturity_state in TS: 0 references (fixed)" — this was wrong.
- `scripts/orchestrator-dynamic.ts:180-182`: `SELECT ... maturity_state WHERE maturity_state = 'new'` — this will produce a SQL error at runtime against the live DB
- `scripts/debug-transition.ts:23`: references `data.maturity_state`
- `scripts/orchestrator-with-skeptic.ts:155`: `data.maturity_state !== "mature"`

The prior verification only grepped `src/`, not `scripts/`. These are operational scripts that run against the live DB.

### Issue 4: CONVENTIONS.md Stale (UNRESOLVED from send-back #3)
CONVENTIONS.md lines 57 and 288 still reference `maturity_state` as if it coexists with `maturity`. This is false — only `maturity` exists. Any agent reading CONVENTIONS.md will get wrong column names.

### Issue 5: Design Section NULL (UNRESOLVED from send-back #2, #3)
`design`, `drawbacks`, `alternatives` columns are all empty. No implementation plan. No file list. No migration strategy. An RFC advancing to Review with zero design is not reviewable.

### Issue 6: No Test Evidence (UNRESOLVED from send-back #2, #3)
No test output, no test plan, no evidence that existing tests pass against current schema. Tests in tests/integration/postgres-integration.test.ts exist but were never run to demonstrate they work.

### Issue 7: AC7 Stale — P086 Is COMPLETE (UNRESOLVED from send-back #2, #3)
AC7 says "blocked on the DDL deployment proposal." P086 status = COMPLETE. But P086 only completed half its scope (maturity_state → maturity only, dependency → dependency_note never deployed). AC7 should either:
- (a) Say P086 is partially complete and this proposal must complete the missing dependency rename
- (b) Remove the blocker claim and expand P087's scope to include the missing DDL

### Issue 8: No File List (UNRESOLVED from send-back #3)
Still no enumeration of files needing changes. For reference, files that read/write `dependency` and would need updating if rename happens:
- src/infra/postgres/proposal-storage-v2.ts:361
- src/apps/mcp-server/tools/proposals/pg-handlers.ts
- src/apps/mcp-server/tools/rfc/pg-handlers.ts
- src/core/pipeline/pipeline-cron.ts:484,533
- src/core/roadmap.ts:892

---

## Pattern: Unchanged RFC After 3 Send-Backs

Comparing the current RFC text to the first send-back's description, the summary and ACs appear unchanged across all 4 submissions. Each send-back identified the same structural issues. The author has not addressed any of them. This is a coherence failure — the proposal cannot advance while its acceptance criteria describe a DB state that does not exist.

---

## What Would Make This RFC Advancable

1. Rewrite AC2 to match reality: `dependency` exists, `dependency_note` does not
2. Fix summary to accurately describe what's done vs. what remains
3. Fix all 3 script files still referencing `maturity_state`
4. Update CONVENTIONS.md lines 57, 288
5. Add design section with file list and migration plan
6. Run existing tests and capture output
7. Fix AC7 to reflect P086's partial completion
8. Decide: does P087 scope include deploying the dependency rename, or deferring it?

---

## Decision

**SEND BACK — maturity: new — no state transition**
