-- 276-p3000-quota-foundation.sql
-- P3000 (P2995-AC6): Heterogeneous per-agent cost quotas + starvation prevention.
--   *** METER-INDEPENDENT FOUNDATION LAYER ONLY ***
--
-- This migration builds the cost-INDEPENDENT foundation that does NOT require
-- the per-agent cumulative cost meter (that meter is P1018 Phase-1's job and is
-- currently unfed — the same gap that blocks P1699). Specifically:
--
--   AC-5  per-agent quota dimensions          -> columns on agent_registry
--   AC-7  fair-share DEBT tracker (cycles)     -> table fair_share_debt
--   AC-8  observability counters               -> table quota_metric_event
--
-- AC-6 (cost-based admission control) and the mixed-cost parts of AC-10 are
-- DELIBERATELY NOT built here: they need roadmap_efficiency.agent_budget_ledger
-- to expose a per-agent LIVE (completed + in-flight) cumulative spend aggregate,
-- which does not exist yet. Wiring speculative cost comparisons into the live
-- claim/dispatch chokepoint against an absent meter would be high-blast-radius.
--
-- SCHEMA REALITY (verified via \d, 2026-06-14):
--   * roadmap_workforce.agent_capacity        DOES NOT EXIST (proposal name was
--     aspirational). The canonical per-agent table is
--     roadmap_workforce.agent_registry (PK agent_identity) — quota columns land
--     THERE rather than inventing a parallel capacity table.
--   * roadmap_workforce.agency_capacity EXISTS but is per (provider,model,agency)
--     route quota, NOT per-agent — wrong grain for AC-5.
--   * Scoring tables (reliability_score) live in roadmap_workforce — so the new
--     fair_share_debt table lands in roadmap_workforce alongside them.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS only.
-- No destructive ops. NO BEGIN/COMMIT — scripts/migrate.ts wraps each file in a
-- transaction (migrate.ts:130/142); an inner BEGIN/COMMIT would break nesting.

-- ════════════════════════════════════════════════════════════════════════════
-- AC-5 — per-agent quota dimensions on roadmap_workforce.agent_registry
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE roadmap_workforce.agent_registry
	ADD COLUMN IF NOT EXISTS cost_per_token_usd   numeric(14,10),
	ADD COLUMN IF NOT EXISTS quota_usd_per_day     numeric(12,4),
	ADD COLUMN IF NOT EXISTS priority_tier         integer NOT NULL DEFAULT 3,
	ADD COLUMN IF NOT EXISTS reserved_headroom_pct numeric(5,4) NOT NULL DEFAULT 0.0;

-- CHECK constraints (added separately so they are idempotent via catalog guard:
-- ADD CONSTRAINT has no IF NOT EXISTS prior to PG16, so guard on pg_constraint).
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'agent_registry_priority_tier_check'
		  AND conrelid = 'roadmap_workforce.agent_registry'::regclass
	) THEN
		ALTER TABLE roadmap_workforce.agent_registry
			ADD CONSTRAINT agent_registry_priority_tier_check
			CHECK (priority_tier BETWEEN 1 AND 5);
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'agent_registry_reserved_headroom_pct_check'
		  AND conrelid = 'roadmap_workforce.agent_registry'::regclass
	) THEN
		ALTER TABLE roadmap_workforce.agent_registry
			ADD CONSTRAINT agent_registry_reserved_headroom_pct_check
			CHECK (reserved_headroom_pct BETWEEN 0 AND 1);
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'agent_registry_cost_per_token_usd_check'
		  AND conrelid = 'roadmap_workforce.agent_registry'::regclass
	) THEN
		ALTER TABLE roadmap_workforce.agent_registry
			ADD CONSTRAINT agent_registry_cost_per_token_usd_check
			CHECK (cost_per_token_usd IS NULL OR cost_per_token_usd >= 0);
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'agent_registry_quota_usd_per_day_check'
		  AND conrelid = 'roadmap_workforce.agent_registry'::regclass
	) THEN
		ALTER TABLE roadmap_workforce.agent_registry
			ADD CONSTRAINT agent_registry_quota_usd_per_day_check
			CHECK (quota_usd_per_day IS NULL OR quota_usd_per_day >= 0);
	END IF;
