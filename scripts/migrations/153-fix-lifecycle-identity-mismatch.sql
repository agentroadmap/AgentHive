-- Migration 153: fix the silent identity-mismatch in fn_renew_lease and
-- fn_complete_work_offer — the root cause of the 2,790-claimed-only-4-delivered
-- pattern that has been bleeding the system since this morning's audit.
--
-- Architecture mismatch:
--   Orchestrator claims offers under its own identity:
--     squad_dispatch.agent_identity = 'agenthive/agency-orchestrator'
--   Then it forwards the offer_dispatch message (carrying the claim_token)
--   to the chosen named agency (e.g. 'adam'). When the agency calls:
--     fn_renew_lease($dispatch_id, 'adam', $claim_token, 60)
--     fn_complete_work_offer($dispatch_id, 'adam', $claim_token, 'delivered')
--   the WHERE clause `agent_identity = p_agent_identity` does NOT match
--   ('adam' != 'agenthive/agency-orchestrator'). The functions return FALSE
--   (0 rows updated) but do not throw, so the agency's logger sees
--   "delivered (exit=0)" — yet the DB row stays 'claimed', lease expires,
--   reaper requeues, the next agency takes the same work, repeat.
--
-- Authorization model after this migration:
--   claim_token (UUID, generated atomically on fn_claim_work_offer) is the
--   only secret needed. It is delivered to the agency via the offer_dispatch
--   message ONLY. Presenting the token is sufficient proof to manage the
--   lease. agent_identity remains as observability metadata but is no
--   longer part of the WHERE clause.
--
-- Observed symptom (2026-05-14, 25 min after restart):
--   agent_runs: 14 'completed' runs, real work output in output_summary
--   squad_dispatch: 0 'delivered', 46 'expired', renew_count=0 everywhere
--   adam log: 5x "[OfferDispatchHandler] adam: offer=... delivered (exit=0)"
--     — but in DB those offers are 'expired'.

-- ── fn_renew_lease ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_renew_lease(
  p_dispatch_id    BIGINT,
  p_agent_identity TEXT,
  p_claim_token    UUID,
  p_ttl_seconds    INTEGER DEFAULT 20
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $function$
DECLARE
  v_updated INT;
BEGIN
  UPDATE roadmap_workforce.squad_dispatch
  SET claim_expires_at = now() + make_interval(secs => p_ttl_seconds),
      last_renewed_at  = now(),
      renew_count      = renew_count + 1,
      -- Stamp the agency that's actually working it (observability only).
      agency_identity  = COALESCE(agency_identity, p_agent_identity)
  WHERE id           = p_dispatch_id
    AND claim_token  = p_claim_token
    AND offer_status IN ('claimed', 'active');

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 1 THEN
    UPDATE roadmap_proposal.proposal_lease pl
    SET expires_at    = now() + make_interval(secs => p_ttl_seconds * 3),
        renewed_count = pl.renewed_count + 1
    FROM roadmap_workforce.squad_dispatch sd
    WHERE sd.id = p_dispatch_id
      AND sd.lease_id = pl.id
      AND pl.released_at IS NULL;
  END IF;

  RETURN v_updated = 1;
END;
$function$;

-- ── fn_complete_work_offer ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_complete_work_offer(
  p_dispatch_id    BIGINT,
  p_agent_identity TEXT,
  p_claim_token    UUID,
  p_status         TEXT DEFAULT 'delivered'
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $function$
DECLARE
  v_updated INT;
  v_dispatch_status TEXT;
BEGIN
  IF p_status NOT IN ('delivered','failed') THEN
    RAISE EXCEPTION 'invalid completion status %', p_status
      USING ERRCODE = 'check_violation';
  END IF;

  v_dispatch_status := CASE p_status
    WHEN 'delivered' THEN 'completed'
    WHEN 'failed'    THEN 'failed'
  END;

  UPDATE roadmap_workforce.squad_dispatch
  SET offer_status    = p_status,
      dispatch_status = v_dispatch_status,
      completed_at    = now(),
      -- Stamp the agency that completed the work for audit.
      agency_identity = COALESCE(agency_identity, p_agent_identity)
  WHERE id           = p_dispatch_id
    AND claim_token  = p_claim_token
    AND offer_status IN ('claimed', 'active');

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 1 THEN
    UPDATE roadmap_proposal.proposal_lease pl
    SET released_at    = now(),
        release_reason = CASE p_status
          WHEN 'delivered' THEN 'work_delivered'
          ELSE 'work_failed'
        END
    FROM roadmap_workforce.squad_dispatch sd
    WHERE sd.id = p_dispatch_id
      AND sd.lease_id = pl.id
      AND pl.released_at IS NULL;
  END IF;

  RETURN v_updated = 1;
END;
$function$;

-- ── fn_return_work_offer (migration 151) — same fix ──────────────────────────
-- Already permissive: `agent_identity = p_agent_identity OR agency_identity = p_agent_identity`.
-- Tightening to claim_token-only for consistency.

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_return_work_offer(
  p_dispatch_id    BIGINT,
  p_agent_identity TEXT,
  p_claim_token    UUID,
  p_reason         TEXT DEFAULT 'unspecified'
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $function$
DECLARE
  v_updated INT;
BEGIN
  UPDATE roadmap_workforce.squad_dispatch
  SET offer_status     = 'open',
      dispatch_status  = 'open',
      claim_token      = gen_random_uuid(),
      claimed_at       = NULL,
      claim_expires_at = NULL,
      last_renewed_at  = NULL,
      metadata = metadata || jsonb_build_object(
        'return_reason', p_reason,
        'returned_by',   p_agent_identity,
        'returned_at',   to_jsonb(now())
      )
  WHERE id           = p_dispatch_id
    AND claim_token  = p_claim_token
    AND offer_status IN ('claimed', 'active');

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 1 THEN
    UPDATE roadmap_proposal.proposal_lease pl
    SET released_at    = now(),
        release_reason = 'agent_returned'
    FROM roadmap_workforce.squad_dispatch sd
    WHERE sd.id = p_dispatch_id
      AND sd.lease_id = pl.id
      AND pl.released_at IS NULL;

    PERFORM pg_notify('work_offers', json_build_object(
      'dispatch_id', p_dispatch_id,
      'event',       'returned',
      'reason',      p_reason
    )::text);
  END IF;

  RETURN v_updated = 1;
END;
$function$;
