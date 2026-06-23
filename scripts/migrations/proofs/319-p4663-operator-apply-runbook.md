# P4663 / mig 319 — Operator-Supervised Apply Runbook (AC-6 / AC-10)

Migration: `scripts/migrations/319-p4663-cumulative-gate-governance-guard.sql`
Rollback:  `scripts/migrations/rollback/319-p4663-cumulative-gate-governance-guard.rollback.sql`

**Blast radius: HIGH.** This redefines `roadmap_proposal.fn_guard_gate_advance`, the
trigger that fires on every proposal status advance. Apply only in a supervised
maintenance window. `fn_apply_gate_advance` is NOT modified.

> **Live-state note (verified 2026-06-22).** The live `agenthive` DB already has
> the P4663 *function body* installed (an earlier ad-hoc apply of the original,
> collided `316-p4663-…` file), and the live canonical ledger carries a stale row
> `filename = '316-p4663-cumulative-gate-governance-guard.sql'`. Consequences:
>   - Applying mig 319 on live is a **function no-op** (CREATE OR REPLACE of the
>     identical body) — its real effect on live is recording the correctly-named
>     `319-p4663-…` canonical ledger row.
>   - The operator should **delete the stale 316-p4663 ledger row** during the
>     same window so the canonical ledger has exactly one P4663 entry:
>     `DELETE FROM roadmap.schema_migration WHERE filename = '316-p4663-cumulative-gate-governance-guard.sql';`
>   - On a fresh tenant DB (pre-P4663), mig 319 installs the function for real.

## What it changes

1. Adds `DELIBERATION` to `proposal_status_canonical` CHECK + `roadmap.reference_terms`.
2. Replaces `fn_guard_gate_advance` with the cumulative P4663 guard:
   - `P_noBypass` — `app.gate_bypass` removed from ALL paths (completes P906/P3929).
   - `P_govEdges` / `P_gov48h` / `P_govHuman` — governance-amendment deliberation gates.
   - `P_termIndep` — terminal decider != proposal author (fail-closed).
   - `P_termAC` — `MERGE→COMPLETE` refuses zero-AC or unwaived pending/fail/blocked ACs.
   - `P_log` — non-terminal requires gate_decision_log; terminal requires log or review.
3. Ledgers the migration into the canonical `roadmap.schema_migration` with a
   checksum = sha256 of the INSTALLED `pg_get_functiondef` (not file bytes).

## Pre-apply preflight (AC-6 — canonical ledger authority)

The migration's own `DO` preflight block already asserts these and aborts on failure:

1. `roadmap_proposal.fn_guard_gate_advance` and `fn_apply_gate_advance` exist
   (mig 299 prerequisite).
2. Mig 298 (`298-p3566-gate-advance-integrity-audit.sql`) is recorded in the
   **canonical** ledger `roadmap.schema_migration` (NOT `migration_history` /
   `schema_migrations` — those are non-authoritative per P4664).
3. Idempotency: if `319-p4663%` is already ledgered, the apply is a safe no-op
   (CREATE OR REPLACE).

Operator should additionally confirm collision-freedom before apply:

```sh
npm run migrate:check          # expect: no duplicate-prefix collisions, exit 0
npm run check:semantic-writers # expect: "No NEW multi-writer objects", exit 0
```

## Apply (supervised window)

```sh
# Take a logical backup of the function + constraint first (rollback safety net):
docker exec postgres-db psql -U admin -d agenthive -tc \
  "SELECT pg_get_functiondef('roadmap_proposal.fn_guard_gate_advance'::regproc);" \
  > /tmp/fn_guard_gate_advance.preP4663.sql

# Apply inside the migration's own transaction (the file is BEGIN…COMMIT):
docker exec -i postgres-db psql -U admin -d agenthive -v ON_ERROR_STOP=1 \
  < scripts/migrations/319-p4663-cumulative-gate-governance-guard.sql
```

## Post-apply verification (must all pass)

```sh
# 1. Invariant checker (inspects pg_get_functiondef of the live function):
DATABASE_URL=postgresql://admin@127.0.0.1:5432/agenthive npm run check:gate-invariants
#    expect: PASS 8/8

# 2. No live gate_bypass reference (AC-12):
docker exec postgres-db psql -U admin -d agenthive -tAc \
  "SELECT (regexp_replace(pg_get_functiondef('roadmap_proposal.fn_guard_gate_advance'::regproc),
           '--[^\n]*','','g') LIKE '%gate_bypass%') AS has_live_bypass;"
#    expect: f

# 3. Ledger row + checksum recorded (AC-10/AC-15):
docker exec postgres-db psql -U admin -d agenthive -tc \
  "SELECT filename, left(checksum,16) FROM roadmap.schema_migration
   WHERE filename = '319-p4663-cumulative-gate-governance-guard.sql';"

# 4. Checksum matches installed definition:
docker exec postgres-db psql -U admin -d agenthive -tc \
  "SELECT encode(sha256(pg_get_functiondef('roadmap_proposal.fn_guard_gate_advance'::regproc)::bytea),'hex')
        = (SELECT checksum FROM roadmap.schema_migration
            WHERE filename = '319-p4663-cumulative-gate-governance-guard.sql') AS ok;"
#    expect: t
```

## Smoke checks (live, low-risk)

- A legitimate `MERGE→COMPLETE` via `record_gate_decision` (independent decider,
  all ACs pass) still advances. Watch for unexpected `check_violation` raises in
  the orchestrator dispatch logs for ~1 cycle after apply.
- A direct `UPDATE … SET status='REVIEW'` on a DRAFT proposal is refused
  (non-terminal gate_decision_log requirement) — confirms enforcement is live.

## Rollback

```sh
docker exec -i postgres-db psql -U admin -d agenthive -v ON_ERROR_STOP=1 \
  < scripts/migrations/rollback/319-p4663-cumulative-gate-governance-guard.rollback.sql
```

The rollback restores `fn_guard_gate_advance` to the mig 299 body (terminal
`app.gate_bypass` present again — this re-opens the P4663-AC-12 hole, so treat it
as temporary), removes `DELIBERATION` from the CHECK + reference_terms (only if no
proposal currently uses that status), and deletes the `319-p4663` ledger row.
It does NOT touch `fn_apply_gate_advance`. Re-apply mig 319 as soon as the
triggering issue is resolved.

## Scratch-DB proof (pre-merge evidence)

This migration was validated against a disposable scratch DB
(`agenthive_p4663_scratch`, schema cloned from live + minimal seed) — never on
live. Evidence: `check:gate-invariants` PASS 8/8; 26/26 gate-guard integration
tests pass; 17/17 P3563/P3566/P3929/P906 regression tests pass; idempotent
re-apply; rollback restores the prior function. The scratch DB was dropped after
verification.
```
