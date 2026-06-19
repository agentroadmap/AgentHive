-- ============================================================================
-- P1442 V3-C10: Scale-step go/no-go evidence bundle  (READ-ONLY diagnostics)
-- ----------------------------------------------------------------------------
-- Purpose:
--   Produces the per-scale-step evidence bundle required by P1442 AC-4 and AC-6
--   for a C10 rollout step: agency registry identity, OS-user/host, offer/claim/
--   run activity, artifact/run IDs, heartbeat freshness, and the failure_class /
--   circuit-breaker audit signals operators need for a go/no-go decision.
--
-- AC-5 compliance:
--   This is a NEW repository diagnostics file. It performs SELECT statements ONLY
--   (no INSERT/UPDATE/DELETE/DDL) and makes NO change to any running source code,
--   service, registration, config, or systemd unit. It is read-only observability
--   tooling, NOT a between-steps source-code change. The actual rollout steps
--   (AC-2/AC-3: provisioning OS-users and hosts, systemd registration) remain
--   operator work and are intentionally NOT automated here.
--
-- Usage:
--   psql -h 127.0.0.1 -U admin -d agenthive \
--        -v agency="'claude-bot-gary.a'" \
--        -f scripts/diagnostics/p1442-c10-scale-evidence.sql
--
--   The agency under test is parameterized via the psql variable :agency
--   (an agency_identity string from roadmap_workforce.provider_registry, e.g.
--   'claude-bot-gary.a', 'claude-bot-xiaomi.a', 'mimo-bot-xiaomi.a').
--   A default is set below so the file also runs with no -v flag.
--
--   "Recent" windows default to 24h; override with -v window="'72 hours'".
-- ============================================================================

-- Defaults so the bundle runs even without -v overrides ----------------------
\set ON_ERROR_STOP on
-- If :agency / :window are undefined (no -v flag), fall back to defaults.
\if :{?agency}
\else
  \set agency '''claude-bot-gary.a'''
\endif
\if :{?window}
\else
  \set window '''24 hours'''
\endif

\echo '============================================================'
\echo 'P1442 C10 scale-step evidence bundle'
\echo 'Agency under test :' :agency
\echo 'Recent window     :' :window
\echo '============================================================'


-- ============================================================================
-- SECTION 1 — AGENCY / PROVIDER REGISTRY IDENTITY  (AC-4: identity + host)
-- ----------------------------------------------------------------------------
-- The agency's provider-side registration: identity, FK agency_id, squad,
-- status, in-flight cap, last-seen. This is the "is this agency registered and
-- live" evidence for the step.
-- ============================================================================
\echo ''
\echo '--- [1a] provider_registry: agency registration ---'
SELECT
    pr.id                      AS provider_row_id,
    pr.agency_id,
    pr.agency_identity,
    pr.squad_name,
    pr.status                  AS provider_status,
    pr.is_active,
    pr.max_in_flight,
    pr.target_quota_pct_override,
    pr.registered_at,
    pr.last_seen_at,
    EXTRACT(EPOCH FROM now() - pr.last_seen_at)::int AS last_seen_age_s
FROM roadmap_workforce.provider_registry pr
WHERE pr.agency_identity = :agency
ORDER BY pr.last_seen_at DESC NULLS LAST;

-- Worker/member identities that resolve under this agency_id. agent_registry
-- carries host_affinity (the OS host), agent_cli, preferred_provider, and
-- last_seen — the "OS-user/host + identity" evidence AC-4 calls for.
\echo ''
\echo '--- [1b] agent_registry: worker identities under this agency (host/CLI/provider) ---'
SELECT
    ar.agent_identity,
    ar.agent_type,
    ar.role,
    ar.agency_id,
    ar.project_id,
    ar.status,
    ar.host_affinity,                  -- OS host the agent is pinned to
    ar.agent_cli,
    ar.preferred_provider,
    ar.trust_tier,
    ar.max_concurrent_claims,
    ar.last_seen_at,
    ar.reaped_at,
    ar.reap_reason
FROM roadmap_workforce.agent_registry ar
WHERE ar.agency_id = (
        SELECT agency_id FROM roadmap_workforce.provider_registry
        WHERE agency_identity = :agency
        ORDER BY last_seen_at DESC NULLS LAST LIMIT 1
      )
ORDER BY ar.reaped_at NULLS FIRST, ar.last_seen_at DESC NULLS LAST;


