-- P1000 hotfix: proposal display IDs must not truncate or drift.
--
-- Postgres lpad(text, len, fill) truncates strings longer than len, so the
-- previous expression lpad(NEW.id::text, 3, '0') turned id=1000 into P100.
-- The follow-up expression GREATEST(3, LENGTH(id)) prevented truncation but
-- still preserved historical three-digit padding for ids >= 100. The canonical
-- format is P001..P099, then P100, P101, ..., P1000.

CREATE OR REPLACE FUNCTION roadmap.fn_proposal_display_id() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.display_id IS NULL OR NEW.display_id = '' THEN
        NEW.display_id := 'P' || CASE
            WHEN NEW.id < 100 THEN LPAD(NEW.id::text, 3, '0')
            ELSE NEW.id::text
        END;
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION roadmap.fn_proposal_display_id() IS
    'Auto-fills proposal display_id as P001..P099, then P100+ without truncation.';

-- Repair existing mismatches in two phases to avoid unique constraint conflicts
-- when rows are offset, for example 404 -> P403, 405 -> P404, 406 -> P405.
UPDATE roadmap_proposal.proposal
   SET display_id = '__p1000_fix__' || id::text
 WHERE display_id IS DISTINCT FROM 'P' || CASE
       WHEN id < 100 THEN LPAD(id::text, 3, '0')
       ELSE id::text
   END;

UPDATE roadmap_proposal.proposal
   SET display_id = 'P' || CASE
       WHEN id < 100 THEN LPAD(id::text, 3, '0')
       ELSE id::text
   END
 WHERE display_id LIKE '__p1000_fix__%';

DO $$
BEGIN
    IF 'P' || LPAD(7::text, 3, '0') <> 'P007' THEN
        RAISE EXCEPTION 'display_id regression: id 7 did not format as P007';
    END IF;

    IF 'P' || 1000::text <> 'P1000' THEN
        RAISE EXCEPTION 'display_id regression: id 1000 did not format as P1000';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM roadmap_proposal.proposal
         WHERE display_id IS DISTINCT FROM 'P' || CASE
               WHEN id < 100 THEN LPAD(id::text, 3, '0')
               ELSE id::text
           END
    ) THEN
        RAISE EXCEPTION 'display_id regression: mismatched display_id rows remain';
    END IF;
END;
$$;
