-- P1003: Restore Architecture RFC Workflow Registry
--
-- Migration 205: Update architecture proposal type to use the Architecture RFC workflow
-- with correct Draft→Review→Complete stages (not Standard RFC).
--
-- Key changes:
-- 1. Update proposal_type_config to bind 'architecture' to 'Architecture RFC'
-- 2. Add valid transitions: Draft→Review, Review→Complete
-- 3. Backfill existing architecture proposals to correct workflow

BEGIN;

-- ============================================================================
-- AC-1: Verify Architecture RFC template exists with correct stages
-- ============================================================================
-- Query only - no changes needed. Architecture RFC template already exists as:
-- id=54, name='Architecture RFC', with stages:
--   Draft (stage_order=1)
--   Review (stage_order=2)
--   Complete (stage_order=3)

-- ============================================================================
-- AC-2: Update proposal_type_config to map 'architecture' → 'Architecture RFC'
-- ============================================================================
UPDATE roadmap_proposal.proposal_type_config
SET workflow_name = 'Architecture RFC',
    updated_at = now()
WHERE type = 'architecture'
  AND workflow_name = 'Standard RFC';

-- ============================================================================
-- AC-3: Add valid transitions for Architecture RFC workflow
-- ============================================================================
-- Draft → Review (allows advancement after design and research)
INSERT INTO roadmap_proposal.proposal_valid_transitions
  (workflow_name, from_state, to_state, allowed_reasons, allowed_roles, requires_ac)
VALUES
  ('Architecture RFC', 'DRAFT', 'REVIEW', ARRAY['design_complete', 'ready_for_review'], NULL, 'none')
ON CONFLICT (workflow_name, from_state, to_state) DO NOTHING;

-- Review → Complete (allows closure after gating approval)
INSERT INTO roadmap_proposal.proposal_valid_transitions
  (workflow_name, from_state, to_state, allowed_reasons, allowed_roles, requires_ac)
VALUES
  ('Architecture RFC', 'REVIEW', 'COMPLETE', ARRAY['gate_approved', 'decision_made', 'deployment_ready'], NULL, 'none')
ON CONFLICT (workflow_name, from_state, to_state) DO NOTHING;

-- ============================================================================
-- AC-4: Backfill existing architecture proposals to Architecture RFC workflow
--
-- Safe mappings (proposal status names align across workflows):
--   DRAFT → DRAFT (both present in Standard RFC and Architecture RFC)
--   REVIEW → REVIEW (both present)
--   COMPLETE → COMPLETE (both present)
--
-- Unsafe (no target state in Architecture RFC):
--   DEVELOP → DEVELOP (not a stage in Architecture RFC)
--   MERGE → MERGE (not a stage in Architecture RFC)
--
-- Strategy: Update workflows for proposals in DRAFT/REVIEW/COMPLETE states only.
-- Proposals in DEVELOP/MERGE will remain on Standard RFC (audit required).
--
-- Note: current_stage values may be lowercase or uppercase; we normalize to
-- Architecture RFC stage names during backfill.
-- ============================================================================

UPDATE roadmap.workflows w
SET template_id = 54,  -- Architecture RFC template
    -- Map current_stage to Architecture RFC stage names (case-insensitive)
    current_stage = CASE
      WHEN UPPER(w.current_stage) = 'DRAFT' THEN 'Draft'
      WHEN UPPER(w.current_stage) = 'REVIEW' THEN 'Review'
      WHEN UPPER(w.current_stage) = 'COMPLETE' THEN 'Complete'
      ELSE w.current_stage  -- Keep as-is if not recognized
    END
FROM roadmap_proposal.proposal p
WHERE w.proposal_id = p.id
  AND p.type = 'architecture'
  AND w.template_id = 14  -- Currently on Standard RFC (id=14)
  AND p.status IN ('DRAFT', 'REVIEW', 'COMPLETE');

-- ============================================================================
-- AC-4 Audit: Log proposals that remain on Standard RFC (unsafe backfill)
--
-- These proposals need manual review and decision:
-- SELECT p.id, p.title, p.status, w.current_stage
-- FROM roadmap_proposal.proposal p
-- JOIN roadmap.workflows w ON w.proposal_id = p.id
-- WHERE p.type = 'architecture'
--   AND w.template_id = 14  -- Still on Standard RFC
--   AND p.status IN ('DEVELOP', 'MERGE');
-- ============================================================================

COMMIT;
