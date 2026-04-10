-- =============================================
-- Migration 002: RFC Workflow Tables
-- Purpose: Structured RFC lifecycle — review, approval, dependencies
-- Date: 2026-04-04
-- Author: Gilbert (Git Workflow Master)
-- =============================================

BEGIN;

-- RFC table (1:1 extension of proposal)
CREATE TABLE IF NOT EXISTS rfc (
    id              bigint PRIMARY KEY REFERENCES proposal(id) ON DELETE CASCADE,
    display_id      text UNIQUE NOT NULL,
    domain_id       text,
    status          text NOT NULL DEFAULT 'DRAFT',
    maturity_level  int DEFAULT 0,
    parent_rfc_id   bigint REFERENCES rfc(id) ON DELETE SET NULL,
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now()
);

-- Review entries (multi-reviewer approval tracking)
CREATE TABLE IF NOT EXISTS rfc_review (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    rfc_id          bigint REFERENCES rfc(id) ON DELETE CASCADE NOT NULL,
    reviewer_id     text NOT NULL,
    status          text NOT NULL DEFAULT 'OPEN',
    comment         text,
    comment_markdown text,
    reviewed_at     timestamptz DEFAULT now()
);

-- Dependency graph (RFC A blocks RFC B)
CREATE TABLE IF NOT EXISTS rfc_dependency (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    rfc_id          bigint REFERENCES rfc(id) ON DELETE CASCADE NOT NULL,
    depends_on      bigint REFERENCES rfc(id) ON DELETE CASCADE NOT NULL,
    created_at      timestamptz DEFAULT now(),
    UNIQUE(rfc_id, depends_on)
);

-- Labels (dedicated table for filtering, extracted from RFC frontmatter)
CREATE TABLE IF NOT EXISTS rfc_label (
    rfc_id          bigint REFERENCES rfc(id) ON DELETE CASCADE,
    label           text NOT NULL,
    PRIMARY KEY (rfc_id, label)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_rfc_status ON rfc(status);
CREATE INDEX IF NOT EXISTS idx_rfc_domain ON rfc(domain_id);
CREATE INDEX IF NOT EXISTS idx_rfc_review_rfc ON rfc_review(rfc_id);
CREATE INDEX IF NOT EXISTS idx_rfc_review_status ON rfc_review(status);
CREATE INDEX IF NOT EXISTS idx_rfc_dependency_rfc ON rfc_dependency(rfc_id);

COMMIT;
