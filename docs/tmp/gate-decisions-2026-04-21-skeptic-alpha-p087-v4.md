# Gate Decision: P087 — SKEPTIC ALPHA — 2026-04-21 (3rd)

**Proposal:** P087 — Adopt renamed maturity and dependency columns in Postgres and MCP code
**Gate Level:** D1 (Draft → Review)
**Decision:** SEND BACK
**Decided By:** skeptic-alpha (worker-9033)
**Timestamp:** 2026-04-21

---

## VERDICT: NOT COHERENT

The proposal claims to rename columns "after DDL deployment" but the actual situation is more broken than described.

---

## EVIDENCE (verified against live DB + source code)

### Actual DB Schema (`roadmap.proposal`)

```
column_name       | data_type
------------------+----------
maturity          | text
dependency        | text
```

**Does NOT exist:** `maturity_state`, `dependency_note`

### P086 (Migration 019) Status: HALF DEPLOYED

The migration script (`scripts/migrations/019-rename-proposal-columns.sql`) renames BOTH:
- `maturity_state → maturity` — **DONE**
- `dependency → dependency_note` — **NOT DONE**

P086 is not a blocker. It's an incomplete deployment.

### Broken Source Files — Two-Direction Breakage

#### Direction 1: Scripts query `maturity_state` (column gone → crashes)

| File | Line | Code | Severity |
|------|------|------|----------|
| `scripts/orchestrator-dynamic.ts` | 180-182 | `SELECT ... maturity_state WHERE maturity_state = 'new'` | CRASH |
| `scripts/orchestrator-unlimited.ts` | 168 | `WHERE maturity_state = 'new'` | CRASH |
| `scripts/orchestrator-with-skeptic.ts` | 155 | `data.maturity_state !== "mature"` | CRASH |
| `scripts/skeptic-gate-review.ts` | 29, 70 | `p149Data.maturity_state` | CRASH |
| `scripts/discord-bridge.ts` | 301 | `data.to_maturity ?? data.maturity_state ?? data.maturity` | Degraded |
| `scripts/discord-bridge-enhanced.ts` | 28 | `data.maturity_state \|\| data.maturity` | Degraded |
| `scripts/debug-transition.ts` | 23 | `data.maturity_state` | Degraded |
| `scripts/promote-via-fix.ts` | 53 | `data.maturity_state` | Degraded |

#### Direction 2: src/ core code queries `dependency_note` (column doesn't exist → crashes)

| File | Line | Code | Severity |
|------|------|------|----------|
| `src/infra/postgres/proposal-storage-v2.ts` | 920 | `COALESCE(dependency_note, '')` | CRASH |
| `src/core/pipeline/pipeline-cron.ts` | 484 | `p.dependency_note AS dependency_note` | CRASH |
| `src/apps/mcp-server/tools/proposals/pg-handlers.ts` | 101 | `dependency_note: "dependency_note"` mapping | CRASH |
| `src/apps/mcp-server/tools/proposals/pg-handlers.ts` | 350 | INSERT using `dependency_note` | CRASH |

### Documentation Issues

- `CONVENTIONS.md:57` lists `maturity_state` as a live column — FALSE
- `CONVENTIONS.md:288` claims both coexist — FALSE, only `maturity` exists
- `CONVENTIONS.md:56` says `maturity` is JSONB — FALSE, it's TEXT

---

## AC ANALYSIS

| AC | Status | Issue |
|----|--------|-------|
| AC1 | MISLEADING | src/ core already uses `maturity` — but 7+ script files still crash on `maturity_state` |
| AC2 | FICTION | `dependency_note` column does NOT exist in DB. Some src/ code already references it (broken). The actual task is: deploy the DB rename OR revert the premature code changes |
| AC3 | OK | Structured deps in `proposal_dependencies` — correct |
| AC4 | UNVERIFIABLE | MCP handlers reference `dependency_note` in column maps — these queries are BROKEN right now |
| AC5 | NO EVIDENCE | Zero test results, zero file list, zero verification |
| AC6 | IMPOSSIBLE | Docs cannot describe a state that doesn't exist in DB (`dependency_note` is not a column) |
| AC7 | STALE | P086 is incomplete deployment, not a blocker |

---

## REQUIRED FIXES

1. **DECISION NEEDED:** Deploy the `dependency → dependency_note` rename, OR revert premature `dependency_note` code changes back to `dependency`?
2. **Fix all script files** querying `maturity_state` → `maturity`
3. **Fix `src/` core code** if reverting (or it's already correct if deploying rename)
4. **Fix `CONVENTIONS.md`** — remove false `maturity_state` references, describe actual DB state
5. **Add complete file list** — every file that needs changes
6. **Add Design section** — describe the migration approach (DB-first vs code-first, deploy order)
7. **Add test evidence** — actual psql output proving columns exist and queries work
8. **Rewrite ACs** to match actual DB state and real tasks
9. **Remove AC7** — reframe as "finish P086 deployment" if that's the chosen path

---

## The Core Question

This proposal cannot advance without answering: **does the project want `dependency_note` or should it stay `dependency`?**

- If `dependency_note`: finish P086's DB migration, then this proposal is just the code cleanup
- If `dependency`: revert the premature `dependency_note` changes in src/, then this proposal handles the maturity_state cleanup in scripts
