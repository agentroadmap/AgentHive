-- Migration 141: P181 — Governance Amendment workflow type
-- Adds the 'governance-amendment' proposal type with a 6-stage workflow:
--   DRAFT → DELIBERATION (48h wait) → REVIEW (Skeptic quorum) → DEVELOP → MERGE (human-only) → COMPLETE
-- Extends fn_guard_gate_advance() to enforce DELIBERATION timing and MERGE human-approval constraints.
-- Also extends gate_role_gate_check and gate_task_templates constraints to allow gate D5.

BEGIN;

-- ── 1. Workflow template ─────────────────────────────────────────────────────
INSERT INTO roadmap.workflow_templates (name, description, stage_count, is_system)
VALUES (
    'Governance Amendment',
    'Elevated workflow for constitutional and governance rule changes — 6 stages, mandatory 48-hour deliberation period, Skeptic quorum at REVIEW, human-only approval at MERGE.',
    6,
    false
)
ON CONFLICT (name) DO NOTHING;

-- ── 2. Workflow stages (6 stages) ────────────────────────────────────────────
INSERT INTO roadmap.workflow_stages (template_id, stage_name, stage_order, maturity_gate, requires_ac, gating_config)
SELECT
    t.id,
    v.stage_name,
    v.stage_order,
    2 AS maturity_gate,
    v.requires_ac,
    v.gating_config::jsonb
FROM roadmap.workflow_templates t
CROSS JOIN (VALUES
    ('DRAFT',         1, true::boolean,  '{"requires_section_reference": true}'::text),
    ('DELIBERATION',  2, false::boolean, '{"min_wait_hours": 48, "blocking_concerns_check": true}'),
    ('REVIEW',        3, true::boolean,  '{"min_reviewers": 2, "required_roles": ["skeptic"], "distinct_agents": true}'),
    ('DEVELOP',       4, false::boolean, '{"dispatch": {"role": "developer", "tier": "senior"}}'),
    ('MERGE',         5, true::boolean,  '{"require_human_approver": true, "human_agent_type": "human"}'),
    ('COMPLETE',      6, false::boolean, '{"post_action": "update_constitutional_document"}')
) AS v(stage_name, stage_order, requires_ac, gating_config)
WHERE t.name = 'Governance Amendment'
ON CONFLICT (template_id, stage_name) DO NOTHING;

-- ── 3. Workflow transitions ──────────────────────────────────────────────────
INSERT INTO roadmap.workflow_transitions (template_id, from_stage, to_stage, labels, allowed_roles, requires_ac)
SELECT
    t.id,
    v.from_stage,
    v.to_stage,
    v.labels::text[],
    v.allowed_roles::text[],
    v.requires_ac::boolean
FROM roadmap.workflow_templates t
CROSS JOIN (VALUES
    ('DRAFT',        'DELIBERATION', '{mature,submit}',         '{any}',              false::boolean),
    ('DELIBERATION', 'REVIEW',       '{mature,advance}',        '{PM,Skeptic}',       false),
    ('DELIBERATION', 'DRAFT',        '{block,concerns_raised}', '{any}',              false),
    ('REVIEW',       'DEVELOP',      '{approve}',               '{PM,Skeptic}',       true),
    ('REVIEW',       'DELIBERATION', '{reject,revise}',         '{Skeptic}',          false),
    ('DEVELOP',      'MERGE',        '{mature,complete}',       '{PM,Architect}',     false),
    ('MERGE',        'COMPLETE',     '{approve}',               '{human}',            true),
    ('MERGE',        'REVIEW',       '{reject}',                '{human,Skeptic}',    false)
) AS v(from_stage, to_stage, labels, allowed_roles, requires_ac)
WHERE t.name = 'Governance Amendment'
ON CONFLICT (template_id, from_stage, to_stage) DO NOTHING;

-- ── 4. Proposal type config ──────────────────────────────────────────────────
-- roadmap.proposal_type_config is a VIEW over roadmap_proposal.proposal_type_config;
-- inserting into roadmap_proposal is sufficient for both read paths.
INSERT INTO roadmap_proposal.proposal_type_config (type, workflow_name, description, required_fields)
VALUES (
    'governance-amendment',
    'Governance Amendment',
    'Constitutional or governance rule change — elevated review, 48h deliberation, Skeptic quorum, human approval required.',
    ARRAY['summary']
)
ON CONFLICT (type) DO NOTHING;

-- ── 5. Valid transitions ─────────────────────────────────────────────────────
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

-- ── 6. Extend gate_role CHECK constraint to allow D5 ────────────────────────
ALTER TABLE roadmap_proposal.gate_role
    DROP CONSTRAINT IF EXISTS gate_role_gate_check;

