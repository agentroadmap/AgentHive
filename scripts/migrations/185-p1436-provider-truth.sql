-- 185-p1436-provider-truth.sql
-- V3-C4 (P1436): provider truth at spawn — record claimed vs resolved provider.
--
-- PROBLEM: agent_registry.preferred_provider / agent_cli are operator-supplied
-- labels never verified at spawn. cooper claims 'codex' but its liaison spawned
-- claude; george claims 'gemini' but spawned claude. The binary comes from
-- model_routes -> agent_provider, divorced from the agency's declared provider.
-- This corrupts cost attribution (Claude spend booked as Codex), routing
-- fairness, and every debugging session (caught live 2026-05-29 only by
-- inspecting running child processes).
--
-- AC-2: agent_runs must record, for every orchestration-spawned worker, the
-- claiming agency's declared provider/cli, the resolved route's provider,
-- the route id, the agency identity, and whether they mismatched — so a
-- post-hoc spend/routing audit proves provider truth without reading process
-- lists. The vocabularies are identical (claude/codex/copilot/gemini/hermes for
-- both preferred_provider and model_routes.agent_provider), so the mismatch
-- check is a direct string comparison (no family mapping needed).
--
-- AC-1 (assert at spawn) + AC-3 (staged enforcement: warn+record in phase 1)
-- ship as code in the same C4 set (agent-spawner.ts). Phase 1 records the
-- mismatch and warns; it does NOT fail-closed yet (legacy divergence exists).
-- Fail-closed condition is documented on P1436: enable once the live
-- provider_mismatch rate for active agencies is zero (verified via these columns).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

BEGIN;

ALTER TABLE roadmap_workforce.agent_runs
  ADD COLUMN IF NOT EXISTS claimed_provider   text,
  ADD COLUMN IF NOT EXISTS resolved_provider  text,
  ADD COLUMN IF NOT EXISTS agent_cli          text,
  ADD COLUMN IF NOT EXISTS route_id           bigint,
  ADD COLUMN IF NOT EXISTS agency_identity    text,
  ADD COLUMN IF NOT EXISTS provider_mismatch  boolean NOT NULL DEFAULT false;

-- Audit view: live provider-truth divergence by agency (the artifact that
-- proves whether fail-closed enforcement can be turned on).
CREATE OR REPLACE VIEW roadmap_workforce.v_provider_mismatch AS
  SELECT agency_identity,
         claimed_provider,
         resolved_provider,
         count(*)                          AS runs,
         max(started_at)                   AS last_seen
    FROM roadmap_workforce.agent_runs
   WHERE provider_mismatch = true
   GROUP BY agency_identity, claimed_provider, resolved_provider;

COMMIT;
