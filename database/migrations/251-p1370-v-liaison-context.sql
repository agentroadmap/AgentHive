-- P1370: Liaison Runtime Context — provider constraints + token budget + coordinator knowledge
--
-- PURPOSE:
--   Create a view (v_liaison_context) that aggregates provider constraints, token budget state,
--   and coordinator knowledge for each agency's liaison at boot. The liaison uses this to
--   short-circuit doomed dispatches, queue work intelligently, and reject offers that exceed
--   its capacity.
--
-- DESIGN RATIONALE:
--   - Liaison needs structured context: tier/rate limits, spending vs daily/weekly cap,
--     capability restrictions, throttle/quota state, routing knowledge
--   - Exists as a single view + TS hydration function for three-query assembly (view + peers + paused roles)
--   - View is the per-agency snapshot; peers and paused-roles are loaded separately by TS
--
-- PREREQUISITES:
--   - P1365 migration creating roadmap_workforce.agency_capacity MUST run before this one
--   - The DO block below enforces this with an explicit RAISE EXCEPTION
--
-- IMPLEMENTATION:
--   AC-1: Migration file numbered after latest in database/migrations/
--   AC-2: Migration begins with DO $$...END$$; dependency check
--   AC-3: active_claim_count filter uses only in-flight dispatch_status values
--   AC-4: View performance: EXPLAIN ANALYZE evidence after seeding test data
--   (Remaining ACs are TypeScript/integration level)

BEGIN;

-- Dependency check: fail loudly if agency_capacity doesn't exist yet
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='roadmap_workforce' AND table_name='agency_capacity'
  ) THEN
    RAISE EXCEPTION
      'P1370 migration requires roadmap_workforce.agency_capacity (provided by P1365). Run P1365 migration first.';
  END IF;
END $$;

-- Create v_liaison_context view: per-agency snapshot with provider/capacity/budget/peers context
-- Column definitions match AC-1: all referenced table/column pairs verified against live schema
CREATE OR REPLACE VIEW roadmap_workforce.v_liaison_context AS
SELECT
  -- Self-identity (from agent_registry)
  ar.agent_identity,
  ar.agency_style,
  ar.llm_variant,
  ar.preferred_provider                        AS provider,
  COALESCE(NULLIF(ar.host_affinity, ''), 'bot') AS host_id,
  ar.project_id,
  ar.max_concurrent_claims,

  -- Capabilities (from agent_capability, aggregated)
  ARRAY(
    SELECT DISTINCT ac.capability
    FROM roadmap_workforce.agent_capability ac
    WHERE ac.agent_id = ar.id
    ORDER BY ac.capability
  ) AS capabilities,

  -- Agency presence and heartbeat (from roadmap.agency)
  ag.presence_state,
  ag.last_heartbeat_at,

  -- Provider health / throttle state (from roadmap.provider_health)
  ph.cooldown_until                           AS provider_cooldown_until,

  -- Capacity envelope (from roadmap_workforce.agency_capacity, latest row per agency)
  ac_cap.requests_remaining,
  ac_cap.tokens_remaining,
  ac_cap.reset_at                             AS capacity_reset_at,
  ac_cap.throttle_action,
  ac_cap.last_sampled_at                      AS capacity_last_sampled_at,

  -- Spending / budget (from roadmap.agent_budget_ledger, aggregated)
  COALESCE(sp.spent_today_usd, 0)::numeric   AS spent_today_usd,
  COALESCE(sp.spent_week_usd, 0)::numeric    AS spent_week_usd,
  COALESCE(sp.cumulative_usd, 0)::numeric    AS cumulative_usd,
  sp.daily_cap_usd,

  -- In-flight claim count (from roadmap_workforce.squad_dispatch, filtered by in-flight status)
  -- AC-3: uses only in-flight dispatch_status values from the check constraint.
  -- Project-scoped per AC-3.
  COALESCE(
    (SELECT COUNT(*) FROM roadmap_workforce.squad_dispatch sd
      WHERE (sd.worker_identity = ar.agent_identity
             OR sd.agent_identity = ar.agent_identity)
        AND sd.dispatch_status IN (
          'assigned','active','blocked','posted','claimed','running','retry_wait'
        )
        AND sd.project_id = ar.project_id),
    0
  ) AS active_claim_count

FROM roadmap_workforce.agent_registry ar

-- Join agency for presence state and heartbeat
LEFT JOIN roadmap.agency ag
  ON ag.display_name = ar.agent_identity

-- Join provider_health for cooldown state (keyed on provider_name, corrected from provider)
LEFT JOIN roadmap.provider_health ph
  ON ph.provider_name = ar.preferred_provider

-- Lateral join: latest agency_capacity row per agency
LEFT JOIN LATERAL (
  SELECT requests_remaining, tokens_remaining, reset_at, throttle_action, last_sampled_at
  FROM roadmap_workforce.agency_capacity ac
  WHERE ac.agency_id = ar.agent_identity
  ORDER BY ac.last_sampled_at DESC LIMIT 1
) ac_cap ON true

-- Lateral join: aggregate spending from agent_budget_ledger
LEFT JOIN LATERAL (
  SELECT
    SUM(cost_usd) FILTER (WHERE recorded_at::date = CURRENT_DATE) AS spent_today_usd,
    SUM(cost_usd) FILTER (WHERE recorded_at > NOW() - INTERVAL '7 days') AS spent_week_usd,
    MAX(cumulative_cost_usd) AS cumulative_usd,
    MAX(budget_allocated_usd) AS daily_cap_usd
  FROM roadmap.agent_budget_ledger
  WHERE agent_identity = ar.agent_identity
) sp ON true

WHERE ar.agent_type IN ('agency', 'alias') AND ar.status = 'active';

COMMIT;