ALTER TABLE roadmap_proposal.gate_role
    ADD CONSTRAINT gate_role_gate_check
    CHECK (gate = ANY (ARRAY['D1'::text, 'D2'::text, 'D3'::text, 'D4'::text, 'D5'::text]));

-- ── 7. Extend gate_task_templates numeric CHECK to allow gate_number=5 ───────
ALTER TABLE roadmap.gate_task_templates
    DROP CONSTRAINT IF EXISTS gate_task_templates_gate_number_check;

ALTER TABLE roadmap.gate_task_templates
    ADD CONSTRAINT gate_task_templates_gate_number_check
    CHECK (gate_number >= 1 AND gate_number <= 5);

-- ── 8. Gate role seeds (D1–D5) ───────────────────────────────────────────────
INSERT INTO roadmap_proposal.gate_role
    (proposal_type, gate, role, persona, output_contract,
     model_preference, tool_allow_list, fallback_role, lifecycle_status)
VALUES
  (
    'governance-amendment', 'D1', 'researcher',
    'You are the Governance Researcher gating DRAFT → DELIBERATION. Verify: '
    '(1) proposal.summary cites at least one constitutional Article/Section being modified; '
    '(2) AC list references the sections being changed; '
    '(3) a proposal_dependency link to the constitutional document (doc-9) is present. '
    'ADVANCE if all three pass. HOLD with specific missing items if not.',
    'section_reference_check: cite the missing Article/Section reference or doc-9 dependency. ADVANCE or HOLD only.',
    NULL, NULL, NULL, 'active'
  ),
  (
    'governance-amendment', 'D2', 'deliberation',
    'You are the Deliberation Monitor gating DELIBERATION → REVIEW. Check: '
    '(1) elapsed_hours >= 48 since DELIBERATION was entered — query proposal_state_transitions for '
    'the row WHERE to_state=''DELIBERATION'' ORDER BY transitioned_at DESC LIMIT 1 and compare to now(); '
    '(2) no discussion entries with blocking=true and status != ''resolved''. '
    'If elapsed < 48h, HOLD with elapsed_hours. If unresolved blocking concerns, list them.',
    'blocking_concern_check + wait_elapsed: HOLD if elapsed < 48h (include elapsed_hours) '
    'or unresolved concerns (include concern author + body). ADVANCE only when both conditions clear.',
    NULL, NULL, NULL, 'active'
  ),
  (
    'governance-amendment', 'D3', 'skeptic',
    'You are CONSTITUTIONAL SKEPTIC gating REVIEW → DEVELOP. Requirements: '
    '(1) minimum 2 distinct reviewer agents must have approved, including at least one with role=skeptic; '
    '(2) no unresolved blocking reviews. Reject same-agent double-counts — '
    'reviewer_identity uniqueness is enforced by proposal_reviews constraint. '
    'Verify quorum from gate_decision_log or proposal_reviews.',
    'approve|reject + quorum_count: emit current_approvers N, required 2, distinct=true. '
    'ADVANCE if quorum met and no blockers. REJECT with specific approver list if quorum not met.',
    NULL, NULL, NULL, 'active'
  ),
  (
    'governance-amendment', 'D4', 'reviewer',
    'You are the Code/AC Reviewer gating DEVELOP → MERGE for a governance amendment. Verify: '
    '(1) migration files exist and are correct for all schema changes declared in the design; '
    '(2) all ACs referencing code/schema changes are passing or have clear verification paths; '
    '(3) CONVENTIONS.md and AGENTS.md have been updated per Section 7 of design.',
    'advance|hold: cite specific ACs by item_number. Evidence: file:line for each checked artifact.',
    NULL, NULL, NULL, 'active'
  ),
  (
    'governance-amendment', 'D5', 'human',
    'You are the Human Steward (Gary) gating MERGE → COMPLETE for a governance-amendment. '
    'This is the final constitutional approval gate — only a registered human agent '
    '(agent_type=human) may approve. Review the full amendment: proposed constitutional text change, '
    'audit trail in gate_decision_log, deliberation thread summary. '
    'Approve only if the amendment text, rationale, and process all appear sound. '
    'REJECT returns to REVIEW.',
    'approve|reject: human-only. Approval atomically updates doc-9 at COMPLETE. '
    'Rejection routes back to REVIEW for revision.',
    NULL, NULL, NULL, 'active'
  )
ON CONFLICT (proposal_type, gate) WHERE lifecycle_status = 'active' DO NOTHING;

-- ── 9. Extend fn_guard_gate_advance() ────────────────────────────────────────
-- Adds governance-amendment type block:
--   • DRAFT→DELIBERATION and DELIBERATION→REVIEW are now gated transitions
--   • DELIBERATION→REVIEW: enforces 48-hour minimum wait
--   • MERGE→COMPLETE: enforces human-only approver (agent_type='human')
CREATE OR REPLACE FUNCTION roadmap_proposal.fn_guard_gate_advance()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
DECLARE
    v_gate_key       TEXT;
    v_has_decision   BOOLEAN;
    v_proposal_type  TEXT;
    v_entered_at     TIMESTAMPTZ;
