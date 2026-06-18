-- Migration 297: P3795 provider-health hard routing gate flag
--
-- Seeds the PROVIDER_HEALTH_GATE_ENABLED runtime flag (default ON). When true,
-- isProviderHealthyForDispatch() blocks dispatch to a provider whose P796 health
-- probe shows a fresh timeout/error; when false the gate is bypassed and routing
-- reverts to the pre-P3795 soft-sort-only signal. Fails open on stale/unknown.
--
-- Idempotent: ON CONFLICT (flag_name, scope) DO NOTHING.

INSERT INTO core.runtime_flag (flag_name, scope, value_jsonb, description) VALUES
  ('PROVIDER_HEALTH_GATE_ENABLED', 'global', 'true',
   'P3795: block dispatch to providers whose health probe is a fresh timeout/error. Default ON; fails open on stale/unknown.')
ON CONFLICT (flag_name, scope) DO NOTHING;
