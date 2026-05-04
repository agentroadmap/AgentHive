-- P466: Fallback playbook for Liaison watchdog auto-remediation
-- Stores known error → directive mappings for automatic resolution without operator intervention.

CREATE TABLE IF NOT EXISTS roadmap.fallback_playbook (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  error_signature text,         -- 16-char SHA256 prefix of (tool, class, msg) — exact match
  error_class text,             -- broad class-level match (e.g. 'ENOENT', 'TypeError')
  agency_id text,               -- NULL = global; set to scope override to a specific agency
  directive text NOT NULL,      -- instruction sent to stuck agent
  confidence numeric NOT NULL DEFAULT 0.8 CHECK (confidence > 0 AND confidence <= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fallback_playbook_has_pattern CHECK (
    error_signature IS NOT NULL OR error_class IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS fallback_playbook_sig_idx
  ON roadmap.fallback_playbook (error_signature)
  WHERE error_signature IS NOT NULL;

CREATE INDEX IF NOT EXISTS fallback_playbook_class_idx
  ON roadmap.fallback_playbook (error_class)
  WHERE error_class IS NOT NULL;

COMMENT ON TABLE roadmap.fallback_playbook IS
'Known error → remediation directive mappings for Liaison auto-remediation.
Agency-specific entries override global ones. Exact signature match takes precedence over class match.';

-- Seed universal playbook entries
INSERT INTO roadmap.fallback_playbook (error_class, directive, confidence) VALUES
  ('ENOENT',
   'The file or path does not exist. Verify the exact path before proceeding. Use list/search tools to confirm the filesystem state before retrying.',
   0.85),
  ('EACCES',
   'Permission denied. The operation may require elevated privileges. Check file ownership and permissions; consider an alternative path or approach.',
   0.80),
  ('TypeError',
   'A type error occurred. Validate that all inputs are the expected type and non-null before the operation. Check for undefined intermediate values.',
   0.75),
  ('timeout',
   'The operation timed out. Check network connectivity and service health. Retry with exponential backoff or switch to an alternative approach.',
   0.80),
  ('ReferenceError',
   'A variable or property was referenced before it was defined. Check your import statements and initialization order.',
   0.70),
  ('SyntaxError',
   'A syntax error was detected in generated code. Review the output carefully and ensure balanced brackets, quotes, and statement terminators.',
   0.75);
