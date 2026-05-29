-- P707: AC Evidence Columns
-- Adds structured evidence payload storage to proposal_acceptance_criteria.
-- details:                JSONB  — category-specific evidence object (nullable; NULL = legacy/unverified)
-- details_schema_version: TEXT   — schema version tag populated on every new verify_ac call (e.g. 'v1')
-- Both columns are nullable so existing rows are not affected.

ALTER TABLE roadmap_proposal.proposal_acceptance_criteria
    ADD COLUMN IF NOT EXISTS details JSONB,
    ADD COLUMN IF NOT EXISTS details_schema_version TEXT;

-- Partial index for fast phantom-pass detection queries used by AutoEvaluator.
CREATE INDEX IF NOT EXISTS idx_ac_passed_no_evidence
    ON roadmap_proposal.proposal_acceptance_criteria (proposal_id)
    WHERE status = 'pass' AND details IS NULL;
