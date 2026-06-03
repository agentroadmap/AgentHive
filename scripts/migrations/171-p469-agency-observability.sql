-- P469: agency and liaison observability surfaces.
--
-- Refreshes the three operator-facing views against the current
-- roadmap/roadmap_workforce tables. Extra JSON fields are intentionally added
-- for filtering and drill-down without changing the required AC columns.

DROP VIEW IF EXISTS roadmap.v_agency_dashboard;
DROP VIEW IF EXISTS roadmap.v_liaison_protocol_health;
DROP VIEW IF EXISTS roadmap.v_assistance_open;

CREATE OR REPLACE VIEW roadmap.v_agency_dashboard AS
WITH active_dispatch AS (
  SELECT
    COALESCE(NULLIF(sd.agency_identity, ''), sd.agent_identity) AS agency_id,
    COUNT(*) FILTER (
      WHERE lower(COALESCE(sd.offer_status, '')) IN ('claimed', 'active')
         OR lower(COALESCE(sd.dispatch_status, '')) IN ('assigned', 'active', 'blocked')
    ) AS in_flight_claims,
    COALESCE(jsonb_agg(
      jsonb_build_object(
        'id', sd.id,
        'dispatch_id', sd.id,
        'proposal_id', sd.proposal_id,
        'proposal_display_id', p.display_id,
        'proposal_title', p.title,
        'role', sd.dispatch_role,
        'dispatch_status', sd.dispatch_status,
        'offer_status', sd.offer_status,
        'worker_identity', sd.worker_identity,
        'route_provider', sd.route_provider,
        'assigned_at', sd.assigned_at,
        'claimed_at', sd.claimed_at,
        'claim_expires_at', sd.claim_expires_at,
        'metadata', COALESCE(sd.metadata, '{}'::jsonb)
      )
      ORDER BY sd.assigned_at DESC NULLS LAST, sd.id DESC
    ) FILTER (
      WHERE lower(COALESCE(sd.offer_status, '')) IN ('claimed', 'active')
         OR lower(COALESCE(sd.dispatch_status, '')) IN ('assigned', 'active', 'blocked')
    ), '[]'::jsonb) AS active_claims,
    array_remove(array_agg(DISTINCT sd.route_provider), NULL) AS route_providers
  FROM roadmap_workforce.squad_dispatch sd
  LEFT JOIN roadmap_proposal.proposal p ON p.id = sd.proposal_id
  GROUP BY COALESCE(NULLIF(sd.agency_identity, ''), sd.agent_identity)
),
provider_capacity AS (
  SELECT
    ar.agent_identity AS agency_id,
    MAX(pr.max_in_flight) AS max_in_flight,
    COALESCE(SUM(inf.in_flight_count), 0) AS provider_in_flight,
    array_remove(array_agg(DISTINCT pr.status), NULL) AS provider_statuses,
    array_remove(array_agg(DISTINCT pr.project_id), NULL) AS project_ids
  FROM roadmap_workforce.provider_registry pr
  JOIN roadmap_workforce.agent_registry ar ON ar.id = pr.agency_id
  LEFT JOIN roadmap_workforce.v_agency_in_flight inf
    ON inf.provider_registry_id = pr.id
  GROUP BY ar.agent_identity
),
open_assistance AS (
  SELECT
    r.agency_id,
    COUNT(*) AS open_assistance,
    MIN(r.opened_at) AS oldest_open_assistance_at,
    COALESCE(jsonb_agg(
      jsonb_build_object(
        'id', r.id,
        'briefing_id', r.briefing_id,
        'task_id', r.task_id,
        'agent_identity', r.agent_identity,
        'error_signature', r.error_signature,
        'opened_at', r.opened_at,
        'age_minutes', round(EXTRACT(EPOCH FROM (now() - r.opened_at)) / 60, 1),
        'severity', r.payload->>'blocker_severity',
        'payload', r.payload
      )
      ORDER BY r.opened_at
    ), '[]'::jsonb) AS assistance_requests,
    array_remove(array_agg(DISTINCT r.payload->>'blocker_severity'), NULL) AS severities
  FROM roadmap.assistance_request r
  WHERE r.status = 'open'
  GROUP BY r.agency_id
),
recent_messages AS (
  SELECT
    lm.agency_id,
    COALESCE(jsonb_agg(
      jsonb_build_object(
        'message_id', lm.message_id,
        'kind', lm.kind,
        'direction', lm.direction,
        'sequence', lm.sequence,
        'signed_at', lm.signed_at,
        'acked_at', lm.acked_at,
        'ack_outcome', lm.ack_outcome,
        'ack_error', lm.ack_error,
        'proposal_id', NULLIF(lm.payload->>'proposal_id', ''),
        'route_provider', NULLIF(lm.payload->>'route_provider', '')
      )
      ORDER BY lm.signed_at DESC
    ) FILTER (WHERE lm.message_id IS NOT NULL), '[]'::jsonb) AS recent_messages
  FROM (
    SELECT *
    FROM roadmap.liaison_message
    WHERE signed_at > now() - interval '15 minutes'
    ORDER BY signed_at DESC
  ) lm
  GROUP BY lm.agency_id
)
SELECT
  a.agency_id,
  a.display_name,
  a.provider,
  a.host_id,
  a.status,
  a.last_heartbeat_at,
  EXTRACT(EPOCH FROM (now() - a.last_heartbeat_at)) AS silence_seconds,
  COALESCE(cc.windows, a.metadata->'capacity_envelope'->'windows', '[]'::jsonb) AS capacity_windows,
  COALESCE(ad.in_flight_claims, pc.provider_in_flight, 0)::bigint AS in_flight_claims,
  COALESCE(oa.open_assistance, 0)::bigint AS open_assistance,
  oa.oldest_open_assistance_at,
  COALESCE(pc.max_in_flight, NULLIF(a.metadata->'capacity_envelope'->>'max_in_flight', '')::int) AS max_in_flight,
  COALESCE(NULLIF(a.metadata->'capacity_envelope'->>'free_claim_slots', '')::int,
           GREATEST(COALESCE(pc.max_in_flight, 0) - COALESCE(ad.in_flight_claims, pc.provider_in_flight, 0)::int, 0)) AS free_claim_slots,
  COALESCE(ad.active_claims, '[]'::jsonb) AS active_claims,
  COALESCE(oa.assistance_requests, '[]'::jsonb) AS assistance_requests,
  COALESCE(rm.recent_messages, '[]'::jsonb) AS recent_messages,
  COALESCE(ad.route_providers, ARRAY[]::text[]) AS route_providers,
  COALESCE(oa.severities, ARRAY[]::text[]) AS severities,
  COALESCE(pc.provider_statuses, ARRAY[]::text[]) AS provider_statuses,
  COALESCE(pc.project_ids, ARRAY[]::bigint[]) AS project_ids