-- ============================================================================
-- SECTION 2 — OFFER / CLAIM / RUN ACTIVITY  (AC-4/AC-6: offer/claim/run + artifact IDs)
-- ----------------------------------------------------------------------------
-- squad_dispatch is the offer/claim ledger. agent_runs is the execution ledger
-- (artifact-bearing: output_summary, run id). Worker identity on both is the
-- agency identity (e.g. 'claude-bot-gary.a').
-- ============================================================================
\echo ''
\echo '--- [2a] squad_dispatch: offer/claim counts in window ---'
SELECT
    count(*)                                              AS offers_total,
    count(*) FILTER (WHERE claimed_at IS NOT NULL)        AS claimed,
    count(*) FILTER (WHERE dispatch_status = 'completed') AS completed,
    count(*) FILTER (WHERE offer_status = 'open')         AS still_open,
    max(id)                                               AS latest_dispatch_id,
    max(assigned_at)                                      AS latest_assigned_at,
    max(claimed_at)                                       AS latest_claimed_at
FROM roadmap_workforce.squad_dispatch
WHERE (agency_identity = :agency OR worker_identity = :agency)
  AND assigned_at > now() - (:window)::interval;

\echo ''
\echo '--- [2b] squad_dispatch: latest 10 offer/claim rows (IDs for the bundle) ---'
SELECT
    sd.id              AS dispatch_id,
    sd.proposal_id,
    sd.dispatch_role,
    sd.dispatch_status,
    sd.offer_status,
    sd.lease_id,
    sd.worker_identity,
    sd.route_provider,
    sd.assigned_at,
    sd.claimed_at,
    sd.completed_at
FROM roadmap_workforce.squad_dispatch sd
WHERE (sd.agency_identity = :agency OR sd.worker_identity = :agency)
  AND sd.assigned_at > now() - (:window)::interval
ORDER BY sd.assigned_at DESC
LIMIT 10;

\echo ''
\echo '--- [2c] agent_runs: execution counts + cost/tokens in window ---'
SELECT
    count(*)                                          AS runs_total,
    count(*) FILTER (WHERE status = 'completed')      AS completed,
    count(*) FILTER (WHERE status = 'failed')         AS failed,
    count(*) FILTER (WHERE error_detail IS NOT NULL)  AS with_error,
    round(sum(cost_usd), 4)                           AS cost_usd_total,
    sum(tokens_in)                                    AS tokens_in_total,
    sum(tokens_out)                                   AS tokens_out_total,
    max(id)                                           AS latest_run_id,
    max(started_at)                                   AS latest_started_at
FROM roadmap_workforce.agent_runs
WHERE agent_identity = :agency
  AND started_at > now() - (:window)::interval;

\echo ''
\echo '--- [2d] agent_runs: latest 10 runs (artifact/run IDs + summaries) ---'
SELECT
    r.id               AS run_id,
    r.proposal_id,
    r.display_id,
    r.stage,
    r.activity,
    r.status,
    r.model_used,
    r.resolved_provider,
    r.cost_usd,
    r.started_at,
    r.completed_at,
    left(r.output_summary, 80) AS output_summary_head
FROM roadmap_workforce.agent_runs r
WHERE r.agent_identity = :agency
  AND r.started_at > now() - (:window)::interval
ORDER BY r.started_at DESC
LIMIT 10;


-- ============================================================================
-- SECTION 3 — HEARTBEAT FRESHNESS  (AC-4: heartbeat freshness)
-- ----------------------------------------------------------------------------
-- agent_health holds the live per-identity heartbeat (status + last_heartbeat_at).
-- The orchestrator dispatch identity ('orchestrator') is the platform-liveness
-- anchor; agency worker heartbeats appear here when the worker process pulses.
-- A stale heartbeat (age above the gate) is a NO-GO signal.
-- ============================================================================
\echo ''
\echo '--- [3a] agent_health: heartbeat freshness for agency + orchestrator anchor ---'
SELECT
    h.agent_identity,
    h.status,
    h.last_heartbeat_at,
    EXTRACT(EPOCH FROM now() - h.last_heartbeat_at)::int AS heartbeat_age_s,
    CASE
        WHEN h.last_heartbeat_at > now() - interval '360 seconds' THEN 'FRESH'
        ELSE 'STALE (>360s) -> NO-GO'
    END AS freshness_gate,
    h.active_model,
    h.current_proposal,
    h.uptime_seconds
