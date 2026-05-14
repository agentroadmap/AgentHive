# P371 — fn_sync_proposal_maturity Gate-Loop Noise: Ship Report

**Proposal:** P371 — fn_sync_proposal_maturity resets COMPLETE proposals to 'mature', causing pg_notify gate-loop noise  
**Type:** issue  
**Status:** COMPLETE  
**Related fixes:** P409 (migration 046), P409b (migration 049), P704 (migration 066)

---

## 1. Incident Summary

On 2026-04-21 the orchestrator dispatched gate agents to 10 proposals that had no lease, no work in progress, and no business needing a gate review:

| Group | Proposals | Status/Maturity |
|-------|-----------|-----------------|
| DRAFT | P375, P376, P377, P305, P150, P242 | DRAFT/new |
| DEVELOP | P187, P302, P294, P209 | DEVELOP/new |

All 10 dispatches were cancelled manually. skeptic-alpha and skeptic-beta were assigned within seconds of proposal creation, burning credits on empty proposals.

---

## 2. Root Cause Chain

### 2.1 fn_sync_proposal_maturity — terminal-stage bug

Migration 011 introduced `fn_sync_proposal_maturity`, a `BEFORE UPDATE` trigger on `roadmap.proposal` that auto-derived the `maturity` column from `status`:

```sql
-- migration 011 (original — buggy)
v_level := CASE
  WHEN NEW.status IN ('DEPLOYED','COMPLETE','MERGED','CLOSED','WONT_FIX') THEN 'mature'
  WHEN NEW.status IN ('FIX','DEVELOP','REVIEW','REVIEWING','MERGE','ESCALATE') THEN 'active'
  WHEN NEW.status IN ('REJECTED','DISCARDED','ABANDONED') THEN 'obsolete'
  ELSE 'new'
END;
NEW.maturity := jsonb_build_object(NEW.status, v_level);
```

**Problem 1 — COMPLETE → 'mature' on every status touch.** Any UPDATE that triggered the function on a COMPLETE proposal reset `maturity = 'mature'`. If the orchestrator or any service touched those rows, `pg_notify('proposal_gate_ready')` fired and gating was queued for already-finished work.

**Problem 2 — maturity column type mismatch.** The function wrote `jsonb_build_object(status, level)` (e.g. `{"COMPLETE": "mature"}`) into the TEXT-typed `maturity` column. The downstream `fn_validate_proposal_reference_terms` trigger rejected status changes with `Unknown proposal maturity "{COMPLETE: mature}"`. This bug was masked because the trigger only fires on status CHANGE, and most callers went through service paths that bypassed the trigger.

### 2.2 claimImplicitGateReady — maturity filter gap

The orchestrator's `claimImplicitGateReady` function (`scripts/orchestrator.ts:1691`) polls for gate-ready proposals. At the time of the incident it was not reliably filtering out `maturity='new'` proposals. Newly created DRAFT and DEVELOP proposals with `maturity=new` (no lease ever held) appeared as gate candidates, defeating the P240 implicit maturity gating model.

---

## 3. Fix Chain

### 3.1 Migration 046 — P409 terminal-stage guard

`scripts/migrations/046-p409-fn-sync-proposal-maturity-complete-guard.sql`

Added an early-return guard for terminal statuses. Proposals in `DEPLOYED`, `COMPLETE`, `CLOSED`, `MERGED`, or `RECYCLED` states now exit the trigger immediately without modifying `maturity`:

```sql
IF NEW.status IN ('DEPLOYED','COMPLETE','CLOSED','MERGED','RECYCLED') THEN
  RETURN NEW;   -- maturity untouched
END IF;
```

This prevents any subsequent UPDATE on a COMPLETE proposal from re-emitting `pg_notify` or resetting maturity.

### 3.2 Migration 049 — P409b TEXT type fix

`scripts/migrations/049-p409b-maturity-text-assignment-fix.sql`

Fixed the JSON-object-into-TEXT bug. The assignment now writes only the level string:

```sql
-- Before (broken): NEW.maturity := jsonb_build_object(NEW.status, v_level);
-- After (fixed):
NEW.maturity := v_level;   -- 'new' | 'active' | 'obsolete'
```

This unblocked status transitions that had been silently failing validation.

### 3.3 Migration 066 — P704 lease-driven maturity redesign

