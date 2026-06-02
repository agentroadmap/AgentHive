-- P181: Governance Amendment proposal type
-- Implements a 6-stage governance-amendment workflow with:
--   - Mandatory DELIBERATION stage between DRAFT and REVIEW
--   - 5 gate_role rows (D1–D5)
--   - 48-hour minimum timing gate at D2 (DELIBERATION→REVIEW)
--   - Human-only approval gate at D5 (MERGE→COMPLETE)
--   - Dual-schema proposal_type_config (roadmap + roadmap_proposal)
--   - Type-aware v_implicit_gate_ready view for DELIBERATION enqueuing (AC-16)
--   - fn_guard_gate_advance extended with type-scoped governance block (AC-6)
--
-- All changes are additive. Standard RFC proposals are unaffected.
-- All INSERTs use ON CONFLICT DO NOTHING — idempotent.
-- Pre-requisites: 040-p290-gate-enforcement.sql, 033-implicit-maturity-gating.sql

BEGIN;

-- ─── 1. Extend gate_role.gate CHECK constraint to include 'D5' (AC-19) ───────
DO $$
DECLARE
    v_cname TEXT;
BEGIN
    SELECT conname INTO v_cname
      FROM pg_constraint
     WHERE conrelid = 'roadmap_proposal.gate_role'::regclass
       AND contype  = 'c'
       AND pg_get_constraintdef(oid) LIKE '%D4%'
       AND pg_get_constraintdef(oid) LIKE '%gate%'
       AND pg_get_constraintdef(oid) NOT LIKE '%D5%';
    IF v_cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE roadmap_proposal.gate_role DROP CONSTRAINT %I', v_cname);
        ALTER TABLE roadmap_proposal.gate_role
            ADD CONSTRAINT gate_role_gate_check
            CHECK (gate IN ('D1','D2','D3','D4','D5'));
    END IF;
END;
$$;

-- ─── 2. Extend gate_task_templates.gate CHECK constraint to include 'D5' ─────
DO $$
DECLARE
    v_cname TEXT;
BEGIN
    SELECT conname INTO v_cname
      FROM pg_constraint
     WHERE conrelid = 'roadmap.gate_task_templates'::regclass
       AND contype  = 'c'
       AND pg_get_constraintdef(oid) LIKE '%D4%'
       AND pg_get_constraintdef(oid) LIKE '%gate%'
       AND pg_get_constraintdef(oid) NOT LIKE '%D5%';
    IF v_cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE roadmap.gate_task_templates DROP CONSTRAINT %I', v_cname);
        ALTER TABLE roadmap.gate_task_templates
            ADD CONSTRAINT gate_task_templates_gate_check
            CHECK (gate IN ('D1','D2','D3','D4','D5'));
    END IF;
END;
$$;

-- ─── 3. Workflow template (AC-1) ──────────────────────────────────────────────
-- Note: workflow_templates has no slug or gate_level columns.
INSERT INTO roadmap.workflow_templates (name, description, stage_count)
VALUES (
    'Governance Amendment',
    'Elevated workflow for constitutional and governance rule changes — 6 stages with mandatory DELIBERATION and human-only MERGE gate',
    6
)
ON CONFLICT (name) DO NOTHING;

-- ─── 4. Workflow stages — 6 stages for the new template (AC-1) ───────────────
WITH tmpl AS (
    SELECT id FROM roadmap.workflow_templates WHERE name = 'Governance Amendment'
)
INSERT INTO roadmap.workflow_stages
    (template_id, stage_name, stage_order, maturity_gate, requires_ac, gating_config)
SELECT
    t.id,
    v.stage_name,
    v.stage_order,
    v.maturity_gate,
    v.requires_ac,
    v.gating_config::jsonb
FROM tmpl t
CROSS JOIN (VALUES
    ('DRAFT',        1, 2, true,  '{"requires_section_reference": true}'),
    ('DELIBERATION', 2, 2, false, '{"min_wait_hours": 48, "blocking_concerns_check": true}'),
    ('REVIEW',       3, 2, true,  '{"min_reviewers": 2, "required_roles": ["skeptic"], "distinct_agents": true}'),
    ('DEVELOP',      4, 2, false, '{"dispatch": {"role": "developer", "tier": "senior"}}'),
    ('MERGE',        5, 2, true,  '{"require_human_approver": true, "human_agent_type": "human"}'),
    ('COMPLETE',     6, 2, false, '{"post_action": "update_constitutional_document"}')
) AS v(stage_name, stage_order, maturity_gate, requires_ac, gating_config)
ON CONFLICT (template_id, stage_name) DO NOTHING;

