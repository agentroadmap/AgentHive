-- P-derived-maturity: Lease expiry is authoritative without explicit released_at write.
--
-- Problem: is_active GENERATED AS (released_at IS NULL) ignores expires_at, so
-- expired-but-unreleased leases appear live. maturity='active' is stored state
-- that only resets via the fn_lease_clear_maturity_on_release trigger — which
-- only fires when the reaper explicitly writes released_at. If the reaper hasn't
-- run (it was boot-only), expired leases permanently block fresh dispatch.
--
-- Fix:
--   1. v_active_leases — exclude leases whose expires_at has passed
--   2. v_proposal_full — same expiry filter on the lease lateral join;
--      expose effective_maturity computed from stored maturity + live lease
--   3. v_proposal_summary — same expiry filter + derived effective_maturity

-- ── 1. v_active_leases: exclude expired unreleased leases ────────────────────
CREATE OR REPLACE VIEW roadmap_proposal.v_active_leases AS
SELECT pl.id,
    p.display_id,
    p.type,
    p.status,
    pl.agent_identity,
    pl.claimed_at,
    pl.expires_at,
    CASE
        WHEN pl.expires_at IS NULL THEN 'open'::text
        WHEN pl.expires_at > now() THEN 'active'::text
        ELSE 'expired'::text
    END AS lease_status
FROM roadmap_proposal.proposal_lease pl
JOIN roadmap_proposal.proposal p ON p.id = pl.proposal_id
WHERE pl.released_at IS NULL
  AND (pl.expires_at IS NULL OR pl.expires_at > now());

COMMENT ON VIEW roadmap_proposal.v_active_leases IS
'Live leases only: released_at IS NULL AND (expires_at IS NULL OR expires_at > now()). Expired-but-unreleased rows are excluded — expiry is authoritative without a released_at write.';

-- ── 2. v_proposal_full: expiry-aware lease join + effective_maturity ─────────
CREATE OR REPLACE VIEW roadmap_proposal.v_proposal_full AS
SELECT p.id,
    p.display_id,
    p.parent_id,
    p.type,
    p.status,
    -- effective_maturity: for working states (new/active), derive from
    -- live lease presence — not from the stored column. This ensures:
    --   - expired-but-unreleased leases don't leave maturity stuck at 'active'
    --   - agents claiming a lease automatically surface as 'active' without
    --     an explicit prop_set_maturity call
    -- mature/obsolete are terminal maturity states not affected by leases.
    CASE
        WHEN p.maturity IN ('mature', 'obsolete') THEN p.maturity
        WHEN EXISTS (
            SELECT 1 FROM roadmap_proposal.proposal_lease pl2
            WHERE pl2.proposal_id = p.id
              AND pl2.released_at IS NULL
              AND (pl2.expires_at IS NULL OR pl2.expires_at > now())
        ) THEN 'active'::text
        ELSE 'new'::text
    END AS maturity,
    p.title,
    p.summary,
    p.motivation,
    p.design,
    p.drawbacks,
    p.alternatives,
    p.dependency,
    p.priority,
    p.tags,
    p.audit,
    p.created_at,
    p.modified_at,
    COALESCE(dep.deps, '[]'::jsonb) AS dependencies,
    COALESCE(ac.criteria, '[]'::jsonb) AS acceptance_criteria,
    "dec".latest_decision,
    "dec".decision_at,
    lease.leased_by,
    lease.lease_expires,
    wf.workflow_name,
    wf.current_stage
