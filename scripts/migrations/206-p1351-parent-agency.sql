-- Migration 206: Add nested agency support (parent_agency_id)
-- Proposal: P1351 - Nested agents under parent agencies (identity model)
--
-- Changes:
-- 1. Add parent_agency_id column (nullable self-referencing FK)
-- 2. Add unique constraint to enforce sibling deduplication
-- 3. Backfill logic is deferred to src/core/agency/migration/backfill-parent-agencies.ts

BEGIN;

-- 1. Add parent_agency_id column as nullable text FK pointing to agency_id
ALTER TABLE roadmap.agency
ADD COLUMN parent_agency_id text,
ADD CONSTRAINT fk_agency_parent_agency_id
  FOREIGN KEY (parent_agency_id) REFERENCES roadmap.agency(agency_id) ON DELETE SET NULL;

-- 2. Create unique constraint for sibling deduplication
-- Ensures that (parent_agency_id, agency_id) pairs are unique, allowing:
-- - Multiple children under same parent (parent_agency_id is same, agency_id differs)
-- - Root agencies (parent_agency_id IS NULL, no constraint on agency_id)
-- - No duplicate (parent, child) relationships
ALTER TABLE roadmap.agency
ADD CONSTRAINT unique_parent_child
  UNIQUE NULLS NOT DISTINCT (parent_agency_id, agency_id);

-- 3. Create index on parent_agency_id for efficient hierarchical queries
CREATE INDEX idx_agency_parent_agency_id ON roadmap.agency(parent_agency_id);

COMMIT;