-- ─── 5. Workflow transitions — 8 transitions (AC-2) ──────────────────────────
WITH tmpl AS (
    SELECT id FROM roadmap.workflow_templates WHERE name = 'Governance Amendment'
)
INSERT INTO roadmap.workflow_transitions
    (template_id, from_stage, to_stage, labels, allowed_roles, requires_ac)
SELECT
    t.id,
    v.from_stage,
    v.to_stage,
    string_to_array(v.labels_str, ','),
    string_to_array(v.roles_str,  ','),
    v.requires_ac
FROM tmpl t
CROSS JOIN (VALUES
    ('DRAFT',        'DELIBERATION', 'mature,submit',         'any',           false),
    ('DELIBERATION', 'REVIEW',       'mature,advance',        'PM,Skeptic',    false),
    ('DELIBERATION', 'DRAFT',        'block,concerns_raised', 'any',           false),
    ('REVIEW',       'DEVELOP',      'approve',               'PM,Skeptic',    true),
    ('REVIEW',       'DELIBERATION', 'reject,revise',         'Skeptic',       false),
    ('DEVELOP',      'MERGE',        'mature,complete',       'PM,Architect',  false),
    ('MERGE',        'COMPLETE',     'approve',               'human',         true),
    ('MERGE',        'REVIEW',       'reject',                'human,Skeptic', false)
) AS v(from_stage, to_stage, labels_str, roles_str, requires_ac)
ON CONFLICT (template_id, from_stage, to_stage) DO NOTHING;

-- ─── 6. proposal_type_config — dual-schema insert (AC-7, AC-18) ──────────────
-- fn_spawn_workflow reads roadmap_proposal; hotpath functions (migration 081)
-- read roadmap. Both must be populated.
INSERT INTO roadmap.proposal_type_config (type, workflow_name, description)
VALUES (
    'governance-amendment',
    'Governance Amendment',
    'Constitutional or governance rule change — elevated review, human approval required'
)
ON CONFLICT (type) DO NOTHING;

INSERT INTO roadmap_proposal.proposal_type_config (type, workflow_name, description)
VALUES (
    'governance-amendment',
    'Governance Amendment',
    'Constitutional or governance rule change — elevated review, human approval required'
)
ON CONFLICT (type) DO NOTHING;

-- ─── 7. proposal_valid_transitions — 8 valid paths (AC-2, AC-3) ──────────────
INSERT INTO roadmap_proposal.proposal_valid_transitions
    (workflow_name, from_state, to_state, allowed_reasons, allowed_roles, requires_ac)
VALUES
    ('Governance Amendment', 'DRAFT',        'DELIBERATION', '{mature,submit}',         '{any}',           'none'),
    ('Governance Amendment', 'DELIBERATION', 'REVIEW',       '{mature,advance}',        '{PM,Skeptic}',    'none'),
    ('Governance Amendment', 'DELIBERATION', 'DRAFT',        '{block,concerns_raised}', '{any}',           'none'),
    ('Governance Amendment', 'REVIEW',       'DEVELOP',      '{approve}',               '{PM,Skeptic}',    'all'),
    ('Governance Amendment', 'REVIEW',       'DELIBERATION', '{reject,revise}',         '{Skeptic}',       'none'),
    ('Governance Amendment', 'DEVELOP',      'MERGE',        '{mature,complete}',       '{PM,Architect}',  'none'),
    ('Governance Amendment', 'MERGE',        'COMPLETE',     '{approve}',               '{human}',         'all'),
    ('Governance Amendment', 'MERGE',        'REVIEW',       '{reject}',                '{human,Skeptic}', 'none')
ON CONFLICT (workflow_name, from_state, to_state) DO NOTHING;

