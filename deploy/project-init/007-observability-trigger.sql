-- ============================================================
-- agentHive2 — 007-observability-trigger.sql
-- Per-project proposal lifecycle trigger
-- Installed into each tenant project schema. Captures proposal
-- status and maturity changes into observability.proposal_lifecycle_event.
-- Executed by deploy/apply.sh with --project-only and -v schema_name=<schema>.
-- ============================================================

\set ON_ERROR_STOP on

-- ============================================================
-- fn_proposal_lifecycle_event — trigger function
-- Fires on UPDATE of status or maturity on the proposal table.
-- Writes an event to observability.proposal_lifecycle_event if
-- the observability schema exists in this DB.
--
-- Note: This function is created in the global namespace (not per-schema)
-- so it can be referenced from any project schema.
-- =====================================================