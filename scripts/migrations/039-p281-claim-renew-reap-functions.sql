-- P281 Phase 2: Atomic claim, renewal, and reap functions for offer/claim/lease.
--
-- Functions:
--   fn_claim_work_offer(p_agent_identity, p_required_capabilities, p_lease_ttl_seconds)
--     Atomically picks one open offer this agent is capable of, transitions it
--     to 'claimed', and returns claim_token + dispatch row. Uses FOR UPDATE
--     SKIP LOCKED so concurrent providers never block each other.
--
--   fn_activate_work_offer(p_dispatch_id, p_agent_identity, p_claim_token)
--     Promotes a claimed offer to 'active' (work has started). Requires the
--     claim_token to match — defends against stale-lease races where the
--     reaper has already re-issued.
--
--   fn_renew_lease(p_dispatch_id, p_agent_identity, p_claim_token, p_ttl_seconds)
--     Slides claim_expires_at forward by p_ttl_seconds. Returns FALSE if the
--     token no longer matches (offer was reaped) so the worker can abandon.
--
--   fn_complete_work_offer(p_dispatch_id, p_agent_identity, p_claim_token, p_status)
--     Terminal transition to 'delivered' or 'failed'. Releases the lease.
--
--   fn_reap_expired_offers()
--     Finds claimed/active offers past claim_expires_at. If under max_reissues,
--     re-issues as 'open' (clears claimant, bumps reissue_count, bumps
--     offer_version so stale renewers fail). Otherwise marks 'expired' and
--     logs an AGENT_DEAD escalation.
--
-- Pre-step (1) makes agent_identity nullable so open offers (no claimant yet)
-- don't violate the FK to agent_registry.

BEGIN;

-- (1) squad_dispatch.agent_identity must be nullable for open offers.
--     Drop the empty-string default from migration 038 (FK to agent_registry
--     would reject it anyway).
ALTER TABLE roadmap_workforce.squad_dispatch
  ALTER COLUMN agent_identity DROP NOT NULL,
  ALTER COLUMN agent_identity DROP DEFAULT;

-- (2) fn_claim_work_offer: atomic offer pickup.
--     Returns at most one row. Caller must persist claim_token for renewals.
CREATE OR REPLACE FUNCTION roadmap_workforce.fn_claim_work_offer(
  p_agent_identity TEXT,
  p_required_capabilities JSONB DEFAULT '{}'::jsonb,
  p_lease_ttl_seconds INT DEFAULT 20
)
RETURNS TABLE (
  dispatch_id BIGINT,
  proposal_id BIGINT,
  squad_name TEXT,
  dispatch_role TEXT,
  claim_token UUID,
  claim_expires_at TIMESTAMPTZ,
  offer_version INT,
  metadata JSONB
)
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_picked_id BIGINT;
  v_new_token UUID := gen_random_uuid();
  v_expires TIMESTAMPTZ := now() + make_interval(secs => p_lease_ttl_seconds);
BEGIN
  -- Verify caller is a registered agent
  IF NOT EXISTS (
    SELECT 1 FROM roadmap_workforce.agent_registry
    WHERE agent_identity = p_agent_identity
  ) THEN
    RAISE EXCEPTION 'unknown agent_identity %', p_agent_identity
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Pick one open offer whose required_capabilities are satisfied by this
  -- agent's agent_capability rows. SKIP LOCKED lets concurrent claimers
  -- race without blocking.
  WITH agent_caps AS (
    SELECT ac.capability
    FROM roadmap_workforce.agent_capability ac
    JOIN roadmap_workforce.agent_registry ar ON ar.id = ac.agent_id
    WHERE ar.agent_identity = p_agent_identity
  ),
  candidate AS (
    SELECT sd.id
    FROM roadmap_workforce.squad_dispatch sd
    WHERE sd.offer_status = 'open'
      AND (
        sd.required_capabilities = '{}'::jsonb
        OR NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(
            COALESCE(sd.required_capabilities -> 'all', '[]'::jsonb)
          ) req(cap)
          WHERE req.cap NOT IN (SELECT capability FROM agent_caps)
        )
      )
    ORDER BY sd.assigned_at ASC
    FOR UPDATE OF sd SKIP LOCKED
    LIMIT 1
  )
  SELECT id INTO v_picked_id FROM candidate;

  IF v_picked_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE roadmap_workforce.squad_dispatch sd
  SET offer_status = 'claimed',
      agent_identity = p_agent_identity,
      claim_token = v_new_token,
      claim_expires_at = v_expires,
      claimed_at = now(),
      last_renewed_at = now(),
      offer_version = sd.offer_version + 1
  WHERE sd.id = v_picked_id;

  RETURN QUERY
  SELECT sd.id, sd.proposal_id, sd.squad_name, sd.dispatch_role,
         sd.claim_token, sd.claim_expires_at, sd.offer_version, sd.metadata
  FROM roadmap_workforce.squad_dispatch sd
  WHERE sd.id = v_picked_id;
END;
$fn$;