FROM roadmap.agency a
LEFT JOIN roadmap.agency_capacity_config cc ON cc.agency_id = a.agency_id
LEFT JOIN active_dispatch ad ON ad.agency_id = a.agency_id
LEFT JOIN provider_capacity pc ON pc.agency_id = a.agency_id
LEFT JOIN open_assistance oa ON oa.agency_id = a.agency_id
LEFT JOIN recent_messages rm ON rm.agency_id = a.agency_id
WHERE a.status <> 'retired';

CREATE OR REPLACE VIEW roadmap.v_liaison_protocol_health AS
WITH recent AS (
  SELECT *
  FROM roadmap.liaison_message
  WHERE signed_at > now() - interval '15 minutes'
),
ping_pairs AS (
  SELECT
    p.agency_id,
    EXTRACT(EPOCH FROM (MIN(q.signed_at) - p.signed_at)) AS rtt_seconds,
    p.signed_at
  FROM recent p
  JOIN recent q
    ON q.agency_id = p.agency_id
   AND q.kind = 'protocol_pong'
   AND q.correlation_id = p.correlation_id
   AND q.signed_at >= p.signed_at
  WHERE p.kind = 'protocol_ping'
  GROUP BY p.agency_id, p.message_id, p.signed_at
)
SELECT
  r.agency_id,
  COUNT(*) FILTER (WHERE r.acked_at IS NULL AND r.signed_at < now() - interval '60 seconds') AS unacked_old,
  COUNT(*) FILTER (WHERE r.ack_outcome = 'reject') AS recent_rejects,
  (SELECT pp.rtt_seconds FROM ping_pairs pp WHERE pp.agency_id = r.agency_id ORDER BY pp.signed_at DESC LIMIT 1) AS last_ping_rtt,
  MAX(r.sequence) AS latest_sequence,
  GREATEST(MAX(r.sequence) - MIN(r.sequence) + 1 - COUNT(DISTINCT r.sequence), 0) AS sequence_gaps,
  COUNT(*) FILTER (WHERE r.ack_outcome = 'reject' AND COALESCE(r.ack_error, '') ILIKE '%replay%') AS replay_rejects,
  COALESCE(jsonb_agg(
    jsonb_build_object(
      'message_id', r.message_id,
      'kind', r.kind,
      'direction', r.direction,
      'sequence', r.sequence,
      'signed_at', r.signed_at,
      'acked_at', r.acked_at,
      'ack_outcome', r.ack_outcome,
      'ack_error', r.ack_error,
      'proposal_id', NULLIF(r.payload->>'proposal_id', ''),
      'route_provider', NULLIF(r.payload->>'route_provider', '')
    )
    ORDER BY r.signed_at DESC
  ), '[]'::jsonb) AS recent_messages
FROM recent r
GROUP BY r.agency_id;

CREATE OR REPLACE VIEW roadmap.v_assistance_open AS
SELECT
  r.id,
  r.briefing_id,
  r.task_id,
  r.agency_id,
  r.agent_identity,
  r.error_signature,
  r.opened_at,
  EXTRACT(EPOCH FROM (now() - r.opened_at)) / 60 AS age_minutes,
  r.payload->>'blocker_severity' AS severity,
  NULLIF(r.payload->>'proposal_id', '') AS proposal_id,
  NULLIF(r.payload->>'route_provider', '') AS route_provider,
  r.payload
FROM roadmap.assistance_request r
WHERE r.status = 'open'
ORDER BY r.opened_at;

CREATE TABLE IF NOT EXISTS roadmap.agency_observability_alert_state (
  alert_key text PRIMARY KEY,
  agency_id text NOT NULL,
  alert_type text NOT NULL,
  last_fired_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON VIEW roadmap.v_agency_dashboard IS
  'P469 operator agency snapshot: status, capacity, active dispatches, assistance requests, and recent liaison messages.';
COMMENT ON VIEW roadmap.v_liaison_protocol_health IS
  'P469 per-agency liaison protocol health over the last 15 minutes.';
COMMENT ON VIEW roadmap.v_assistance_open IS
  'P469 open assistance requests ordered by age with severity and filter metadata.';
