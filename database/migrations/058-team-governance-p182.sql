-- Migration 058: Team Governance Layer (P182)
-- Ostrom Principle 8 — Nested Enterprises: adds the missing team governance layer.
-- Proposal: P182
-- 2026-05-04

BEGIN;

-- ── 1. Add metadata JSONB to roadmap_workforce.team ───────────────────────────
-- Stores team norms, formation context, and governance state inline.
ALTER TABLE roadmap_workforce.team
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

-- ── 2. Create team_norms table ────────────────────────────────────────────────
-- Explicit norm records per team. Complements the inline metadata column
-- for norm categories that need their own audit trail.
CREATE TABLE IF NOT EXISTS roadmap_workforce.team_norms (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    team_id       BIGINT NOT NULL REFERENCES roadmap_workforce.team(id) ON DELETE CASCADE,
    norm_key      TEXT NOT NULL,           -- e.g. "team:norm:handoff"
    norm_value    JSONB NOT NULL DEFAULT '{}',
    set_by        TEXT NOT NULL,           -- agent_identity that set the norm
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT team_norms_key_unique UNIQUE (team_id, norm_key)
);

CREATE INDEX IF NOT EXISTS idx_team_norms_team_id
    ON roadmap_workforce.team_norms (team_id);

-- ── 3. Add team_resolved status to agent_conflicts ────────────────────────────
-- Allows disputes settled at team level (L3) to be distinguished from
-- society-escalated resolutions.
ALTER TABLE roadmap_workforce.agent_conflicts
    DROP CONSTRAINT IF EXISTS agent_conflicts_status_check;

ALTER TABLE roadmap_workforce.agent_conflicts
    ADD CONSTRAINT agent_conflicts_status_check
    CHECK (status = ANY (ARRAY[
        'open'::text,
        'escalated'::text,
        'resolved'::text,
        'team_resolved'::text,
        'dismissed'::text
    ]));

-- ── 4. Disputes escalation-level tracking ────────────────────────────────────
ALTER TABLE roadmap_workforce.agent_conflicts
    ADD COLUMN IF NOT EXISTS escalation_level TEXT
        CHECK (escalation_level IS NULL OR escalation_level = ANY (ARRAY[
            'L1'::text, 'L2'::text, 'L3'::text, 'L4'::text
        ])),
    ADD COLUMN IF NOT EXISTS team_id BIGINT REFERENCES roadmap_workforce.team(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS resolution_note TEXT;

COMMENT ON COLUMN roadmap_workforce.agent_conflicts.escalation_level IS
    'L1=self, L2=peer, L3=team, L4=society';
COMMENT ON COLUMN roadmap_workforce.agent_conflicts.team_id IS
    'Team that handled this dispute (for team_resolved cases)';

COMMIT;
