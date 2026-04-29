-- Migration 064: Directive Proposal Type (P188)
-- AC-1: Register 'directive' term in reference catalog (idempotent — already in DDL seed)
-- AC-2: Bind 'directive' type to 'Standard RFC' workflow via proposal_type_config

BEGIN;

-- ── AC-1: Ensure directive term exists in reference catalog ──────────────────
INSERT INTO roadmap.reference_term (domain_key, term_key, label, ordinal)
VALUES ('proposal_type', 'directive', 'Directive', 5)
ON CONFLICT (domain_key, term_key) DO NOTHING;

-- ── AC-2: Bind directive type to Standard RFC workflow ────────────────────────
-- 'directive' shares the Standard RFC workflow (DRAFT→REVIEW→DEVELOP→…→COMPLETE).
-- proposal_valid_transitions rows for 'Standard RFC' already cover all states.
INSERT INTO roadmap_proposal.proposal_type_config (type, workflow_name, description)
VALUES (
  'directive',
  'Standard RFC',
  'Human-issued command with elevated priority; semantic conflict detection applied at creation'
)
ON CONFLICT (type) DO UPDATE SET
  workflow_name = EXCLUDED.workflow_name,
  description   = EXCLUDED.description;

COMMIT;
