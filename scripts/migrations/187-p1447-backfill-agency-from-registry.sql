-- Migration 187: P1447 backfill roadmap.agency from agent_registry
--
-- Operator Decision (P1447 #1): Canonical table = reconcile ONE-WAY, no dual-write.
-- agentHive2 will replace legacy via clean-slate consolidation later, so we backfill
-- missing roadmap.agency rows from roadmap_workforce.agent_registry to unblock
-- agenthive-a2a-host bootLiaison (which was failing "not registered").
--
-- EXCLUSIONS:
--   - Agencies with host_affinity=NULL are excluded (would FK-violate).
--     Examples: codex/agency-bot, codex-liaison
--   - Ephemeral workers (preferred_provider IS NULL) are excluded.
--     Examples: claude/agent-36fa68e243a34f81 and 3 others (misclassified as agent_type='agency')
--   - This is idempotent: INSERT...WHERE NOT EXISTS, so re-runs are safe.

BEGIN;

INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, status)
SELECT
  r.agent_identity,
  COALESCE(r.display_name, r.display_alias, r.agent_identity) AS display_name,
  r.preferred_provider,
  r.host_affinity,
  'active'
FROM roadmap_workforce.agent_registry r
WHERE r.agent_type='agency'
  AND r.status='active'
  AND r.preferred_provider IS NOT NULL
  AND r.host_affinity IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM roadmap.host_model_policy h
    WHERE h.host_name = r.host_affinity
  )
  AND NOT EXISTS (
    SELECT 1 FROM roadmap.agency a
    WHERE a.agency_id = r.agent_identity
  )
ON CONFLICT (agency_id) DO NOTHING;

COMMIT;
