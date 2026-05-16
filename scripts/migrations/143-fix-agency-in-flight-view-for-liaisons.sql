-- Migration 143: Fix v_agency_in_flight to count unacked liaison offer_dispatch messages
--
-- Problem: v_agency_in_flight counted proposal_lease rows. Named agencies (adam, alan,
-- alex, calvin, carter, cooper, george, pablo, pete) are liaisons — they RECEIVE
-- offer_dispatch messages in liaison_message, not hold proposal_lease rows directly.
-- Their children hold the leases. So in_flight_count was always 0 for all named
-- agencies, making the resolver's capacity filter and in-flight ORDER BY useless —
-- the resolver always picked the same agency (first alphabetically after ties).
--
-- Fix: count unacked liaison_message rows with kind='offer_dispatch' as the in-flight
-- signal for liaisons. When an agency has >= max_in_flight pending dispatches, the
-- resolver's WHERE clause (COALESCE(inf.in_flight_count, 0) < pr.max_in_flight)
-- will exclude it, distributing load across the pool.

CREATE OR REPLACE VIEW roadmap_workforce.v_agency_in_flight AS
SELECT pr.id                        AS provider_registry_id,
       pr.agency_id,
       pr.project_id,
       pr.max_in_flight,
       pr.status                    AS agency_status,
       COUNT(lm.message_id)         AS in_flight_count,
       MAX(lm.created_at)           AS last_claim_at
FROM roadmap_workforce.provider_registry pr
LEFT JOIN roadmap_workforce.agent_registry ar ON ar.id = pr.agency_id
LEFT JOIN roadmap.liaison_message lm
  ON lm.agency_id = ar.agent_identity
 AND lm.kind = 'offer_dispatch'
 AND lm.acked_at IS NULL
GROUP BY pr.id, pr.agency_id, pr.project_id, pr.max_in_flight, pr.status;

COMMENT ON VIEW roadmap_workforce.v_agency_in_flight IS
  'In-flight load per agency: counts unacked offer_dispatch liaison messages (migration 143). '
  'Replaces proposal_lease counting which was always 0 for liaison-style named agencies.';