BEGIN
    v_gate_key      := UPPER(OLD.status) || E'→' || UPPER(NEW.status);
    v_proposal_type := NEW.type;

    -- Determine whether this transition is a gated one.
    -- Standard gated transitions (all non-hotfix workflow types):
    IF v_gate_key NOT IN (
        E'DRAFT→REVIEW',
        E'REVIEW→DEVELOP',
        E'DEVELOP→MERGE',
        E'MERGE→COMPLETE'
    ) THEN
        -- governance-amendment has two extra gated transitions
        IF NOT (
            v_proposal_type = 'governance-amendment'
            AND v_gate_key IN (
                E'DRAFT→DELIBERATION',
                E'DELIBERATION→REVIEW'
            )
        ) THEN
            RETURN NEW;
        END IF;
    END IF;

    -- Allow orchestrator bypass within an explicit transaction
    IF current_setting('app.gate_bypass', true) = 'true' THEN
        RETURN NEW;
    END IF;

    -- ── Governance-amendment type-scoped checks ──────────────────────────────
    IF v_proposal_type = 'governance-amendment' THEN

        -- D2: DELIBERATION→REVIEW requires minimum 48-hour deliberation window
        IF v_gate_key = E'DELIBERATION→REVIEW' THEN
            SELECT transitioned_at INTO v_entered_at
              FROM roadmap_proposal.proposal_state_transitions
             WHERE proposal_id = NEW.id
               AND to_state = 'DELIBERATION'
             ORDER BY transitioned_at DESC
             LIMIT 1;

            IF v_entered_at IS NOT NULL
               AND EXTRACT(EPOCH FROM (now() - v_entered_at)) / 3600.0 < 48 THEN
                RAISE EXCEPTION
                    'governance_deliberation_wait_not_elapsed: elapsed_hours=%, required_hours=48',
                    ROUND(EXTRACT(EPOCH FROM (now() - v_entered_at)) / 3600.0, 1)
                    USING ERRCODE = 'check_violation';
            END IF;
        END IF;

        -- D5: MERGE→COMPLETE requires a human agent (agent_type='human') advance decision
        IF v_gate_key = E'MERGE→COMPLETE' THEN
            IF NOT EXISTS (
                SELECT 1
                  FROM roadmap_proposal.gate_decision_log gdl
                  JOIN roadmap_workforce.agent_registry ar
                    ON ar.agent_identity = gdl.decided_by
                 WHERE gdl.proposal_id = NEW.id
                   AND UPPER(gdl.from_state) = 'MERGE'
                   AND UPPER(gdl.to_state)   = 'COMPLETE'
                   AND gdl.decision          = 'advance'
                   AND ar.agent_type         = 'human'
                   AND gdl.created_at >= now() - INTERVAL '10 minutes'
            ) THEN
                RAISE EXCEPTION
                    'governance_human_approver_required: MERGE→COMPLETE requires agent_type=human approver'
                    USING ERRCODE = 'check_violation';
            END IF;
        END IF;

    END IF;
    -- ── End governance-amendment checks ─────────────────────────────────────

    -- Check gate_decision_log for a recent 'advance' decision
    SELECT EXISTS (
        SELECT 1
          FROM roadmap_proposal.gate_decision_log gdl
         WHERE gdl.proposal_id = NEW.id
           AND UPPER(gdl.from_state) = UPPER(OLD.status)
           AND UPPER(gdl.to_state)   = UPPER(NEW.status)
           AND gdl.decision = 'advance'
           AND gdl.created_at >= now() - INTERVAL '10 minutes'
    ) INTO v_has_decision;

    IF v_has_decision THEN
        RETURN NEW;
    END IF;

    -- Check proposal_reviews for an 'approve' verdict (within 10 minutes)
    SELECT EXISTS (
        SELECT 1
          FROM roadmap_proposal.proposal_reviews pr
         WHERE pr.proposal_id = NEW.id
           AND pr.verdict = 'approve'
           AND pr.reviewed_at >= now() - INTERVAL '10 minutes'
    ) INTO v_has_decision;

    IF v_has_decision THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'Gate transition % → % on proposal % requires a gate decision. '
        'Submit a gate review (proposal_reviews verdict=approve) or '
        'gate_decision_log (decision=advance) within the last 10 minutes before advancing.',
        OLD.status, NEW.status, NEW.id
        USING ERRCODE = 'check_violation';
END;
$function$;

COMMIT;