FROM roadmap_proposal.proposal p
LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
        'to_display_id', pd.display_id,
        'dependency_type', d.dependency_type,
        'resolved', d.resolved
    )) AS deps
    FROM roadmap_proposal.proposal_dependencies d
    JOIN roadmap_proposal.proposal pd ON pd.id = d.to_proposal_id
    WHERE d.from_proposal_id = p.id
) dep ON true
LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
        'item_number', ac_1.item_number,
        'criterion_text', ac_1.criterion_text,
        'status', ac_1.status,
        'verified_by', ac_1.verified_by
    ) ORDER BY ac_1.item_number) AS criteria
    FROM roadmap_proposal.proposal_acceptance_criteria ac_1
    WHERE ac_1.proposal_id = p.id
) ac ON true
LEFT JOIN LATERAL (
    SELECT pd.decision AS latest_decision,
        pd.decided_at AS decision_at
    FROM roadmap_proposal.proposal_decision pd
    WHERE pd.proposal_id = p.id
    ORDER BY pd.decided_at DESC
    LIMIT 1
) "dec" ON true
LEFT JOIN LATERAL (
    SELECT pl.agent_identity AS leased_by,
        pl.expires_at AS lease_expires
    FROM roadmap_proposal.proposal_lease pl
    WHERE pl.proposal_id = p.id
      AND pl.released_at IS NULL
      AND (pl.expires_at IS NULL OR pl.expires_at > now())
    ORDER BY pl.claimed_at DESC
    LIMIT 1
) lease ON true
LEFT JOIN LATERAL (
    SELECT ptc.workflow_name,
        w.current_stage
    FROM roadmap.workflows w
    JOIN roadmap.workflow_templates wt ON wt.id = w.template_id
    JOIN roadmap_proposal.proposal_type_config ptc ON ptc.workflow_name = wt.name
    WHERE w.proposal_id = p.id
    LIMIT 1
) wf ON true;

COMMENT ON VIEW roadmap_proposal.v_proposal_full IS
'Complete proposal with all child tables as JSONB. maturity column is effective_maturity: derives active from maturity=new + live (non-expired) lease; expired-but-unreleased leases are excluded from leased_by. Used by MCP tools for full proposal rendering.';

-- ── 3. v_proposal_summary: expiry-aware lease join + effective_maturity ──────
CREATE OR REPLACE VIEW roadmap_proposal.v_proposal_summary AS
SELECT p.id,
    p.display_id,
    p.type,
    p.title,
    p.status,
    p.priority,
    -- effective_maturity: same derivation as v_proposal_full
    CASE
        WHEN p.maturity IN ('mature', 'obsolete') THEN p.maturity
        WHEN EXISTS (
            SELECT 1 FROM roadmap_proposal.proposal_lease pl2
            WHERE pl2.proposal_id = p.id
              AND pl2.released_at IS NULL
              AND (pl2.expires_at IS NULL OR pl2.expires_at > now())
        ) THEN 'active'::text
        ELSE 'new'::text
    END AS maturity,
    p.tags,
    ptc.workflow_name,
    w.current_stage,
    pl.agent_identity AS leased_by,
    pl.claimed_at AS leased_at,
    pl.expires_at AS lease_expires,
    pd.decision AS latest_decision,
    pd.decided_at AS decision_at,
    p.created_at,
    p.audit
FROM roadmap_proposal.proposal p
LEFT JOIN roadmap_proposal.proposal_type_config ptc ON ptc.type = p.type
LEFT JOIN roadmap.workflows w ON w.proposal_id = p.id
LEFT JOIN LATERAL (
    SELECT proposal_lease.agent_identity,
           proposal_lease.claimed_at,
           proposal_lease.expires_at
    FROM roadmap_proposal.proposal_lease
    WHERE proposal_lease.proposal_id = p.id
      AND proposal_lease.released_at IS NULL
      AND (proposal_lease.expires_at IS NULL OR proposal_lease.expires_at > now())
    LIMIT 1
) pl ON true
LEFT JOIN LATERAL (
    SELECT proposal_decision.decision,
           proposal_decision.decided_at
    FROM roadmap_proposal.proposal_decision
    WHERE proposal_decision.proposal_id = p.id
    ORDER BY proposal_decision.decided_at DESC
    LIMIT 1
) pd ON true;

COMMENT ON VIEW roadmap_proposal.v_proposal_summary IS
'Proposal list view. maturity is effective_maturity: derived from live (non-expired) lease; expired-but-unreleased leases are excluded from leased_by.';

-- ── 4. Integrity check — current expired-but-unreleased leases ───────────────
-- After this migration, these leases are invisible to v_active_leases and
-- v_proposal_full. The periodic stale-row reaper will clean them up.
-- Run this to see what was hidden before the migration (informational only):
--   SELECT pl.id, p.display_id, pl.agent_identity, pl.expires_at
--   FROM roadmap_proposal.proposal_lease pl
--   JOIN roadmap_proposal.proposal p ON p.id = pl.proposal_id
--   WHERE pl.released_at IS NULL
--     AND pl.expires_at IS NOT NULL
--     AND pl.expires_at < now();
