-- Patch migration: Handle existing tables gracefully
BEGIN;

-- 1. Extend proposal with RFC workflow columns
ALTER TABLE proposal ADD COLUMN IF NOT EXISTS rfc_state text
    CHECK (rfc_state IS NULL OR rfc_state IN ('DRAFT','REVIEW','DEVELOP','MERGE','COMPLETE'));
ALTER TABLE proposal ADD COLUMN IF NOT EXISTS maturity_queue_position int DEFAULT 0;
ALTER TABLE proposal ADD COLUMN IF NOT EXISTS blocked_by_dependencies boolean DEFAULT false;
ALTER TABLE proposal ADD COLUMN IF NOT EXISTS accepted_criteria_count int DEFAULT 0;
ALTER TABLE proposal ADD COLUMN IF NOT EXISTS required_criteria_count int DEFAULT 0;
ALTER TABLE proposal ADD COLUMN IF NOT EXISTS priority int DEFAULT 5;

-- 2. State transition audit trail (CREATE IF NOT EXISTS)
CREATE TABLE IF NOT EXISTS proposal_state_transitions (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    proposal_id     bigint NOT NULL REFERENCES proposal(id) ON DELETE CASCADE,
    transitioned_by text NOT NULL,
    from_state      text NOT NULL,
    to_state        text NOT NULL,
    reason          text NOT NULL,
    emoji           text,
    notes           text,
    depends_on_id   bigint REFERENCES proposal(id),
    maturity_before int,
    maturity_after  int,
    transitioned_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_state_transitions_proposal ON proposal_state_transitions(proposal_id);
CREATE INDEX IF NOT EXISTS idx_state_transitions_state ON proposal_state_transitions(to_state);
CREATE INDEX IF NOT EXISTS idx_state_transitions_created ON proposal_state_transitions(transitioned_at DESC);

-- 3. Acceptance criteria (new table)
CREATE TABLE IF NOT EXISTS proposal_criteria (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    proposal_id     bigint NOT NULL REFERENCES proposal(id) ON DELETE CASCADE,
    item_number     int NOT NULL,
    criterion_text  text NOT NULL,
    status          text NOT NULL DEFAULT 'pending',
    verified_by     text,
    verification_notes text,
    verified_at     timestamptz,
    created_at      timestamptz DEFAULT now(),
    UNIQUE(proposal_id, item_number)
);
CREATE INDEX IF NOT EXISTS idx_criteria_proposal ON proposal_criteria(proposal_id, item_number);
CREATE INDEX IF NOT EXISTS idx_criteria_status ON proposal_criteria(status);

-- 4. Dependencies (existing table — add missing columns)
ALTER TABLE proposal_dependencies ADD COLUMN IF NOT EXISTS resolved boolean DEFAULT false;
ALTER TABLE proposal_dependencies ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_deps_from ON proposal_dependencies(from_proposal_id) WHERE resolved = false;
CREATE INDEX IF NOT EXISTS idx_deps_to ON proposal_dependencies(to_proposal_id);

-- 5. Reviews (existing table — add missing columns)
ALTER TABLE proposal_reviews ADD COLUMN IF NOT EXISTS comment text;
ALTER TABLE proposal_reviews ADD COLUMN IF NOT EXISTS is_blocking boolean DEFAULT false;
-- Double-vote prevention: UNIQUE on (proposal_id, reviewer_identity)
ALTER TABLE proposal_reviews ADD CONSTRAINT proposal_reviews_unique_reviewer
    UNIQUE NULLS NOT DISTINCT (proposal_id, reviewer_identity);
CREATE INDEX IF NOT EXISTS idx_reviews_blocking ON proposal_reviews(proposal_id) WHERE is_blocking = true;

-- 6. Discussions (existing table — add body_markdown alias)
ALTER TABLE proposal_discussions ADD COLUMN IF NOT EXISTS body_markdown text;

-- 7. Version tracking (new table)
CREATE TABLE IF NOT EXISTS proposal_versions (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    proposal_id     bigint NOT NULL REFERENCES proposal(id) ON DELETE CASCADE,
    version_number  int NOT NULL,
    body_markdown   text NOT NULL,
    diff_summary    text,
    git_sha         text,
    committed_by    text NOT NULL,
    committed_at    timestamptz DEFAULT now(),
    UNIQUE(proposal_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_versions_proposal ON proposal_versions(proposal_id, version_number DESC);

-- 8. Labels (new table)
CREATE TABLE IF NOT EXISTS proposal_labels (
    proposal_id     bigint REFERENCES proposal(id) ON DELETE CASCADE,
    label           text NOT NULL,
    PRIMARY KEY (proposal_id, label)
);
CREATE INDEX IF NOT EXISTS idx_labels_label ON proposal_labels(label);

COMMIT;