-- ─── 8. gate_role seeds — D1 through D5 (AC-4, AC-8, AC-9, AC-17) ───────────
INSERT INTO roadmap_proposal.gate_role
    (proposal_type, gate, role, persona, output_contract,
     model_preference, tool_allow_list, fallback_role, lifecycle_status)
VALUES
  -- D1: DRAFT → DELIBERATION — section-reference check
  ('governance-amendment', 'D1', 'researcher',
   'You are the Governance Researcher gating DRAFT → DELIBERATION. Verify: '
   '(1) proposal.summary cites at least one constitutional Article/Section being modified; '
   '(2) AC list references the sections being changed; '
   '(3) doc-9 dependency link is present. '
   'ADVANCE if all three pass. HOLD with specific missing items if not.',
   'section_reference_check: cite the missing Article/Section reference or doc-9 dependency. ADVANCE or HOLD only.',
   NULL, NULL, NULL, 'active'),

  -- D2: DELIBERATION → REVIEW — 48h wait + blocking-concern check
  ('governance-amendment', 'D2', 'deliberation',
   'You are the Deliberation Monitor gating DELIBERATION → REVIEW. '
   'Check: (1) elapsed_hours >= 48 since DELIBERATION was entered '
   '(query proposal_state_transitions for the DRAFT→DELIBERATION row); '
   '(2) no discussion entries with blocking=true and status != resolved. '
   'If elapsed < 48h, HOLD with elapsed_hours detail. If unresolved blocking concerns, list them.',
   'blocking_concern_check + wait_elapsed: HOLD if elapsed < 48h (include elapsed_hours) '
   'or unresolved concerns (include concern author + body). ADVANCE only when both conditions clear.',
   NULL, NULL, NULL, 'active'),

  -- D3: REVIEW → DEVELOP — 2-distinct-approver quorum, Skeptic required
  ('governance-amendment', 'D3', 'skeptic',
   'You are CONSTITUTIONAL SKEPTIC gating REVIEW → DEVELOP. '
   'Requirements: (1) minimum 2 distinct reviewer agents must have approved, '
   'including at least one with role=skeptic; (2) no unresolved blocking reviews. '
   'Reject same-agent double-counts — reviewer_identity uniqueness is enforced by proposal_reviews constraint. '
   'Verify quorum from gate_decision_log or proposal_reviews.',
   'approve|reject + quorum_count: emit current_approvers N, required 2, distinct=true. '
   'ADVANCE if quorum met and no blockers. REJECT with specific approver list if quorum not met.',
   NULL, NULL, NULL, 'active'),

  -- D4: DEVELOP → MERGE — code/AC/doc verification
  ('governance-amendment', 'D4', 'reviewer',
   'You are the Code/AC Reviewer gating DEVELOP → MERGE for a governance amendment. '
   'Verify: (1) migration files exist and are correct for all schema changes declared in the design; '
   '(2) all ACs referencing code/schema changes are passing or have clear verification paths; '
   '(3) CONVENTIONS.md and AGENTS.md have been updated per Section 7 of design.',
   'advance|hold: cite specific ACs by item_number. Evidence: file:line for each checked artifact.',
   NULL, NULL, NULL, 'active'),

  -- D5: MERGE → COMPLETE — human-only constitutional approval gate
  ('governance-amendment', 'D5', 'human',
   'You are the Human Steward (Gary) gating MERGE → COMPLETE for a governance-amendment. '
   'This is the final constitutional approval gate — only a registered human agent '
   '(agent_type=human) may approve. Review the full amendment: proposed constitutional text change, '
   'audit trail in gate_decision_log, deliberation thread summary. '
   'Approve only if the amendment text, rationale, and process all appear sound. '
   'REJECT returns to REVIEW.',
   'approve|reject: human-only. approval atomically updates doc-9 at COMPLETE. '
   'rejection routes back to REVIEW for revision.',
   NULL, NULL, NULL, 'active')

ON CONFLICT ON CONSTRAINT gate_role_active_unique DO NOTHING;

