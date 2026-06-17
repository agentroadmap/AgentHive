-- P3795: Add PROVIDER_HEALTH_GATE_ENABLED runtime flag.
-- Enables the hard routing gate that blocks dispatch to providers whose
-- cached health status is 'timeout' or 'error'. Default ON.

INSERT INTO core.runtime_flag (flag_name, value_jsonb, description, category)
VALUES (
  'PROVIDER_HEALTH_GATE_ENABLED',
  'true',
  'P3795: block dispatch to providers whose cached health status is ''timeout'' or ''error''. Default ON.',
  'provider_quota'
)
ON CONFLICT (flag_name) DO NOTHING;

INSERT INTO migration_history (migration_file, applied_at, notes)
VALUES (
  '297-p3795-provider-health-gate-flag.sql',
  NOW(),
  'P3795: PROVIDER_HEALTH_GATE_ENABLED flag seed'
)
ON CONFLICT DO NOTHING;
