# P397 — Budget & Spending Control Center: Ship Report

**Status:** COMPLETE  
**Date:** 2026-05-12  
**Schema:** `roadmap_efficiency` (pre-P429: `agenthive` @ `127.0.0.1:5432`; post-P429: `hiveControl` via `config.getControlPool()`)

---

## What shipped

A four-tier spending authority model for all LLM agents, backed by PostgreSQL. The system tracks, warns, and hard-stops agent spending without ever storing aggregates — all totals are derived from the immutable `spending_log` at query time.

---

## Four-Tier Authority Model

| Tier | Trigger | Mechanism |
|------|---------|-----------|
| **View-only** | Any operator | `spending_report` MCP tool → `v_daily_spend` snapshot |
| **Warn (80%)** | `logSpending()` post-INSERT | Returns `budget_warning_80pct` JSON before responding OK |
| **Hard stop** | Daily limit reached | Handler auto-sets `is_frozen=true`; pre-check blocks all further INSERTs |
| **Override** | Operator | `spending_set_cap` with `is_frozen=false` or raised `daily_limit_usd` |

---

## Schema

All tables live in `roadmap_efficiency`. DDL canonical source: `database/ddl/roadmap-baseline-2026-04-13.sql` lines 3046–3092.

### `spending_caps`
Per-agent soft and hard limits. `is_frozen` is the authoritative gate — when `true`, all `logSpending()` calls return immediately without inserting.

```
agent_identity     text NOT NULL  (PK)
daily_limit_usd    numeric(12,2)
monthly_limit_usd  numeric(14,2)
is_frozen          boolean DEFAULT false NOT NULL
frozen_reason      text
updated_at         timestamptz DEFAULT now()
```

### `spending_log`
Immutable cost ledger. `cost_usd` is `numeric(14,6)` — 6 decimal places to match model pricing precision. A `CHECK (cost_usd >= 0)` constraint prevents negative entries.

### `budget_allowance`
Named budget envelopes per model (scope=`global`, owner=`system`). Seeded at $10/model by migration 028.

### `budget_circuit_breaker`
Global hard ceiling. Seeded at $100 total / $20 daily by migration 028.

### `v_daily_spend` (VIEW)
Derived daily totals over `spending_log`. No stored aggregates.

---

## MCP Tools Registered

| Tool | Handler method | Description |
|------|----------------|-------------|
| `spending_set_cap` | `PgSpendingHandlers.setSpendingCap()` | Upsert per-agent cap; supports `is_frozen` override |
| `spending_log` | `PgSpendingHandlers.logSpending()` | Log one cost event; returns warn/exhausted/ok |
| `spending_report` | `PgSpendingHandlers.getSpendingReport()` | Read-only snapshot across all agents |
| `spending_efficiency_report` | `PgSpendingHandlers.getTokenEfficiencyReport()` | Weekly or daily token efficiency (requires migration 014) |

Source: `src/apps/mcp-server/tools/spending/index.ts`; re-exported via `src/mcp/tools/spending/index.ts`.

---

## Exhaustion Race Defense

Two enforcement layers cooperate to bound the over-spend to at most one concurrent event pair:

1. **Pre-check (fast path):** `logSpending()` reads `is_frozen` before INSERT. Already-frozen agents are rejected immediately without touching the log.
2. **Post-INSERT freeze (application layer):** After a successful INSERT, `logSpending()` re-reads the daily total from `v_daily_spend`. If `total_spent_today_usd >= daily_limit_usd`, it issues:
   ```sql
   UPDATE spending_caps SET is_frozen = true, frozen_reason = 'Daily budget exhausted'
   WHERE agent_identity = $1 AND NOT COALESCE(is_frozen, false)
   ```
   and returns `{error: "budget_exhausted", ...}`.

Race bound: at most one concurrent over-limit event pair can both commit; the freeze fires after the first exceedance and blocks all subsequent calls.

Source: `src/apps/mcp-server/tools/spending/pg-handlers.ts:421–442`

---

## Currency / Unit Normalization

- All costs stored as `numeric(14,6)` USD.
- `parseFloat()` applied to all incoming string arguments before INSERT.
- Pricing conversion utilities in `pg-handlers.ts`:
  - `perMillionFromPer1k(v)` — multiplies by 1000 (per-1k → per-million)
  - `per1kFromPerMillion(v)` — divides by 1000 (per-million → per-1k)
- Token efficiency uses **microdollars** (`cost_usd × 1_000_000`) stored as integer in `metrics.token_efficiency` to avoid floating-point drift.

---

## Budget Layers (Migration 028)

Migration: `scripts/migrations/028-budget-guardrails.sql`