-- ─── 9. Extend fn_guard_gate_advance for governance-amendment (AC-6) ─────────
-- Adds a type-scoped block BEFORE the existing 4-gate RFC handler so existing
-- proposal types (feature, hotfix, directive, …) are completely unaffected.
-- New behaviour for governance-amendment:
--   D2 (DELIBERATION→REVIEW): 48h minimum timing gate
--   D5 (MERGE→COMPLETE): human agent_type required in gate_decision_log
CREATE OR REPLACE FUNCTION roadmap_proposal.fn_guard_gate_advance()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
    v_gate_key      TEXT;
    v_has_decision  BOOLEAN;
    v_proposal_type TEXT;
    v_entered_at    TIMESTAMPTZ;
BEGIN
    v_gate_key := UPPER(OLD.status) || E'→' || UPPER(NEW.status);

    SELECT type INTO v_proposal_type
      FROM roadmap_proposal.proposal WHERE id = NEW.id;

    -- ── Governance-amendment: 5 gated transitions (D1–D5) ────────────────────
    IF v_proposal_type = 'governance-amendment' THEN
        IF v_gate_key NOT IN (
            E'DRAFT→DELIBERATION',
            E'DELIBERATION→REVIEW',
            E'REVIEW→DEVELOP',
            E'DEVELOP→MERGE',
            E'MERGE→COMPLETE'
        ) THEN
            RETURN NEW;
        END IF;

        IF current_setting('app.gate_bypass', true) = 'true' THEN
            RETURN NEW;
        END IF;

        -- D2 timing: DELIBERATION must stay open ≥ 48 hours before advancing to REVIEW
        IF v_gate_key = E'DELIBERATION→REVIEW' THEN
            SELECT transitioned_at INTO v_entered_at
              FROM roadmap_proposal.proposal_state_transitions
             WHERE proposal_id = NEW.id
               AND to_state    = 'DELIBERATION'
             ORDER BY transitioned_at DESC
             LIMIT 1;

            IF v_entered_at IS NOT NULL
               AND EXTRACT(EPOCH FROM (now() - v_entered_at)) / 3600 < 48 THEN
                RAISE EXCEPTION
                    'governance_deliberation_wait_not_elapsed: elapsed_hours=%, required_hours=48',
                    ROUND(EXTRACT(EPOCH FROM (now() - v_entered_at)) / 3600, 1)
                    USING ERRCODE = 'check_violation';
            END IF;
        END IF;

        -- D5 human-only gate: MERGE→COMPLETE requires agent_type='human' approver
        IF v_gate_key = E'MERGE→COMPLETE' THEN
            IF NOT EXISTS (
                SELECT 1
                  FROM roadmap_proposal.gate_decision_log gdl
                  JOIN roadmap_workforce.agent_registry ar
                    ON ar.agent_identity = gdl.decided_by
                 WHERE gdl.proposal_id       = NEW.id
                   AND UPPER(gdl.from_state) = 'MERGE'
                   AND UPPER(gdl.to_state)   = 'COMPLETE'
                   AND gdl.decision          = 'advance'
                   AND ar.agent_type         = 'human'
                   AND gdl.created_at        >= now() - INTERVAL '10 minutes'
            ) THEN
                RAISE EXCEPTION
                    'governance_human_approver_required: MERGE→COMPLETE requires agent_type=human approver'
                    USING ERRCODE = 'check_violation';
            END IF;
        END IF;

        -- General gate decision check (covers D1, D3, D4 and fallback for D2/D5)
        SELECT EXISTS (
            SELECT 1
              FROM roadmap_proposal.gate_decision_log gdl
             WHERE gdl.proposal_id       = NEW.id
               AND UPPER(gdl.from_state) = UPPER(OLD.status)
               AND UPPER(gdl.to_state)   = UPPER(NEW.status)
               AND gdl.decision          = 'advance'
               AND gdl.created_at        >= now() - INTERVAL '10 minutes'
        ) INTO v_has_decision;

        IF v_has_decision THEN RETURN NEW; END IF;

        SELECT EXISTS (
            SELECT 1
              FROM roadmap_proposal.proposal_reviews pr
             WHERE pr.proposal_id = NEW.id
               AND pr.verdict     = 'approve'
               AND pr.reviewed_at >= now() - INTERVAL '10 minutes'
        ) INTO v_has_decision;

        IF v_has_decision THEN RETURN NEW; END IF;

        RAISE EXCEPTION
            'Gate transition % → % on governance-amendment proposal % requires a gate decision. '
            'Submit gate_decision_log (decision=advance) within the last 10 minutes before advancing.',
            OLD.status, NEW.status, NEW.id
            USING ERRCODE = 'check_violation';
    END IF;

    -- ── Standard RFC / hotfix gate enforcement (unchanged from P290) ──────────
    IF v_gate_key NOT IN (
        E'DRAFT→REVIEW',
        E'REVIEW→DEVELOP',
        E'DEVELOP→MERGE',
        E'MERGE→COMPLETE'
    ) THEN
        RETURN NEW;
    END IF;

    IF current_setting('app.gate_bypass', true) = 'true' THEN
        RETURN NEW;
    END IF;

    SELECT EXISTS (
        SELECT 1
          FROM roadmap_proposal.gate_decision_log gdl
         WHERE gdl.proposal_id       = NEW.id
           AND UPPER(gdl.from_state) = UPPER(OLD.status)
           AND UPPER(gdl.to_state)   = UPPER(NEW.status)
           AND gdl.decision          = 'advance'
           AND gdl.created_at        >= now() - INTERVAL '10 minutes'
    ) INTO v_has_decision;

    IF v_has_decision THEN RETURN NEW; END IF;

    SELECT EXISTS (
        SELECT 1
          FROM roadmap_proposal.proposal_reviews pr
         WHERE pr.proposal_id = NEW.id
               AND pr.verdict     = 'approve'
               AND pr.reviewed_at >= now() - INTERVAL '10 minutes'
    ) INTO v_has_decision;

    IF v_has_decision THEN RETURN NEW; END IF;

    RAISE EXCEPTION
        'Gate transition % → % on proposal % requires a gate decision. '
        'Submit a gate review (proposal_reviews verdict=approve) or '
        'gate_decision_log (decision=advance) within the last 10 minutes before advancing.',
        OLD.status, NEW.status, NEW.id
        USING ERRCODE = 'check_violation';
