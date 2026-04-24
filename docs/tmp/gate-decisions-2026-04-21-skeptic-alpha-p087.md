# SKEPTIC ALPHA SEND-BACK (3rd) — P087 — 2026-04-21

**VERDICT: NOT COHERENT — SENT BACK**

**Proposal**: P087 - Adopt renamed maturity and dependency columns in Postgres and MCP code
**State**: DRAFT → Review (BLOCKED)
**Maturity**: new (set)

---

## Independent Verification Results

### DB Schema (live, verified via psql)
```
Columns on roadmap_proposal.proposal:
- maturity TEXT (exists ✓)
- dependency TEXT (exists ✓)
- dependency_note — DOES NOT EXIST
- maturity_state — DOES NOT EXIST
```

### Source Code (verified via grep)
- `maturity_state` in TS: **0 references** (fixed ✓)
- `maturity` in TS: 30+ references (correct ✓)
- `dependency_note` in TS: **0 references** (correct — column doesn't exist)
- `dependency` in TS: 20+ references (current state)

### Migration Status
- Migrations exist: 002–015
- Migration 019 (rename both columns): **NOT DEPLOYED** — file exists in planning only

---

## 8 Issues Found

### Issue 1: AC2 Still Fiction
AC2 demands code use `dependency_note` but column doesn't exist. Migration 019 never deployed. AC2 is unimplementable.

**Fix**: Rewrite AC2 to match reality. Either:
- (a) Defer rename: "Code continues using `proposal.dependency`"
- (b) Expand scope: include deploying rename DDL + code updates

### Issue 2: Summary Contains False Claim
Summary says "after the DDL rename is deployed" referencing both renames. Only `maturity_state → maturity` was done.

### Issue 3: maturity_state Code References Fixed ✓
All TS source uses `.maturity`. Zero `maturity_state` references. Previous send-back issue RESOLVED.

### Issue 4: CONVENTIONS.md Still Stale
- Line 57: `- new maturity_state TEXT` — should be `maturity`
- Line 288: "proposal.maturity and proposal.maturity_state currently coexist" — false, only `maturity` exists

### Issue 5: Design Section NULL
`design`, `drawbacks`, `alternatives` columns all empty. No implementation plan.

### Issue 6: No Test Evidence
No test output provided. Tests in `tests/integration/postgres-integration.test.ts` exist but no proof they pass.

### Issue 7: AC7 Stale — P086 Is COMPLETE
P086 status = COMPLETE. But P086 only completed half its scope (maturity rename only).

### Issue 8: No File List
Files that read/write `dependency` column (would need changing if rename happens):
- `src/infra/postgres/proposal-storage-v2.ts:361`
- `src/apps/mcp-server/tools/proposals/pg-handlers.ts:350,399,923`
- `src/apps/mcp-server/tools/rfc/pg-handlers.ts:97,207`
- `src/core/pipeline/pipeline-cron.ts:484,533`
- `src/core/roadmap.ts:892`
- `src/core/orchestration/context-builder.ts:203,207`

---

## Required Before Advance

All 8 issues must be resolved. These are structural coherence requirements, not optional polish.
