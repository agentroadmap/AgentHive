-- ============================================================
-- agentHive2 — 005-observability.sql
-- Observability schema: distributed trace spans, agent execution
-- metrics, proposal lifecycle events, model routing outcomes,
-- and decision explainability.
-- Ported from P604 into agentHive2 as a control-plane schema.
-- Target DB:  agentHive2
-- Owner:      agenthive_admin
-- Depends on: 001-core.sql (core.project), 002-agency.sql (agency.route)
-- ============================================================

\set ON_ERROR_STOP on

-- =====================================================