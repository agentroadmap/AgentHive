-- Migration 150: stop counting stale offer_dispatch messages as in-flight
--
-- Problem (observed 2026-05-14):
--   v_agency_in_flight counted ALL unacked liaison_message rows of
--   kind='offer_dispatch' regardless of age. Because liaison-side bugs
--   (DB pool timeouts, crash-loops) had left old messages unacked over the
--   prior 8-12 hours, every named agency reported in_flight=4..5 vs
--   max_in_flight=4 — so the agency-resolver excluded all of them and the
--   orchestrator's new dispatcher path logged "no eligible agency for offer
--   X" 22 times in the final pre-stop window. Net effect: 2,790 dispatches
--   in 24 h were claimed but only 4 ever reached delivered status; everything
--   else expired.
--
-- Fix has two parts:
--
-- 1) Backfill: ack the existing stale messages so the count drops to
--    something realistic right now. ack_outcome must be one of
--    {'ok','reject','noop'} per the CHECK constraint — 'noop' is the right
--    label for "the message was orphaned, no work was actually done."
--
-- 2) View: add a 5-minute recency window. A genuinely in-flight offer
--    renews its lease every 20 s (lease TTL is 60 s) so any unacked message
--    older than 5 min is by definition NOT taking active capacity — either
--    the spawn already finished and the ack got lost, or the agency died
--    and the offer-reaper has already requeued. Either way it shouldn't
--    block new dispatch.
--
-- Future work: investigate why liaison-hub leaves messages unacked under
-- error paths. Acking-on-decline is the right behavior; this view fix is
-- a backstop, not a substitute.

-- ── Step 1: backfill stale unacked offer_dispatch messages ───────────────────

UPDATE roadmap.liaison_message
   SET acked_at    = now(),
       ack_outcome = 'noop',
       ack_error   = 'migration_150: unacked > 5 min, treated as orphaned'
 WHERE kind = 'offer_dispatch'
   AND acked_at IS NULL
   AND created_at < now() - interval '5 minutes';

-- ── Step 2: recreate v_agency_in_flight with a recency window ───────────────

CREATE OR REPLACE VIEW roadmap_workforce.v_agency_in_flight AS
 SELECT pr.id AS provider_registry_id,
        pr.agency_id,
        pr.project_id,
        pr.max_in_flight,
        pr.status AS agency_status,
        count(lm.message_id) AS in_flight_count,
        max(lm.created_at) AS last_claim_at
   FROM roadmap_workforce.provider_registry pr
     LEFT JOIN roadmap_workforce.agent_registry ar ON ar.id = pr.agency_id
     LEFT JOIN roadmap.liaison_message lm
       ON lm.agency_id = ar.agent_identity
      AND lm.kind = 'offer_dispatch'
      AND lm.acked_at IS NULL
      AND lm.created_at > now() - interval '5 minutes'
  GROUP BY pr.id, pr.agency_id, pr.project_id, pr.max_in_flight, pr.status;

COMMENT ON VIEW roadmap_workforce.v_agency_in_flight IS
  'Per-agency capacity gauge used by agency-resolver. Counts unacked '
  'offer_dispatch messages from the last 5 minutes only — older unacked '
  'messages are by definition orphaned (lease TTL=60s, renewal cycle=20s) '
  'and should not block new claims (migration 150).';