END;
$fn$;

COMMENT ON FUNCTION roadmap_proposal.fn_guard_gate_advance() IS
    'P290 + P181: Enforces gated status transitions. Standard RFC: D1(DRAFT→REVIEW), '
    'D2(REVIEW→DEVELOP), D3(DEVELOP→MERGE), D4(MERGE→COMPLETE). '
    'governance-amendment adds DELIBERATION stage: D1(DRAFT→DELIBERATION), '
    'D2(DELIBERATION→REVIEW, 48h timing gate), D3(REVIEW→DEVELOP), '
    'D4(DEVELOP→MERGE), D5(MERGE→COMPLETE, human agent_type required). '
    'Bypass with SET LOCAL app.gate_bypass = ''true'' inside a transaction.';

-- ─── 10. Extend v_implicit_gate_ready — add DELIBERATION (AC-16) ─────────────
-- Type-aware CASE expressions ensure governance-amendment proposals at every
-- stage receive the correct gate key (D1–D5) and to_stage value.
CREATE OR REPLACE VIEW roadmap_proposal.v_implicit_gate_ready AS
SELECT p.id,
       p.display_id,
       p.type,
       p.status,
       p.maturity,
       p.title,
       p.summary,
       CASE
         WHEN p.type = 'governance-amendment' THEN
           CASE LOWER(p.status)
             WHEN 'draft'        THEN 'D1'
             WHEN 'deliberation' THEN 'D2'
             WHEN 'review'       THEN 'D3'
             WHEN 'develop'      THEN 'D4'
             WHEN 'merge'        THEN 'D5'
           END
         ELSE
           CASE LOWER(p.status)
             WHEN 'draft'   THEN 'D1'
             WHEN 'review'  THEN 'D2'
             WHEN 'develop' THEN 'D3'
             WHEN 'merge'   THEN 'D4'
           END
       END AS gate,
       CASE
         WHEN p.type = 'governance-amendment' THEN
           CASE LOWER(p.status)
             WHEN 'draft'        THEN 'DELIBERATION'
             WHEN 'deliberation' THEN 'Review'
             WHEN 'review'       THEN 'Develop'
             WHEN 'develop'      THEN 'Merge'
             WHEN 'merge'        THEN 'Complete'
           END
         ELSE
           CASE LOWER(p.status)
             WHEN 'draft'   THEN 'Review'
             WHEN 'review'  THEN 'Develop'
             WHEN 'develop' THEN 'Merge'
             WHEN 'merge'   THEN 'Complete'
           END
       END AS to_stage,
       lease.agent_identity AS active_lease_agent,
       dispatch.id          AS active_gate_dispatch_id,
       p.modified_at
