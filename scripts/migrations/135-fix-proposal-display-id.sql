-- env: prod
-- Fix proposal display_id mismatches: zero-padded early rows + off-by-N entries
--
-- Root cause: old fn_proposal_display_id used LPAD(v_id_text, 3, '0') — fixed
-- width of 3 truncates 4-digit ids (1000 → P100) and zero-pads small ids (44 → P044).
-- The function was later patched to GREATEST(3, LENGTH(v_id_text)) which prevented
-- future truncation but kept zero-padding and left existing bad rows in place.
-- Canonical format: 'P' || id::text with no zero-padding.

BEGIN;

-- 1. Fix the trigger function — remove zero-padding entirely
CREATE OR REPLACE FUNCTION fn_proposal_display_id()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.display_id IS NULL OR NEW.display_id = '' THEN
        NEW.display_id := 'P' || NEW.id::text;
    END IF;
    RETURN NEW;
END;
$$;

-- 2. Backfill all mismatched rows.
--    The unique constraint on display_id is non-deferrable, so chained off-by-N
--    rows (e.g. 523→P522, 524→P523, ...) conflict if updated in a single pass.
--    Two-phase: park affected rows at '__tmp_<id>', then flip to canonical 'P<id>'.
--    '__tmp_' prefix is guaranteed to not collide with any real display_id.

-- Phase A: move conflicting rows off their current P-values
UPDATE roadmap_proposal.proposal
SET    display_id = '__tmp_' || id::text
WHERE  display_id != 'P' || id::text;

-- Phase B: set to canonical format
UPDATE roadmap_proposal.proposal
SET    display_id = 'P' || id::text
WHERE  display_id LIKE '__tmp_%';

COMMIT;
