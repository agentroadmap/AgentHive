-- P1367 (amends P996): hyphen-separated agency aliases + LLM variant slot.
--
-- Canonical alias format: <agency-style>[-<llm-variant>]-a
--   claude-a, codex-a, gemini-a, copilot-a (default backends, llm_variant NULL)
--   claude-mimo-a (Claude-style on Xiaomi MiMo) — seeded on demand, not here.
--
-- AC-1/AC-8: idempotent. agency_style + llm_variant already exist on
-- roadmap_workforce.agent_registry (added out-of-band); guard with IF NOT EXISTS
-- so the migration is safe to run twice.
-- AC-4/AC-5: seed the four canonical aliases as agent_type='alias' rows. claude-a
-- and codex-a already exist; gemini-a and copilot-a are added here. ON CONFLICT
-- DO NOTHING makes re-runs a no-op (no duplicate-key error).

BEGIN;

ALTER TABLE roadmap_workforce.agent_registry ADD COLUMN IF NOT EXISTS agency_style TEXT;
ALTER TABLE roadmap_workforce.agent_registry ADD COLUMN IF NOT EXISTS llm_variant  TEXT;

-- Seed gemini-a and copilot-a by copying the NOT-NULL column defaults from an
-- existing canonical alias row (claude-a), overriding only identity + style.
-- This guarantees valid values for trust_tier / project_id / scores / etc.
-- without hardcoding them here.
INSERT INTO roadmap_workforce.agent_registry
	(agent_identity, agent_type, status, agency_style, llm_variant,
	 trust_tier, project_id, max_concurrent_claims,
	 memory_decay_score, moral_alignment_score)
SELECT v.agent_identity, 'alias', t.status, v.agency_style, NULL,
	 t.trust_tier, t.project_id, t.max_concurrent_claims,
	 t.memory_decay_score, t.moral_alignment_score
FROM roadmap_workforce.agent_registry t
CROSS JOIN (VALUES
	('gemini-a',  'gemini'),
	('copilot-a', 'copilot')
) AS v(agent_identity, agency_style)
WHERE t.agent_identity = 'claude-a'
ON CONFLICT (agent_identity) DO NOTHING;

COMMIT;