FROM roadmap_proposal.proposal p
LEFT JOIN LATERAL (
    SELECT pl.agent_identity
    FROM roadmap_proposal.proposal_lease pl
    WHERE pl.proposal_id = p.id
      AND pl.released_at IS NULL
    ORDER BY pl.claimed_at DESC
    LIMIT 1
) lease ON true
LEFT JOIN LATERAL (
    SELECT sd.id
    FROM roadmap_workforce.squad_dispatch sd
    WHERE sd.proposal_id    = p.id
      AND sd.dispatch_role  = 'gate-reviewer'
      AND sd.dispatch_status = 'active'
    ORDER BY sd.assigned_at DESC
    LIMIT 1
) dispatch ON true
WHERE p.maturity = 'mature'
  AND (
    LOWER(p.status) IN ('draft', 'review', 'develop', 'merge')
    OR (LOWER(p.status) = 'deliberation' AND p.type = 'governance-amendment')
  );

COMMENT ON VIEW roadmap_proposal.v_implicit_gate_ready IS
  'P240 + P181: derived gate-ready projection. Type-aware for governance-amendment: '
  'DELIBERATION stage included; gate/to_stage reflect the 6-stage workflow (D1–D5). '
  'proposal.status + proposal.maturity are lifecycle truth.';

-- ─── 11. Extend fn_notify_gate_ready for governance-amendment DELIBERATION ────
CREATE OR REPLACE FUNCTION roadmap.fn_notify_gate_ready()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_gate     text;
    v_to_state text;
BEGIN
    IF NEW.maturity = 'mature'
       AND OLD.maturity IS DISTINCT FROM 'mature' THEN

        IF NEW.type = 'governance-amendment' THEN
            CASE LOWER(NEW.status)
                WHEN 'draft'        THEN v_gate := 'D1'; v_to_state := 'DELIBERATION';
                WHEN 'deliberation' THEN v_gate := 'D2'; v_to_state := 'Review';
                WHEN 'review'       THEN v_gate := 'D3'; v_to_state := 'Develop';
                WHEN 'develop'      THEN v_gate := 'D4'; v_to_state := 'Merge';
                WHEN 'merge'        THEN v_gate := 'D5'; v_to_state := 'Complete';
                ELSE
                    PERFORM pg_notify('proposal_gate_ready', jsonb_build_object(
                        'proposal_id', NEW.id, 'display_id', NEW.display_id,
                        'stage', NEW.status, 'reason', 'no_gate_defined_for_state',
                        'source', 'implicit_maturity_gating',
                        'ts', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                    )::text);
                    RETURN NEW;
            END CASE;
        ELSE
            CASE LOWER(NEW.status)
                WHEN 'draft'   THEN v_gate := 'D1'; v_to_state := 'Review';
                WHEN 'review'  THEN v_gate := 'D2'; v_to_state := 'Develop';
                WHEN 'develop' THEN v_gate := 'D3'; v_to_state := 'Merge';
                WHEN 'merge'   THEN v_gate := 'D4'; v_to_state := 'Complete';
                ELSE
                    PERFORM pg_notify('proposal_gate_ready', jsonb_build_object(
                        'proposal_id', NEW.id, 'display_id', NEW.display_id,
                        'stage', NEW.status, 'reason', 'no_gate_defined_for_state',
                        'source', 'implicit_maturity_gating',
                        'ts', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                    )::text);
                    RETURN NEW;
            END CASE;
        END IF;

        PERFORM pg_notify('proposal_gate_ready', jsonb_build_object(
            'proposal_id', NEW.id,
            'display_id',  NEW.display_id,
            'gate',        v_gate,
            'from_stage',  NEW.status,
            'to_stage',    v_to_state,
            'source',      'implicit_maturity_gating',
            'ts',          to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        )::text);
    END IF;

    RETURN NEW;
END;
$$;

COMMIT;
