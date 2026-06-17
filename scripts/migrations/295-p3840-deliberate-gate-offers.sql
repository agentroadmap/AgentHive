-- 295-p3840-deliberate-gate-offers.sql  (P3840 Part 2)
--
-- Operator directive (2026-06-17): "Remove auto-gating pipeline, add D1–D4
-- gating to the orchestrator job-offer list."
--
-- Migration 294 already DELETED the gate-DECISION roles (reviewer-d1..d4,
-- gate_decision_agent, merge_decision_agent, gate-agent, gate-reviewer) that
-- auto-advanced mature proposals. This migration finishes the job:
--
--   (A) REMOVE the remaining mature WORK roles. After 294, getRolesForQueue
--       still returns work agents (architect/skeptic/qa/maintainer) for
--       maturity='mature', so the orchestrator keeps dispatching them and
--       RE-WORKS proposals that are already done — churn. Mature means
--       "finished, waiting for a gate decision," not "re-review forever."
--       These are deleted so scanQueues no longer dispatches work for mature.
--
--   (B) ADD one deliberate `gate-review` role per gate for maturity='mature'.
--       Each carries required_capabilities=['gate_review']. The ONLY identity
--       that advertises the `gate_review` job is the dedicated `gate-desk`
--       agency (scripts/seed-gate-desk-agency.sql), which is NOT in
--       AGENTHIVE_SELF_CLAIM_AGENCIES — so the offer posts OPEN and is NEVER
--       auto-claimed by the worker liaison pool and NEVER auto-decided. A
--       qualified gater (operator via board, or an authority-granted gating
--       identity) claims the open offer and calls gate_decision deliberately.
--
-- Gate→stage mapping mirrors inferGateForState() in legacy-dispatch.ts:
--   Standard RFC (14): DRAFT=D1, REVIEW=D2, DEVELOP=D3, MERGE=D4.
--   Hotfix      (37): DRAFT=D1, DEVELOP=D3   (REVIEW/MERGE are skipped).
--
-- DORMANT-BY-DEFAULT: the whole behavior is flag-gated by
-- AGENTHIVE_DELIBERATE_GATE_OFFERS_ENABLED (default OFF). getRolesForQueue
-- FILTERS OUT gate_review-capability roles while the flag is OFF, so applying
-- this migration changes nothing observable until the operator (1) seeds the
-- gate-desk agency and (2) flips the flag ON. With the flag OFF, mature
-- proposals simply resolve to an EMPTY role set (work roles removed, gate-review
-- roles filtered) and no offers post — strictly less churn than today, never more.
--
-- Control-plane config; getRolesForQueue reads the table live (no restart).

BEGIN;

-- ─── (A) Remove ALL remaining global mature WORK roles ───────────────────────
-- Mature = "finished, waiting for a gate decision" — it must NOT be re-worked.
-- Remove EVERY existing global mature work role (the live set after migration 294
-- is: developer, qa, skeptic-beta, drafter, enrichment_agent, maintainer,
-- architect, reviewer, skeptic-alpha across templates 14+37). Excluding
-- role='gate-review' future-proofs re-runs; at this point (pre-(B)) there are no
-- gate-review rows yet, so this clears the full mature work set. Scoped to
-- scope='global' so project-scoped overrides and all new/active build roles are
-- untouched.

DELETE FROM roadmap.agent_role_profile
WHERE scope = 'global'
  AND maturity = 'mature'
  AND role <> 'gate-review';

-- ─── (B) Add deliberate gate-review roles (maturity='mature') ────────────────
-- required_capabilities = ['gate_review'] (jsonb-array semantics; stored in the
-- TEXT[] column). prompt_template instructs a DELIBERATE decision: verify the
-- gate's quorum/evidence, then advance / request_for_change / reject per the
-- P1391 three-verdict vocabulary. priority=5 so it is the primary (and only)
-- mature profile resolved by getRolesForQueue.

INSERT INTO roadmap.agent_role_profile
    (scope, project_id, workflow_template_id, stage, maturity, role,
     required_capabilities, prompt_template, priority)