END $$;

COMMENT ON COLUMN roadmap_workforce.agent_registry.cost_per_token_usd IS
	'P3000 AC-5: blended cost per token (USD) for this agent''s route. Used by AC-6 admission control (BLOCKED on P1018 cost meter) — informational only until then.';
COMMENT ON COLUMN roadmap_workforce.agent_registry.quota_usd_per_day IS
	'P3000 AC-5: daily USD spend ceiling for this agent. NULL = unlimited. Enforced by AC-6 (BLOCKED on P1018 cost meter).';
COMMENT ON COLUMN roadmap_workforce.agent_registry.priority_tier IS
	'P3000 AC-5: fair-share priority tier 1 (highest) .. 5 (lowest). Default 3. AC-7 starvation recovery temporarily promotes a starved agent to an effective tier of -1 (reserved slot).';
COMMENT ON COLUMN roadmap_workforce.agent_registry.reserved_headroom_pct IS
	'P3000 AC-5: fraction [0,1] of this agent''s quota reserved as anti-starvation headroom.';

-- ════════════════════════════════════════════════════════════════════════════
-- AC-7 — fair-share DEBT tracker (cost-INDEPENDENT: debt counted in dispatch
--        CYCLES, not dollars — needs no cost meter)
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS roadmap_workforce.fair_share_debt (
	agent_identity         text PRIMARY KEY
		REFERENCES roadmap_workforce.agent_registry(agent_identity) ON DELETE CASCADE,
	cycles_since_dispatch  integer NOT NULL DEFAULT 0
		CHECK (cycles_since_dispatch >= 0),
	last_claimed_at        timestamp with time zone,
	-- one-shot latch: set true when a reserved-slot override is granted so the
	-- override fires exactly once per starvation episode (reset on dispatch).
	reserved_override_active boolean NOT NULL DEFAULT false,
	updated_at             timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fair_share_debt_starved
	ON roadmap_workforce.fair_share_debt (cycles_since_dispatch DESC)
	WHERE cycles_since_dispatch > 0;

COMMENT ON TABLE roadmap_workforce.fair_share_debt IS
	'P3000 AC-7: per-agent fair-share debt measured in dispatch CYCLES (cost-independent). cycles_since_dispatch increments on each offer rejection, resets to 0 on successful dispatch. When it exceeds the starvation threshold (default 10) the agent earns a one-time reserved-slot priority override (effective priority_tier -> -1).';

-- ════════════════════════════════════════════════════════════════════════════
-- AC-8 — observability counters for quota events
-- ════════════════════════════════════════════════════════════════════════════
-- Lightweight append-grain counter table (mirrors the roadmap.spawn_tool_call_counter
-- monotonic-counter pattern). Distinct metric names:
--   quota:denied_dispatch
--   quota:reserved_headroom_granted
--   quota:starvation_recovery
--   quota:window_reset

CREATE TABLE IF NOT EXISTS roadmap_workforce.quota_metric_event (
	id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	metric_name    text NOT NULL
		CHECK (metric_name IN (
			'quota:denied_dispatch',
			'quota:reserved_headroom_granted',
			'quota:starvation_recovery',
			'quota:window_reset'
		)),
	agent_identity text,
	value          integer NOT NULL DEFAULT 1 CHECK (value >= 0),
	attributes     jsonb NOT NULL DEFAULT '{}'::jsonb,
	recorded_at    timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quota_metric_event_name_time
	ON roadmap_workforce.quota_metric_event (metric_name, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_quota_metric_event_agent
	ON roadmap_workforce.quota_metric_event (agent_identity, recorded_at DESC)
	WHERE agent_identity IS NOT NULL;

COMMENT ON TABLE roadmap_workforce.quota_metric_event IS
	'P3000 AC-8: append-grain counter for quota subsystem observability. Emitted by the fair-share debt tracker decision functions (src/core/scoring/fair-share-debt.ts).';
