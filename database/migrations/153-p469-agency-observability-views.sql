-- Migration 153: P469 — Liaison and agency observability surface
--
-- Creates:
--   roadmap.v_agency_dashboard            — per-agency status, capacity, in-flight,
--                                            assistance, and recent-message rollup
--   roadmap.v_liaison_protocol_health     — 15-min protocol metrics per agency
--   roadmap.v_assistance_open             — open assistance requests with age + severity
--   roadmap.agency_observability_alert_state — dedup state for Discord alerting
--
-- Depends on:
--   roadmap.agency                        (046)
--   roadmap.assistance_request            (048)
--   roadmap.liaison_message               (057)
--   roadmap.agency_capacity_config        (132)
--   roadmap_workforce.squad_dispatch      (pre-existing)
--   roadmap_workforce.v_agency_in_flight  (pre-existing)
--   roadmap_workforce.agent_registry      (pre-existing)
--   roadmap_workforce.provider_registry   (pre-existing)
--   roadmap.proposal                      (pre-existing)

BEGIN;

-- ── Alert dedup state table ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap.agency_observability_alert_state (
  alert_key     text        NOT NULL PRIMARY KEY,
  agency_id     text        NOT NULL,
  alert_type    text        NOT NULL,
  last_fired_at timestamptz NOT NULL DEFAULT now(),
  cleared_at    timestamptz,
  metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE roadmap.agency_observability_alert_state IS
  'P469: deduplication state for agency observability Discord alerts. '
  'alert_key = "<alert_type>:<agency_id>". last_fired_at throttles re-fires to '
  'at most once per 10 minutes per condition per agency.';

-- ── v_assistance_open ─────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW roadmap.v_assistance_open AS
  SELECT id,
         briefing_id,
         task_id,
         agency_id,
         agent_identity,
         error_signature,
         opened_at,
         EXTRACT(epoch FROM now() - opened_at) / 60::numeric AS age_minutes,
         payload ->> 'blocker_severity' AS severity,
         NULLIF(payload ->> 'proposal_id', '')  AS proposal_id,
         NULLIF(payload ->> 'route_provider', '') AS route_provider,
         payload
    FROM roadmap.assistance_request r
   WHERE status = 'open'
   ORDER BY opened_at;

COMMENT ON VIEW roadmap.v_assistance_open IS
  'P469: live open assistance requests with computed age_minutes, severity '
  'and denormalised proposal_id / route_provider from the payload jsonb.';

-- ── v_liaison_protocol_health ─────────────────────────────────────────────────

CREATE OR REPLACE VIEW roadmap.v_liaison_protocol_health AS
  WITH recent AS (
    SELECT *
      FROM roadmap.liaison_message
     WHERE signed_at > now() - interval '15 minutes'
  ),
  ping_pairs AS (
    SELECT p.agency_id,
           EXTRACT(epoch FROM min(q.signed_at) - p.signed_at) AS rtt_seconds,
           p.signed_at
      FROM recent p
      JOIN recent q ON q.agency_id       = p.agency_id
                   AND q.kind            = 'protocol_pong'
                   AND q.correlation_id  = p.correlation_id
                   AND q.signed_at      >= p.signed_at
     WHERE p.kind = 'protocol_ping'
     GROUP BY p.agency_id, p.message_id, p.signed_at
  )
  SELECT r.agency_id,
         count(*) FILTER (WHERE r.acked_at IS NULL
                            AND r.signed_at < now() - interval '1 minute')  AS unacked_old,
         count(*) FILTER (WHERE r.ack_outcome = 'reject')                   AS recent_rejects,
         (SELECT pp.rtt_seconds
            FROM ping_pairs pp
           WHERE pp.agency_id = r.agency_id
           ORDER BY pp.signed_at DESC
           LIMIT 1)                                                          AS last_ping_rtt,
         max(r.sequence)                                                     AS latest_sequence,
         GREATEST(
           max(r.sequence) - min(r.sequence) + 1 - count(DISTINCT r.sequence),
           0
         )                                                                   AS sequence_gaps,
         count(*) FILTER (WHERE r.ack_outcome = 'reject'
                            AND COALESCE(r.ack_error, '') ILIKE '%replay%') AS replay_rejects,
         COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'message_id',    r.message_id,
               'kind',          r.kind,
               'direction',     r.direction,
               'sequence',      r.sequence,
               'signed_at',     r.signed_at,
               'acked_at',      r.acked_at,
               'ack_outcome',   r.ack_outcome,
               'ack_error',     r.ack_error,
               'proposal_id',   NULLIF(r.payload ->> 'proposal_id', ''),
               'route_provider', NULLIF(r.payload ->> 'route_provider', '')
             )
             ORDER BY r.signed_at DESC
           ),
           '[]'::jsonb
         )                                                                   AS recent_messages
    FROM recent r
   GROUP BY r.agency_id;