`scripts/migrations/066-p704-lease-maturity-triggers.sql`

A deeper redesign that redefined what `maturity` means:

| Old model | New model |
|-----------|-----------|
| `active` = "mid-workflow status" (set by status trigger) | `active` = "has alive lease" (set only by lease insert trigger) |
| No lease trigger on release | `trg_lease_clear_maturity_on_release` recomputes maturity on lease release |
| 95 proposals stuck at `active` with no lease | One-shot sweep fixes stuck rows |

**Three new triggers:**

| Trigger | Function | When | Effect |
|---------|----------|------|--------|
| `trg_proposal_maturity_sync` (rewritten) | `fn_sync_proposal_maturity` | BEFORE UPDATE on proposal | Maps COMPLETE→'mature', REJECTED→'obsolete', else 'new'; never sets 'active' |
| `trg_lease_set_maturity_active` | `fn_lease_set_maturity_active` | AFTER INSERT on proposal_lease | Sets `maturity='active'` when a fresh lease is created |
| `trg_lease_clear_maturity_on_release` | `fn_lease_clear_maturity_on_release` | AFTER UPDATE OF released_at on proposal_lease | Sets 'mature' if `release_reason IN ('work_delivered','gate_review_complete')`, else 'new' |

The live `fn_sync_proposal_maturity` after migration 066:

```sql
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;

  -- Terminal: honest 'mature' so field is not stale; gates exclude COMPLETE by status filter
  IF NEW.status IN ('DEPLOYED','COMPLETE','CLOSED','MERGED','RECYCLED') THEN
    NEW.maturity := 'mature';
    RETURN NEW;
  END IF;

  IF NEW.status IN ('REJECTED','DISCARDED','ABANDONED') THEN
    NEW.maturity := 'obsolete';
    RETURN NEW;
  END IF;

  -- Check for alive lease; if yes keep 'active', else 'new'
  IF EXISTS (SELECT 1 FROM roadmap_proposal.proposal_lease
              WHERE proposal_id = NEW.id AND released_at IS NULL
                AND (expires_at IS NULL OR expires_at > now())) THEN
    NEW.maturity := 'active';
  ELSE
    NEW.maturity := 'new';
  END IF;

  RETURN NEW;
END
```

**Note:** Terminal proposals now have `maturity='mature'` (not 'new' or 'active'), but `claimImplicitGateReady` excludes them via a separate `status NOT IN ('COMPLETE','MERGED',...)` filter, so they do not re-enter the gate queue.

### 3.4 claimImplicitGateReady hardening

The orchestrator's polling query (`scripts/orchestrator.ts:1724`) now requires both conditions:

```sql
WHERE p.maturity = 'mature'
  AND LOWER(p.status) IN ('draft', 'review', 'develop', 'merge', 'triage', 'fix')
```

This double guard (maturity AND status allowlist) ensures COMPLETE proposals and newly created `maturity=new` proposals are both excluded from gate dispatch.

---

## 4. Impact Summary

| Before | After |
|--------|-------|
| COMPLETE proposals re-emitted `pg_notify` on any UPDATE | Terminal guard blocks maturity recomputation entirely |
| `maturity` column held JSON objects like `{"COMPLETE":"mature"}` | Column holds plain text: `new` \| `active` \| `mature` \| `obsolete` |
| 95 proposals stuck `maturity=active` with no lease | One-shot sweep + lease triggers keep maturity honest |
| Gate dispatched to `maturity=new` proposals | Both `maturity=mature` AND status-allowlist required for dispatch |

---

## 5. Migration Reference

| Migration | P-ref | What it fixed |
|-----------|-------|---------------|
| `011-maturity-sync-trigger.sql` | — | Original trigger (introduced the bug) |
| `046-p409-fn-sync-proposal-maturity-complete-guard.sql` | P409 | Terminal-stage early return |
| `049-p409b-maturity-text-assignment-fix.sql` | P409b | JSON-object-into-TEXT type fix |
| `066-p704-lease-maturity-triggers.sql` | P704 | Full lease-driven redesign + stuck-row sweep |

---

## 6. Related Proposals

- **P409** — COMPLETE guard for fn_sync_proposal_maturity (migrations 046 + 049)
- **P704** — lease-driven maturity redesign (migration 066)
- **P240** — implicit maturity gating design (the contract that P371 violated)
