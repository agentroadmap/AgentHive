/**
 * P450 V1: CLI Builder Fallback Audit Table
 *
 * Tracks every invocation of defaultModel() fallback when no route is found.
 * Used to emit metrics cli_builder_default_model_fallback_count{builder, model}.
 *
 * V2 (removal of defaultModel()) is blocked until this table reads zero
 * for 24h consecutive.
 *
 * Columns:
 *   id              — Primary key
 *   builder         — CLI name (claude, codex, hermes, gemini, copilot)
 *   fallback_model  — The hardcoded default that was used (e.g., claude-sonnet-4-6)
 *   called_at       — Timestamp of the fallback
 */

CREATE TABLE IF NOT EXISTS roadmap.cli_builder_fallback_audit (
  id BIGSERIAL PRIMARY KEY,
  builder TEXT NOT NULL,
  fallback_model TEXT NOT NULL,
  called_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Index for time-based queries (24h zero-count check)
CREATE INDEX IF NOT EXISTS idx_cli_builder_fallback_audit_called_at
  ON roadmap.cli_builder_fallback_audit (called_at DESC);

-- Index for builder-based aggregation (metrics emission)
CREATE INDEX IF NOT EXISTS idx_cli_builder_fallback_audit_builder_model
  ON roadmap.cli_builder_fallback_audit (builder, fallback_model);

COMMENT ON TABLE roadmap.cli_builder_fallback_audit IS
  'P450 V1: Audit trail for defaultModel() fallbacks. Used to unblock V2 (defaultModel removal) after 24h zero-count.';
