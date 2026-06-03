-- P469: Agency and liaison observability surfaces.
--
-- Adds read views used by dashboard-web and TUI operators plus a throttled
-- alert function that emits Discord bridge notifications for stale agencies
-- and old assistance requests.

BEGIN;

ALTER TABLE roadmap.agency_capacity_config
    ADD COLUMN IF NOT EXISTS windows jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS roadmap.agency_observability_alert (
    alert_key     text PRIMARY KEY,
    agency_id     text NOT NULL REFERENCES roadmap.agency(agency_id) ON DELETE CASCADE,
    alert_type    text NOT NULL,
    last_sent_at  timestamptz NOT NULL DEFAULT now(),
    payload       jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_agency_observability_alert_agency
    ON roadmap.agency_observability_alert (agency_id, last_sent_at DESC);

CREATE TABLE IF NOT EXISTS roadmap.agency_observability_alert_state (
    alert_key     text PRIMARY KEY,
    agency_id     text NOT NULL REFERENCES roadmap.agency(agency_id) ON DELETE CASCADE,
    alert_type    text NOT NULL,
    last_fired_at timestamptz NOT NULL DEFAULT now(),
    cleared_at    timestamptz,
    metadata      jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_agency_observability_alert_state_agency
    ON roadmap.agency_observability_alert_state (agency_id, last_fired_at DESC);

DROP VIEW IF EXISTS roadmap.v_agency_dashboard;
DROP VIEW IF EXISTS roadmap.v_liaison_protocol_health;
DROP VIEW IF EXISTS roadmap.v_assistance_open;

CREATE OR REPLACE VIEW roadmap.v_agency_dashboard AS
WITH active_claims AS (
    SELECT
        d.agency_identity AS agency_id,
        COUNT(*)::int AS in_flight_claims,
        jsonb_agg(
            jsonb_build_object(
                'id', d.id,
                'proposal_id', d.proposal_id,
                'proposal_display_id', p.display_id,
                'role', d.dispatch_role,
                'worker_identity', d.worker_identity,
                'agent_identity', d.agent_identity,
                'route_provider', d.route_provider,
                'dispatch_status', d.dispatch_status,
                'offer_status', d.offer_status,
                'assigned_at', d.assigned_at,
                'claimed_at', d.claimed_at,
                'claim_expires_at', d.claim_expires_at,
                'metadata', d.metadata
            )
            ORDER BY d.assigned_at DESC NULLS LAST, d.id DESC
        ) AS claims,
        array_agg(DISTINCT d.proposal_id) FILTER (WHERE d.proposal_id IS NOT NULL) AS proposal_ids,
        array_agg(DISTINCT d.route_provider) FILTER (WHERE d.route_provider IS NOT NULL) AS route_providers
    FROM roadmap_workforce.squad_dispatch d
    LEFT JOIN roadmap_proposal.proposal p ON p.id = d.proposal_id
    WHERE COALESCE(d.agency_identity, '') <> ''
      AND d.completed_at IS NULL
      AND COALESCE(d.offer_status, '') NOT IN ('delivered', 'failed', 'expired', 'cancelled')
      AND COALESCE(d.dispatch_status, '') NOT IN ('completed', 'failed', 'cancelled')
    GROUP BY d.agency_identity
),
open_assistance AS (
    SELECT
        r.agency_id,
        COUNT(*)::int AS open_assistance,
        MIN(r.opened_at) AS oldest_open_assistance_at,
        COUNT(*) FILTER (
            WHERE COALESCE(r.payload->>'blocker_severity', '') IN ('high', 'critical', 'severe')
        )::int AS stuck_escalations,
        array_agg(DISTINCT r.payload->>'blocker_severity')
            FILTER (WHERE r.payload ? 'blocker_severity') AS severities
    FROM roadmap.assistance_request r
    WHERE r.status = 'open'
    GROUP BY r.agency_id
),
recent_messages AS (
    SELECT
        lm.agency_id,
        COUNT(*) FILTER (WHERE lm.ack_outcome = 'reject')::int AS recent_refusals,
        jsonb_agg(
            jsonb_build_object(
                'message_id', lm.message_id,
                'kind', lm.kind,
                'direction', lm.direction,
                'sequence', lm.sequence,
                'ack_outcome', lm.ack_outcome,
                'signed_at', lm.signed_at,
                'payload', lm.payload
            )
            ORDER BY lm.signed_at DESC
        ) FILTER (WHERE lm.signed_at > now() - interval '15 minutes') AS recent_messages
    FROM roadmap.liaison_message lm
    WHERE lm.signed_at > now() - interval '15 minutes'
    GROUP BY lm.agency_id
)
SELECT
    a.agency_id,
    a.display_name,
    a.provider,
    a.host_id,
    a.status,
    a.last_heartbeat_at,
    EXTRACT(EPOCH FROM (now() - a.last_heartbeat_at))::numeric AS silence_seconds,
    COALESCE(cc.windows, a.metadata->'capacity_envelope'->'windows', '[]'::jsonb) AS capacity_windows,
    COALESCE(ac.in_flight_claims, 0) AS in_flight_claims,
    COALESCE(oa.open_assistance, 0) AS open_assistance,
    oa.oldest_open_assistance_at,
    COALESCE(oa.stuck_escalations, 0) AS stuck_escalations,
    COALESCE(rm.recent_refusals, 0) AS recent_refusals,
    COALESCE(ac.claims, '[]'::jsonb) AS active_claims,
    COALESCE(rm.recent_messages, '[]'::jsonb) AS recent_messages,
    COALESCE(ac.proposal_ids, ARRAY[]::bigint[]) AS proposal_ids,
    COALESCE(ac.route_providers, ARRAY[]::text[]) AS route_providers,
    COALESCE(oa.severities, ARRAY[]::text[]) AS severities,
    CASE
        WHEN (a.metadata->'capacity_envelope'->>'free_claim_slots') ~ '^[0-9]+$'
            THEN (a.metadata->'capacity_envelope'->>'free_claim_slots')::int
        ELSE 0
    END AS free_claim_slots
FROM roadmap.agency a
LEFT JOIN roadmap.agency_capacity_config cc ON cc.agency_id = a.agency_id
LEFT JOIN active_claims ac ON ac.agency_id = a.agency_id
LEFT JOIN open_assistance oa ON oa.agency_id = a.agency_id
LEFT JOIN recent_messages rm ON rm.agency_id = a.agency_id
WHERE a.status <> 'retired';

CREATE OR REPLACE VIEW roadmap.v_liaison_protocol_health AS
WITH recent AS (
    SELECT *
    FROM roadmap.liaison_message
    WHERE signed_at > now() - interval '15 minutes'
),
ping AS (
    SELECT
        p.agency_id,
        MAX(o.signed_at - p.signed_at) AS last_ping_rtt
    FROM recent p
    JOIN recent o
      ON o.agency_id = p.agency_id
     AND o.kind = 'protocol_pong'
     AND p.kind = 'protocol_ping'
     AND o.signed_at >= p.signed_at
     AND (o.payload->>'nonce') IS NOT DISTINCT FROM (p.payload->>'nonce')
    GROUP BY p.agency_id
)
SELECT
    r.agency_id,
    COUNT(*) FILTER (
        WHERE r.acked_at IS NULL
          AND r.signed_at < now() - interval '60 seconds'
    )::int AS unacked_old,
    COUNT(*) FILTER (WHERE r.ack_outcome = 'reject')::int AS recent_rejects,
    p.last_ping_rtt,
    MAX(r.sequence) AS latest_sequence,
    GREATEST(MAX(r.sequence) - COUNT(DISTINCT r.sequence), 0)::bigint AS sequence_gap_count
FROM recent r
LEFT JOIN ping p ON p.agency_id = r.agency_id
GROUP BY r.agency_id, p.last_ping_rtt;

CREATE OR REPLACE VIEW roadmap.v_assistance_open AS
SELECT
    r.id,
    r.briefing_id,
    r.task_id,
    r.agency_id,
    r.agent_identity,
    r.error_signature,
    r.opened_at,
    (EXTRACT(EPOCH FROM (now() - r.opened_at)) / 60)::numeric AS age_minutes,
    r.payload->>'blocker_severity' AS severity,
    CASE
        WHEN (r.payload->>'proposal_id') ~ '^[0-9]+$' THEN (r.payload->>'proposal_id')::bigint
        ELSE NULL
    END AS proposal_id,
    r.payload->>'route_provider' AS route_provider,
    r.payload
FROM roadmap.assistance_request r
WHERE r.status = 'open'
ORDER BY r.opened_at;

CREATE OR REPLACE FUNCTION roadmap.fn_agency_observability_alerts(
    p_min_interval interval DEFAULT interval '10 minutes'
)
RETURNS TABLE(alert_key text, agency_id text, alert_type text, message text) AS $$
DECLARE
    rec record;
    v_key text;
    v_message text;
BEGIN
    FOR rec IN
        SELECT *
        FROM roadmap.v_agency_dashboard
        WHERE (oldest_open_assistance_at IS NOT NULL AND oldest_open_assistance_at < now() - interval '10 minutes')
           OR COALESCE(silence_seconds, 0) > 600
    LOOP
        IF rec.oldest_open_assistance_at IS NOT NULL
           AND rec.oldest_open_assistance_at < now() - interval '10 minutes' THEN
            v_key := rec.agency_id || ':assistance-old';
            v_message := format(
                'Agency %s has open assistance older than 10 minutes (oldest %s).',
                rec.agency_id,
                rec.oldest_open_assistance_at
            );
            INSERT INTO roadmap.agency_observability_alert(alert_key, agency_id, alert_type, last_sent_at, payload)
            VALUES (v_key, rec.agency_id, 'assistance-old', now(), jsonb_build_object('oldest_open_assistance_at', rec.oldest_open_assistance_at))
            ON CONFLICT (alert_key) DO UPDATE
                SET last_sent_at = EXCLUDED.last_sent_at,
                    payload = EXCLUDED.payload
                WHERE roadmap.agency_observability_alert.last_sent_at < now() - p_min_interval;

            IF FOUND THEN
                PERFORM pg_notify('discord_send', jsonb_build_object(
                    'from', 'agency-observability',
                    'message', v_message,
                    'level', 'warning',
                    'ts', now()
                )::text);
                alert_key := v_key;
                agency_id := rec.agency_id;
                alert_type := 'assistance-old';
                message := v_message;
                RETURN NEXT;
            END IF;
        END IF;

        IF COALESCE(rec.silence_seconds, 0) > 600 THEN
            v_key := rec.agency_id || ':silent';
            v_message := format(
                'Agency %s has been silent for %s seconds.',
                rec.agency_id,
                floor(rec.silence_seconds)
            );
            INSERT INTO roadmap.agency_observability_alert(alert_key, agency_id, alert_type, last_sent_at, payload)
            VALUES (v_key, rec.agency_id, 'silent', now(), jsonb_build_object('silence_seconds', rec.silence_seconds))
            ON CONFLICT (alert_key) DO UPDATE
                SET last_sent_at = EXCLUDED.last_sent_at,
                    payload = EXCLUDED.payload
                WHERE roadmap.agency_observability_alert.last_sent_at < now() - p_min_interval;

            IF FOUND THEN
                PERFORM pg_notify('discord_send', jsonb_build_object(
                    'from', 'agency-observability',
                    'message', v_message,
                    'level', 'warning',
                    'ts', now()
                )::text);
                alert_key := v_key;
                agency_id := rec.agency_id;
                alert_type := 'silent';
                message := v_message;
                RETURN NEXT;
            END IF;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMIT;