VALUES
    -- Standard RFC (14)
    ('global', NULL, 14, 'DRAFT',   'mature', 'gate-review', ARRAY['gate_review'],
     '{"gate":"D1","from_stage":"DRAFT","to_stage":"REVIEW","mode":"deliberate_gate","system":"You are a DELIBERATE D1 gate. This is NOT an auto-advance. Verify the spec is coherent and the acceptance criteria are well-formed and measurable; confirm the proposal has the required review quorum and no unresolved blocking concerns. Then record ONE decision via gate_decision using the P1391 vocabulary: advance (DRAFT->REVIEW), request_for_change (send back to maturity=new with concrete feedback), or reject (authority-gated, ->obsolete). Cite evidence. Do nothing automatically."}',
     5),
    ('global', NULL, 14, 'REVIEW',  'mature', 'gate-review', ARRAY['gate_review'],
     '{"gate":"D2","from_stage":"REVIEW","to_stage":"DEVELOP","mode":"deliberate_gate","system":"You are a DELIBERATE D2 gate. Verify the design is buildable: dependencies resolved, integration constraints respected, rollback path sound, and the review quorum (incl. a skeptic) is satisfied with no blocking reviews. Record ONE gate_decision (advance/request_for_change/reject) per P1391 with cited evidence. Never advance automatically."}',
     5),
    ('global', NULL, 14, 'DEVELOP', 'mature', 'gate-review', ARRAY['gate_review'],
     '{"gate":"D3","from_stage":"DEVELOP","to_stage":"MERGE","mode":"deliberate_gate","system":"You are a DELIBERATE D3 gate. Verify the IMPLEMENTATION against running code: promised artifacts are tracked in git, the migration slot is free, tests pass, and every acceptance criterion is verified with concrete evidence (test name / query result / file:line). Record ONE gate_decision (advance/request_for_change/reject) per P1391. Never advance automatically."}',
     5),
    ('global', NULL, 14, 'MERGE',   'mature', 'gate-review', ARRAY['gate_review'],
     '{"gate":"D4","from_stage":"MERGE","to_stage":"COMPLETE","mode":"deliberate_gate","system":"You are a DELIBERATE D4 gate. Verify the merge is clean and the change is deployable: branch merged to main, tests green, no slot collisions, migrations applied/ledgered. Record ONE gate_decision (advance->COMPLETE / request_for_change / reject) per P1391 with evidence. Never advance automatically."}',
     5),
    -- Hotfix (37) — REVIEW and MERGE are skipped (inferGateForState)
    ('global', NULL, 37, 'DRAFT',   'mature', 'gate-review', ARRAY['gate_review'],
     '{"gate":"D1","from_stage":"DRAFT","to_stage":"FIX","mode":"deliberate_gate","system":"You are a DELIBERATE D1 hotfix gate (TRIAGE->FIX). Confirm the defect is reproduced and the fix scope is agreed. Record ONE gate_decision (advance/request_for_change/reject) per P1391 with evidence. Never advance automatically."}',
     5),
    ('global', NULL, 37, 'DEVELOP', 'mature', 'gate-review', ARRAY['gate_review'],
     '{"gate":"D3","from_stage":"DEVELOP","to_stage":"DEPLOYED","mode":"deliberate_gate","system":"You are a DELIBERATE D3 hotfix gate (FIX->DEPLOYED). Confirm the patch landed, the regression test passes, and the fix is deployable. Record ONE gate_decision (advance/request_for_change/reject) per P1391 with evidence. Never advance automatically."}',
     5)
-- Conflict target is the PARTIAL unique index uq_agent_role_profile_global
-- (workflow_template_id, stage, maturity, role) WHERE scope='global' AND
-- project_id IS NULL — inferred via the column list + matching predicate.
ON CONFLICT (workflow_template_id, stage, maturity, role)
    WHERE scope = 'global' AND project_id IS NULL
DO UPDATE SET
    required_capabilities = EXCLUDED.required_capabilities,
    prompt_template       = EXCLUDED.prompt_template,
    priority              = EXCLUDED.priority,
    updated_at            = now();

COMMIT;
