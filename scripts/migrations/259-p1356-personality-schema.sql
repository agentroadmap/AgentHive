/**
 * P1356: Schema migration — personality JSONB + display metadata on agent_registry
 *
 * This migration adds 4 JSONB/TEXT columns to roadmap_workforce.agent_registry to
 * support P1355 agent personality profiling and display customization.
 *
 * AC-1: personality JSONB column (stores AgentPersonality interface from types.ts)
 * AC-2: display_metadata JSONB column (stores AgentDisplayMetadata interface)
 * AC-3: agency_style TEXT column (coarse agency behavioral classification)
 * AC-4: llm_variant TEXT column (e.g. 'claude-opus', 'codex-3.1-pro')
 *
 * NOTE: These columns are added WITH IF NOT EXISTS guards because they may have
 * been created out-of-band. P1355 types are already in src/core/identity/agent-registry/types.ts
 * and P1352 added the validation function fn_validate_personality().
 *
 * AC-5 (TS types): Already exported from src/core/identity/agent-registry/types.ts
 * - ExpertiseRole union type
 * - AgentPersonality interface (required keys: vibe, core_truths, boundaries, communication_style, expertise)
 * - AgentDisplayMetadata interface (optional: emoji, color, description, source)
 *
 * AC-6: Seeding codex.a personality with a representative profile.
 */

-- AC-1 & AC-3 & AC-4: Add personality (JSONB), display_metadata (JSONB), agency_style (TEXT), llm_variant (TEXT)
-- Idempotent: only add if missing.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'roadmap_workforce' AND table_name = 'agent_registry' AND column_name = 'personality'
  ) THEN
    ALTER TABLE roadmap_workforce.agent_registry
    ADD COLUMN personality JSONB;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'roadmap_workforce' AND table_name = 'agent_registry' AND column_name = 'display_metadata'
  ) THEN
    ALTER TABLE roadmap_workforce.agent_registry
    ADD COLUMN display_metadata JSONB;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'roadmap_workforce' AND table_name = 'agent_registry' AND column_name = 'agency_style'
  ) THEN
    ALTER TABLE roadmap_workforce.agent_registry
    ADD COLUMN agency_style TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'roadmap_workforce' AND table_name = 'agent_registry' AND column_name = 'llm_variant'
  ) THEN
    ALTER TABLE roadmap_workforce.agent_registry
    ADD COLUMN llm_variant TEXT;
  END IF;
END $$;

-- AC-6: Seed codex.a (codex agency) with a representative personality profile.
-- Update codex agent (agent_identity = 'codex.a') if it exists.
UPDATE roadmap_workforce.agent_registry
SET
  personality = jsonb_build_object(
    'vibe', 'Principled orchestrator who marshals distributed AI reasoning across competing objectives.',
    'core_truths', jsonb_build_array(
      'Consensus emerges from structural debate, not authority.',
      'Skepticism is a tool, not a posture.',
      'Complexity must be bounded or it will explode.',
      'Evidence precedes conclusion.'
    ),
    'boundaries', jsonb_build_array(
      'Never blend strategic judgment with operational detail.',
      'Refuse to archive reasoning without root-cause evidence.',
      'Will not execute without quorum-style gating.',
      'Rejects fabricated "evidence" in decision logs.'
    ),
    'communication_style', 'Direct, evidence-grounded, and skeptically constructive. Expects challenge. Explains reasoning before recommendation.',
    'expertise', jsonb_build_array('architect', 'reviewer', 'debugger')
  ),
  display_metadata = jsonb_build_object(
    'emoji', '⚖️',
    'color', '#2563eb',
    'description', 'Distributed orchestrator across agency proposals and reviews',
    'source', 'operator'
  ),
  agency_style = 'consensus-seeker',
  llm_variant = 'claude-sonnet-4.6'
WHERE agent_identity = 'codex.a'
  AND (personality IS NULL OR display_metadata IS NULL OR agency_style IS NULL OR llm_variant IS NULL);
