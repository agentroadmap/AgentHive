-- P188: Directive Proposal Type
-- Migration 209: Register 'directive' as a first-class proposal type
-- with RFC workflow and enhanced dispatch priority.
--
-- Directives are human-issued commands with:
-- - Elevated dispatch priority (1.5× multiplier, stored in priority column)
-- - Automatic conflict detection (core/proposal/directive-conflict-detector.ts)
-- - Standard RFC workflow (DRAFT → REVIEW → DEVELOP → MERGE → COMPLETE)
--
-- Depends on P187 (Reference Catalog) providing reference_domain and reference_term tables.
-- Database/migrations/059-p188-directive-proposal-type.sql (targets wrong table roadmap.reference_terms)
-- is DEAD CODE and must be deleted from git history.

BEGIN;

-- AC-1: Seed 'directive' into roadmap.reference_term catalog
INSERT INTO roadmap.reference_term (domain_key, term_key, label, description, ordinal)
VALUES ('proposal_type', 'directive', 'Directive', 'Human-issued command with elevated priority and conflict detection', 5)
ON CONFLICT (domain_key, term_key) DO NOTHING;

-- AC-2: Bind 'directive' to Standard RFC workflow in proposal_type_config
INSERT INTO roadmap_proposal.proposal_type_config (type, workflow_name, description)
VALUES ('directive', 'Standard RFC', 'Human-issued command with elevated dispatch priority (1.5x) and automatic conflict detection')
ON CONFLICT (type) DO UPDATE SET
  workflow_name = EXCLUDED.workflow_name,
  description = EXCLUDED.description;

-- Verify: 1 row in reference_term for directive
-- SELECT COUNT(*) FROM roadmap.reference_term WHERE domain_key='proposal_type' AND term_key='directive';
-- Expected: 1

-- Verify: 1 row in proposal_type_config for directive
-- SELECT COUNT(*) FROM roadmap_proposal.proposal_type_config WHERE type='directive' AND workflow_name='Standard RFC';
-- Expected: 1

COMMIT;
