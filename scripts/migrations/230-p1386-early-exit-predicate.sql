-- P1386 AC-5: Generalize architect early-exit pattern via role_early_exit_predicate table
--
-- The architect role has an early-exit precondition (v_architect_early_exit) that
-- allows it to skip spawning when all ACs pass, design is substantive, and no
-- open challenges remain.
--
-- This migration introduces a mapping table role_early_exit_predicate(role, predicate_name)
-- so that other roles (e.g., skeptic-beta) can reuse the same pattern without
-- duplicating the offer-dispatch layer logic. The offer-dispatch resolver will
-- dynamically look up the predicate name and evaluate it if present.
--
-- Future roles needing early-exit behavior will insert a row here + define their
-- predicate function (e.g., v_skeptic_beta_early_exit).

BEGIN;

-- Create the role_early_exit_predicate table to store role -> predicate mapping.
CREATE TABLE IF NOT EXISTS roadmap_proposal.role_early_exit_predicate (
	id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	role TEXT NOT NULL,
	predicate_name TEXT NOT NULL UNIQUE,
	description TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique constraint: each role can have at most one active predicate
CREATE UNIQUE INDEX IF NOT EXISTS idx_role_early_exit_predicate_role
	ON roadmap_proposal.role_early_exit_predicate (role);

-- Populate with the architect predicate (already defined as v_architect_early_exit)
INSERT INTO roadmap_proposal.role_early_exit_predicate (role, predicate_name, description)
VALUES (
	'architect',
	'roadmap_proposal.v_architect_early_exit',
	'Architect early-exit: all ACs pass/waived, design >= 200 chars, no open design_gap discussions newer than last edit'
)
ON CONFLICT (role) DO NOTHING;

-- Update trigger for role_early_exit_predicate to maintain updated_at
CREATE OR REPLACE FUNCTION roadmap_proposal.update_role_early_exit_predicate_timestamp()
RETURNS TRIGGER AS $$
BEGIN
	NEW.updated_at := now();
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_role_early_exit_predicate_timestamp ON roadmap_proposal.role_early_exit_predicate;
CREATE TRIGGER update_role_early_exit_predicate_timestamp
	BEFORE UPDATE ON roadmap_proposal.role_early_exit_predicate
	FOR EACH ROW
	EXECUTE FUNCTION roadmap_proposal.update_role_early_exit_predicate_timestamp();

COMMIT;