-- (3) fn_activate_work_offer: caller has started executing the work.
--     Transitions claimed → active, which fires trg_squad_dispatch_claim_lease
--     and creates the proposal_lease row.
CREATE OR REPLACE FUNCTION roadmap_workforce.fn_activate_work_offer(
  p_dispatch_id BIGINT,
  p_agent_identity TEXT,
  p_claim_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_updated INT;
BEGIN
  UPDATE roadmap_workforce.squad_dispatch
  SET offer_status = 'active',
      dispatch_status = 'active',
      last_renewed_at = now()
  WHERE id = p_dispatch_id
    AND agent_identity = p_agent_identity
    AND claim_token = p_claim_token
    AND offer_status IN ('claimed','active');

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$fn$;

-- (4) fn_renew_lease: slide claim_expires_at forward.
--     Returns FALSE if the token no longer matches — caller must abandon.
CREATE OR REPLACE FUNCTION roadmap_workforce.fn_renew_lease(
  p_dispatch_id BIGINT,
  p_agent_identity TEXT,
  p_claim_token UUID,
  p_ttl_seconds INT DEFAULT 20
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_updated INT;
BEGIN
  UPDATE roadmap_workforce.squad_dispatch
  SET claim_expires_at = now() + make_interval(secs => p_ttl_seconds),
      last_renewed_at = now(),
      renew_count = renew_count + 1
  WHERE id = p_dispatch_id
    AND agent_identity = p_agent_identity
    AND claim_token = p_claim_token
    AND offer_status IN ('claimed','active');

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- Mirror to proposal_lease (slide expires_at forward in lock-step)
  IF v_updated = 1 THEN
    UPDATE roadmap_proposal.proposal_lease pl
    SET expires_at = now() + make_interval(secs => p_ttl_seconds * 3),
        renewed_count = pl.renewed_count + 1
    FROM roadmap_workforce.squad_dispatch sd
    WHERE sd.id = p_dispatch_id
      AND sd.lease_id = pl.id
      AND pl.released_at IS NULL;
  END IF;

  RETURN v_updated = 1;
END;
$fn$;

-- (5) fn_complete_work_offer: terminal delivered/failed transition.
CREATE OR REPLACE FUNCTION roadmap_workforce.fn_complete_work_offer(
  p_dispatch_id BIGINT,
  p_agent_identity TEXT,
  p_claim_token UUID,
  p_status TEXT DEFAULT 'delivered'
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $fn$
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
    WHEN 'failed' THEN 'failed'
  END;

  UPDATE roadmap_workforce.squad_dispatch
  SET offer_status = p_status,
      dispatch_status = v_dispatch_status,
      completed_at = now()
  WHERE id = p_dispatch_id
    AND agent_identity = p_agent_identity
    AND claim_token = p_claim_token
    AND offer_status IN ('claimed','active');

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 1 THEN
    UPDATE roadmap_proposal.proposal_lease pl
    SET released_at = now(),
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
$fn$;

-- (6) fn_reap_expired_offers: re-issue or escalate.
--     Re-issued offers get a new claim_token (via gen_random_uuid default on
--     UPDATE? No — defaults only apply on INSERT, so we set explicitly) and
--     bump offer_version so any in-flight renewer fails.
CREATE OR REPLACE FUNCTION roadmap_workforce.fn_reap_expired_offers()
RETURNS TABLE (
  reissued_count INT,
  expired_count INT
)
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_reissued INT := 0;
  v_expired INT := 0;
  v_row RECORD;
BEGIN
  FOR v_row IN
    SELECT id, proposal_id, agent_identity, reissue_count, max_reissues
    FROM roadmap_workforce.squad_dispatch
    WHERE offer_status IN ('claimed','active')
      AND claim_expires_at IS NOT NULL
      AND claim_expires_at < now()
    FOR UPDATE SKIP LOCKED
  LOOP
    IF v_row.reissue_count < v_row.max_reissues THEN
      UPDATE roadmap_workforce.squad_dispatch
      SET offer_status = 'open',
          dispatch_status = 'open',
          agent_identity = NULL,
          claim_token = gen_random_uuid(),
          claim_expires_at = NULL,
          claimed_at = NULL,
          last_renewed_at = NULL,
          renew_count = 0,
          reissue_count = reissue_count + 1,
          offer_version = offer_version + 1,
          lease_id = NULL
      WHERE id = v_row.id;

      -- Release any orphan lease the previous claimant created
      UPDATE roadmap_proposal.proposal_lease
      SET released_at = now(),
          release_reason = 'reaped_offer_expired'
      WHERE proposal_id = v_row.proposal_id
        AND agent_identity = v_row.agent_identity
        AND released_at IS NULL;

      v_reissued := v_reissued + 1;

      -- Wake any listeners so the re-issued offer gets picked up promptly
      PERFORM pg_notify(
        'work_offers',
        json_build_object('event','reissued','dispatch_id', v_row.id)::text
      );
    ELSE
      UPDATE roadmap_workforce.squad_dispatch
      SET offer_status = 'expired',
          dispatch_status = 'failed',
          completed_at = now()
      WHERE id = v_row.id;

      UPDATE roadmap_proposal.proposal_lease
      SET released_at = now(),
          release_reason = 'reaped_offer_exhausted'
      WHERE proposal_id = v_row.proposal_id
        AND agent_identity = v_row.agent_identity
        AND released_at IS NULL;

      INSERT INTO roadmap.escalation_log (
        obstacle_type, proposal_id, agent_identity, escalated_to, severity
      ) VALUES (
        'AGENT_DEAD',
        v_row.proposal_id::text,
        v_row.agent_identity,
        'orchestrator',
        'high'
      );

      v_expired := v_expired + 1;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_reissued, v_expired;
END;
$fn$;

COMMIT;
