/**
 * P1352: Agent Personality Validation & Schema Extensions
 *
 * AC-1 & AC-2:
 * - Creates fn_validate_personality() function to validate the personality JSONB structure
 * - Adds CHECK constraint to roadmap_workforce.agent_registry for personality validation
 * - personality column already exists (P1355); this migration adds validation
 *
 * AC-4:
 * - Adds personality JSONB column to roadmap.spawn_briefing to carry personality data
 *   from agent_registry to spawn point (liaison injection)
 *
 * Required keys in personality JSONB:
 *   - vibe (string, ≤160 chars)
 *   - core_truths (string array, non-empty)
 *   - boundaries (string array, non-empty)
 *   - communication_style (string, ≤500 chars)
 *   - expertise (string array, valid roles only)
 */

-- Function to validate personality JSONB structure
CREATE OR REPLACE FUNCTION fn_validate_personality(personality JSONB)
RETURNS BOOLEAN AS $$
DECLARE
  vibe TEXT;
  core_truths JSONB;
  boundaries JSONB;
  communication_style TEXT;
  expertise JSONB;
BEGIN
  -- If personality is NULL, allow it (optional field)
  IF personality IS NULL THEN
    RETURN TRUE;
  END IF;

  -- Extract required fields
  vibe := personality ->> 'vibe';
  core_truths := personality -> 'core_truths';
  boundaries := personality -> 'boundaries';
  communication_style := personality ->> 'communication_style';
  expertise := personality -> 'expertise';

  -- Validate vibe is present and not too long
  IF vibe IS NULL OR vibe = '' THEN
    RAISE EXCEPTION 'personality.vibe is required and must be a non-empty string';
  END IF;

  IF LENGTH(vibe) > 160 THEN
    RAISE EXCEPTION 'personality.vibe must be 160 characters or less (got %)', LENGTH(vibe);
  END IF;

  -- Validate core_truths is a non-empty array
  IF core_truths IS NULL OR core_truths = 'null'::JSONB THEN
    RAISE EXCEPTION 'personality.core_truths is required and must be an array';
  END IF;

  IF NOT (core_truths @> '[]'::JSONB) THEN
    RAISE EXCEPTION 'personality.core_truths must be a valid JSON array';
  END IF;

  IF jsonb_array_length(core_truths) = 0 THEN
    RAISE EXCEPTION 'personality.core_truths must not be empty';
  END IF;

  -- Validate boundaries is a non-empty array
  IF boundaries IS NULL OR boundaries = 'null'::JSONB THEN
    RAISE EXCEPTION 'personality.boundaries is required and must be an array';
  END IF;

  IF NOT (boundaries @> '[]'::JSONB) THEN
    RAISE EXCEPTION 'personality.boundaries must be a valid JSON array';
  END IF;

  IF jsonb_array_length(boundaries) = 0 THEN
    RAISE EXCEPTION 'personality.boundaries must not be empty';
  END IF;

  -- Validate communication_style is present
  IF communication_style IS NULL OR communication_style = '' THEN
    RAISE EXCEPTION 'personality.communication_style is required and must be a non-empty string';
  END IF;

  IF LENGTH(communication_style) > 500 THEN
    RAISE EXCEPTION 'personality.communication_style must be 500 characters or less';
  END IF;

  -- Validate expertise is an array of valid roles
  IF expertise IS NULL OR expertise = 'null'::JSONB THEN
    RAISE EXCEPTION 'personality.expertise is required and must be an array';
  END IF;

  IF NOT (expertise @> '[]'::JSONB) THEN
    RAISE EXCEPTION 'personality.expertise must be a valid JSON array';
  END IF;

  IF jsonb_array_length(expertise) = 0 THEN
    RAISE EXCEPTION 'personality.expertise must not be empty';
  END IF;

  -- Validate each expertise role is one of the allowed values
  FOR i IN 0 .. jsonb_array_length(expertise) - 1 LOOP
    DECLARE
      role TEXT := expertise ->> i;
    BEGIN
      IF role NOT IN ('architect', 'reviewer', 'coder', 'debugger', 'writer', 'researcher', 'tester', 'devops', 'designer') THEN
        RAISE EXCEPTION 'personality.expertise[%] contains invalid role: % (valid: architect, reviewer, coder, debugger, writer, researcher, tester, devops, designer)', i, role;
      END IF;
    END;
  END LOOP;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Add CHECK constraint to agent_registry for personality validation
-- Use IF NOT EXISTS to be idempotent
DO $$
BEGIN
  ALTER TABLE roadmap_workforce.agent_registry
  ADD CONSTRAINT ck_agent_personality_valid
  CHECK (fn_validate_personality(personality));
EXCEPTION WHEN duplicate_object THEN
  NULL;  -- Constraint already exists, continue
END $$;

-- Verify constraint is in place
ALTER TABLE roadmap_workforce.agent_registry
ADD CONSTRAINT ck_agent_personality_vibe_required
CHECK ((personality IS NULL) OR (personality->>'vibe' IS NOT NULL AND LENGTH(personality->>'vibe') > 0));

-- Verify personality column exists in agent_registry
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'roadmap_workforce' AND table_name = 'agent_registry' AND column_name = 'personality'
  ) THEN
    ALTER TABLE roadmap_workforce.agent_registry
    ADD COLUMN personality JSONB;
  END IF;
END $$;

-- Add personality JSONB column to spawn_briefing for AC-4 (personality injection at spawn)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'roadmap' AND table_name = 'spawn_briefing' AND column_name = 'personality'
  ) THEN
    ALTER TABLE roadmap.spawn_briefing
    ADD COLUMN personality JSONB;
  END IF;
END $$;