| Layer | Default | Table |
|-------|---------|-------|
| Per-agent daily | $10.00 | `spending_caps` |
| Per-agent monthly | $100.00 | `spending_caps` |
| Per-model allowance | $10.00 each | `budget_allowance` |
| Global circuit breaker | $100 total / $20 daily | `budget_circuit_breaker` |

Migration is idempotent (`ON CONFLICT DO NOTHING` / `ON CONFLICT DO UPDATE`). Safe to re-run.

---

## BudgetEnforcer Tool Agent

`src/core/tool-agents/budget-enforcer.ts` — a `ToolAgent` implementation that can be invoked via the tool-agent registry. It queries `spending_log` and `spending_caps` directly and freezes agents when the daily cap is exceeded. Complements the MCP handler path for non-MCP callers.

---

## Known Gaps and Deferred Work

### 1. `budget-check.ts` stubs (P842 Phase 3)

`src/shared/dispatch/budget-check.ts` contains `checkAgentBudget()` and `recordAgentSpend()` as **Phase 3 stubs** — both are no-ops pending P484 COMPLETE. Principal-based spending caps (per `principal_spending_cap` table) are not yet enforced in the `callTool` path.

### 2. E2E test / handler mismatch

`tests/e2e/mcp-spending.test.ts` expects six tools: `spending_set_cap`, `spending_log`, `spending_report`, `spending_reset`, `spending_check`, `spending_history`. The current `index.ts` registers only four tools (`spending_set_cap`, `spending_log`, `spending_report`, `spending_efficiency_report`). The three extra names (`spending_reset`, `spending_check`, `spending_history`) have no registered handlers — the e2e test for tool registration will fail. This is a pre-existing gap; the test suite targets a different (earlier) interface version.

### 3. Migration 014 optional

Token efficiency reporting (`spending_efficiency_report`) degrades gracefully with the message "Token efficiency metrics are unavailable. Apply migration 014 first." if the `metrics.token_efficiency` table / `v_weekly_efficiency` view is absent.

---

## Migration / Compatibility Boundary

| Phase | DB | Resolution |
|-------|----|------------|
| Pre-P429 | `agenthive` @ `127.0.0.1:5432`, schema `roadmap_efficiency` | `AGENTHIVE_DSN` env var |
| Post-P429 | `hiveControl` via `config.getControlPool()` | Table/schema names unchanged — no application code changes required |

---

## Rollback / Recovery

| Scenario | Action |
|----------|--------|
| Unfreeze agent | `spending_set_cap agent_identity=<id> daily_limit_usd=<n> is_frozen=false` |
| Raise daily limit | Re-call `spending_set_cap` with a higher `daily_limit_usd` |
| Remove a log entry | `DELETE FROM roadmap_efficiency.spending_log WHERE id = <id>` then unfreeze |
| Reset circuit breaker | `UPDATE roadmap_efficiency.budget_circuit_breaker SET status='armed', tripped_at=NULL, reset_at=NULL WHERE circuit_name='global-spend'` |

---

## Operator-Visible Failure Payloads

| Condition | Response shape |
|-----------|----------------|
| Budget exhausted | `{"error":"budget_exhausted","agent":"…","daily_spent_usd":N,"daily_limit_usd":N,"message":"…"}` |
| 80% warning | `{"warning":"budget_warning_80pct","pct_used":N,"remaining_usd":N,"message":"…"}` |
| Agent frozen (pre-check) | `"⚠️ <agent> is frozen: <reason>"` |
| Token efficiency unavailable | `"Token efficiency metrics are unavailable. Apply migration 014 first."` |
| Frozen status in report | Agent row ends with `🔒 FROZEN (<reason>)` |

---

## Verification Summary

| AC | Description | Status |
|----|-------------|--------|
| AC#1 | Freeze on daily limit — `is_frozen=true` after exceedance | Implemented (`pg-handlers.ts:421`) |
| AC#2 | `budget_exhausted` JSON returned after freeze | Implemented (`pg-handlers.ts:430`) |
| AC#3 | 80% warn threshold — `budget_warning_80pct` JSON | Implemented (`pg-handlers.ts:445`) |
| AC#4 | Override/unfreeze via `spending_set_cap is_frozen=false` | Implemented (`pg-handlers.ts:261`) |
| AC#5 | Currency normalization — string cost stored as `numeric(14,6)` | Implemented |
| AC#6 | Monthly spend report accuracy — derived from `spending_log` | Implemented via `v_daily_spend` + monthly CTE |
| AC#7 | Daily granularity for efficiency report | Implemented (`getTokenEfficiencyReport granularity=daily`) |
| Gap | E2E test tool-name mismatch (3 unregistered tools) | Pre-existing; not introduced by P397 |
| Gap | `budget-check.ts` principal enforcement stubs | Deferred to P842 Phase 3 / P484 |
