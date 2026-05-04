-- P466: Fallback playbook — agency scoping + seed universal class-level entries
--
-- The core roadmap.fallback_playbook table was created by migration 049
-- (error_signature NOT NULL, try_action NOT NULL, no agency_id column).
-- This migration adds agency scoping and seeds broad class-level remediations.

ALTER TABLE roadmap.fallback_playbook
  ADD COLUMN IF NOT EXISTS agency_id text;  -- NULL = global; non-NULL scopes to one agency

CREATE INDEX IF NOT EXISTS fallback_playbook_agency_idx
  ON roadmap.fallback_playbook (agency_id)
  WHERE agency_id IS NOT NULL;

COMMENT ON COLUMN roadmap.fallback_playbook.agency_id IS
'NULL = applies to all agencies. Set to scope this entry to a single agency (overrides global).';

-- Seed universal class-level entries.
-- Convention: error_signature = 'class:{error_class}' for broad class matches.
-- checkFallbackPlaybook() in liaison-watchdog.ts recognizes this prefix and matches
-- them when error_class parameter equals the suffix.
INSERT INTO roadmap.fallback_playbook (error_signature, error_class, try_action, confidence)
VALUES
  ('class:ENOENT', 'ENOENT',
   'The file or path does not exist. Verify the exact path before proceeding. Use list/search tools to confirm the filesystem state before retrying.',
   0.85),
  ('class:EACCES', 'EACCES',
   'Permission denied. The operation may require elevated privileges. Check file ownership and permissions; consider an alternative path or approach.',
   0.80),
  ('class:TypeError', 'TypeError',
   'A type error occurred. Validate that all inputs are the expected type and non-null before the operation. Check for undefined intermediate values.',
   0.75),
  ('class:timeout', 'timeout',
   'The operation timed out. Check network connectivity and service health. Retry with exponential backoff or switch to an alternative approach.',
   0.80),
  ('class:ReferenceError', 'ReferenceError',
   'A variable or property was referenced before it was defined. Check your import statements and initialization order.',
   0.70),
  ('class:SyntaxError', 'SyntaxError',
   'A syntax error was detected in generated code. Review the output carefully and ensure balanced brackets, quotes, and statement terminators.',
   0.75)
ON CONFLICT DO NOTHING;