COMMENT ON VIEW roadmap.v_liaison_protocol_health IS
  'P469: 15-minute protocol health window per agency — unacked messages older '
  'than 1 minute, reject counts, last ping RTT, sequence gaps, and replay rejects.';

-- ── v_agency_dashboard ────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW roadmap.v_agency_dashboard AS
  WITH active_dispatch AS (
    -- in-flight dispatches keyed on agency identity
    SELECT COALESCE(NULLIF(sd.agency_identity, ''), sd.agent_identity) AS agency_id,
           count(*) FILTER (
             WHERE lower(COALESCE(sd.offer_status, '')) = ANY (ARRAY['claimed','active'])
                OR lower(COALESCE(sd.dispatch_status, '')) = ANY (ARRAY['assigned','active','blocked'])
           )                                                    AS in_flight_claims,
           COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'id',               sd.id,
                 'dispatch_id',      sd.id,
                 'proposal_id',      sd.proposal_id,
                 'proposal_display_id', p.display_id,
                 'proposal_title',   p.title,
                 'role',             sd.dispatch_role,
                 'dispatch_status',  sd.dispatch_status,
                 'offer_status',     sd.offer_status,
                 'worker_identity',  sd.worker_identity,
                 'route_provider',   sd.route_provider,
                 'assigned_at',      sd.assigned_at,
                 'claimed_at',       sd.claimed_at,
                 'claim_expires_at', sd.claim_expires_at,
                 'metadata',         COALESCE(sd.metadata, '{}'::jsonb)
               )
               ORDER BY sd.assigned_at DESC NULLS LAST, sd.id DESC
             ) FILTER (
               WHERE lower(COALESCE(sd.offer_status, '')) = ANY (ARRAY['claimed','active'])
                  OR lower(COALESCE(sd.dispatch_status, '')) = ANY (ARRAY['assigned','active','blocked'])
             ),
             '[]'::jsonb
           )                                                    AS active_claims,
           array_remove(array_agg(DISTINCT sd.route_provider), NULL) AS route_providers
      FROM roadmap_workforce.squad_dispatch sd
      LEFT JOIN roadmap.proposal p ON p.id = sd.proposal_id
     GROUP BY COALESCE(NULLIF(sd.agency_identity, ''), sd.agent_identity)
  ),
  provider_capacity AS (
    -- max_in_flight and in-flight count from the workforce provider registry
    SELECT ar.agent_identity                              AS agency_id,
           max(pr.max_in_flight)                         AS max_in_flight,
           COALESCE(sum(inf.in_flight_count), 0)         AS provider_in_flight,
           array_remove(array_agg(DISTINCT pr.status), NULL)       AS provider_statuses,
           array_remove(array_agg(DISTINCT pr.project_id), NULL)   AS project_ids
      FROM roadmap_workforce.provider_registry pr
      JOIN roadmap_workforce.agent_registry    ar  ON ar.id = pr.agency_id
      LEFT JOIN roadmap_workforce.v_agency_in_flight inf ON inf.provider_registry_id = pr.id
     GROUP BY ar.agent_identity
  ),
  open_assistance AS (
    SELECT r.agency_id,
           count(*)         AS open_assistance,
           min(r.opened_at) AS oldest_open_assistance_at,
           COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'id',              r.id,
                 'briefing_id',     r.briefing_id,
                 'task_id',         r.task_id,
                 'agent_identity',  r.agent_identity,
                 'error_signature', r.error_signature,
                 'opened_at',       r.opened_at,
                 'age_minutes',     round(EXTRACT(epoch FROM now() - r.opened_at) / 60, 1),
                 'severity',        r.payload ->> 'blocker_severity',
                 'payload',         r.payload
               )
               ORDER BY r.opened_at
             ),
             '[]'::jsonb
           )                AS assistance_requests,
           array_remove(array_agg(DISTINCT r.payload ->> 'blocker_severity'), NULL) AS severities
      FROM roadmap.assistance_request r
     WHERE r.status = 'open'
     GROUP BY r.agency_id
  ),
  recent_messages AS (
    SELECT lm.agency_id,
           COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'message_id',    lm.message_id,
                 'kind',          lm.kind,
                 'direction',     lm.direction,
                 'sequence',      lm.sequence,
                 'signed_at',     lm.signed_at,
                 'acked_at',      lm.acked_at,
                 'ack_outcome',   lm.ack_outcome,
                 'ack_error',     lm.ack_error,
                 'proposal_id',   NULLIF(lm.payload ->> 'proposal_id', ''),
                 'route_provider', NULLIF(lm.payload ->> 'route_provider', '')
               )
               ORDER BY lm.signed_at DESC
             ) FILTER (WHERE lm.message_id IS NOT NULL),
             '[]'::jsonb
           ) AS recent_messages
      FROM (
        SELECT *
          FROM roadmap.liaison_message
         WHERE signed_at > now() - interval '15 minutes'
         ORDER BY signed_at DESC
      ) lm
     GROUP BY lm.agency_id
  )
  SELECT a.agency_id,
         a.display_name,
         a.provider,
         a.host_id,
         a.status,
         a.last_heartbeat_at,
         EXTRACT(epoch FROM now() - a.last_heartbeat_at)              AS silence_seconds,
         COALESCE(
           cc.windows,
           (a.metadata -> 'capacity_envelope') -> 'windows',
           '[]'::jsonb
         )                                                            AS capacity_windows,
         COALESCE(
           ad.in_flight_claims::numeric,
           pc.provider_in_flight,
           0
         )::bigint                                                    AS in_flight_claims,
         COALESCE(oa.open_assistance, 0)                             AS open_assistance,
         oa.oldest_open_assistance_at,
         COALESCE(
           pc.max_in_flight,
           NULLIF((a.metadata -> 'capacity_envelope') ->> 'max_in_flight', '')::integer
         )                                                            AS max_in_flight,
         COALESCE(
           NULLIF((a.metadata -> 'capacity_envelope') ->> 'free_claim_slots', '')::integer,
           GREATEST(
             COALESCE(pc.max_in_flight, 0)
             - COALESCE(ad.in_flight_claims::numeric, pc.provider_in_flight, 0)::integer,
             0
           )
         )                                                            AS free_claim_slots,
         COALESCE(ad.active_claims,       '[]'::jsonb)               AS active_claims,
         COALESCE(oa.assistance_requests, '[]'::jsonb)               AS assistance_requests,
         COALESCE(rm.recent_messages,     '[]'::jsonb)               AS recent_messages,
         COALESCE(ad.route_providers,     ARRAY[]::text[])           AS route_providers,
         COALESCE(oa.severities,          ARRAY[]::text[])           AS severities,
         COALESCE(pc.provider_statuses,   ARRAY[]::text[])           AS provider_statuses,
         COALESCE(pc.project_ids,         ARRAY[]::bigint[])         AS project_ids
    FROM roadmap.agency a
    LEFT JOIN roadmap.agency_capacity_config cc ON cc.agency_id = a.agency_id
    LEFT JOIN active_dispatch   ad ON ad.agency_id = a.agency_id
    LEFT JOIN provider_capacity pc ON pc.agency_id = a.agency_id
    LEFT JOIN open_assistance   oa ON oa.agency_id = a.agency_id
    LEFT JOIN recent_messages   rm ON rm.agency_id = a.agency_id
   WHERE a.status <> 'retired';

COMMENT ON VIEW roadmap.v_agency_dashboard IS
  'P469: operator-facing agency dashboard rollup. Per-agency: status, heartbeat, '
  'silence_seconds, capacity_windows, in_flight_claims, open_assistance + oldest, '
  'active_claims (jsonb array), assistance_requests (jsonb array), recent_messages '
  '(15-min window), route_providers, severities. Excludes retired agencies.';

COMMIT;