FROM roadmap_workforce.agent_health h
WHERE h.agent_identity = :agency
   OR h.agent_identity ILIKE '%' || split_part(trim(both '''' from :'agency'), '.', 1) || '%'
   OR h.agent_identity = 'orchestrator'
ORDER BY h.last_heartbeat_at DESC NULLS LAST;

\echo ''
\echo '--- [3b] agent_heartbeat_log: recent heartbeat pulses (proves liveness trend) ---'
SELECT
    hl.agent_identity,
    hl.heartbeat_at,
    hl.active_model,
    hl.cpu_percent,
    hl.memory_mb
FROM roadmap_workforce.agent_heartbeat_log hl
WHERE (hl.agent_identity = :agency
       OR hl.agent_identity ILIKE '%' || split_part(trim(both '''' from :'agency'), '.', 1) || '%'
       OR hl.agent_identity = 'orchestrator')
  AND hl.heartbeat_at > now() - (:window)::interval
ORDER BY hl.heartbeat_at DESC
LIMIT 10;


-- ============================================================================
-- SECTION 4 — FAILURE_CLASS / CIRCUIT-BREAKER SIGNAL  (AC-4/AC-6: failure audit)
-- ----------------------------------------------------------------------------
-- Three independent throttle/failure signals must all be clean for a GO:
--   (a) provider_registry throttle_count / recent_failure_count / 'throttled'
--   (b) squad_dispatch failure_class breakdown + provider-limit pauses
--   (c) roadmap_efficiency.budget_circuit_breaker global trip state
-- ============================================================================
\echo ''
\echo '--- [4a] provider_registry: throttle / failure / throttled-status signal ---'
SELECT
    pr.agency_identity,
    pr.status                                  AS provider_status,
    (pr.status = 'throttled')                  AS is_throttled,
    pr.throttle_count,
    pr.recent_failure_count,
    pr.last_failure_at,
    pr.status_reason,
    pr.alert_sent_at,
    CASE
        WHEN pr.status = 'throttled'
          OR pr.throttle_count > 0
          OR pr.recent_failure_count > 0 THEN 'INVESTIGATE'
        ELSE 'clean'
    END AS failure_gate
FROM roadmap_workforce.provider_registry pr
WHERE pr.agency_identity = :agency
ORDER BY pr.last_seen_at DESC NULLS LAST;

\echo ''
\echo '--- [4b] squad_dispatch: failure_class breakdown in window ---'
SELECT
    coalesce(failure_class, '(none)')                       AS failure_class,
    count(*)                                                AS n,
    count(*) FILTER (WHERE failure_is_transient)            AS transient,
    count(*) FILTER (WHERE paused_at_provider_limit)        AS provider_limit_paused,
    max(last_attempt_at)                                    AS latest_attempt
FROM roadmap_workforce.squad_dispatch
WHERE (agency_identity = :agency OR worker_identity = :agency)
  AND assigned_at > now() - (:window)::interval
GROUP BY coalesce(failure_class, '(none)')
ORDER BY n DESC;

\echo ''
\echo '--- [4c] budget_circuit_breaker: global circuit-breaker trip state ---'
-- 'armed' = healthy/ready; 'tripped' (tripped_at set, reset_at null) = NO-GO.
SELECT
    circuit_name,
    status,
    tripped_by,
    anomaly_reason,
    tripped_at,
    reset_at,
    CASE
        WHEN status <> 'armed' OR (tripped_at IS NOT NULL AND reset_at IS NULL)
        THEN 'TRIPPED -> NO-GO'
        ELSE 'armed (ok)'
    END AS breaker_gate
FROM roadmap_efficiency.budget_circuit_breaker
ORDER BY updated_at DESC;


-- ============================================================================
-- SECTION 5 — GO / NO-GO ROLLUP  (one-line operator verdict inputs)
-- ----------------------------------------------------------------------------
-- Convenience rollup: each cell is a gate input. Operator reads this last.
-- ============================================================================
\echo ''
\echo '--- [5] go/no-go rollup ---'
SELECT
    :agency AS agency,
    (SELECT count(*) FROM roadmap_workforce.provider_registry
       WHERE agency_identity = :agency AND status = 'active' AND is_active) AS active_provider_rows,
    (SELECT count(*) FROM roadmap_workforce.agent_registry ar
       WHERE ar.agency_id = (SELECT agency_id FROM roadmap_workforce.provider_registry
                             WHERE agency_identity = :agency
                             ORDER BY last_seen_at DESC NULLS LAST LIMIT 1)
         AND ar.reaped_at IS NULL)                                          AS live_worker_rows,
    (SELECT count(*) FROM roadmap_workforce.agent_runs
       WHERE agent_identity = :agency
         AND started_at > now() - (:window)::interval)                      AS runs_in_window,
    (SELECT max(EXTRACT(EPOCH FROM now() - last_heartbeat_at)::int)
       FROM roadmap_workforce.agent_health
       WHERE agent_identity = 'orchestrator')                              AS orchestrator_hb_age_s,
    (SELECT coalesce(max(throttle_count),0) FROM roadmap_workforce.provider_registry
       WHERE agency_identity = :agency)                                     AS throttle_count,
    (SELECT count(*) FROM roadmap_efficiency.budget_circuit_breaker
       WHERE status <> 'armed' OR (tripped_at IS NOT NULL AND reset_at IS NULL)) AS breakers_tripped;

\echo ''
\echo '=== end of P1442 C10 evidence bundle ==='
