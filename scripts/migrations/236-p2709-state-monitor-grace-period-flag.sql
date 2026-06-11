-- P2709: Add PROPOSAL_STATE_MONITOR_GRACE_PERIOD_SEC runtime flag
-- Default 300 seconds (5 minutes). Hot-reloadable by state-monitor.ts.
-- AC-4: grace period from core.runtime_flag

INSERT INTO roadmap.feature_flag (
  flag_name,
  display_name,
  description,
  enabled_default,
  per_tenant_override,
  rollout_percent,
  variant_values,
  updated_by,
  is_archived
) VALUES (
  'PROPOSAL_STATE_MONITOR_GRACE_PERIOD_SEC',
  'State Monitor Grace Period',
  'Grace period (seconds) before state-monitor auto-advances maturity after a gate hold/reject. Default 300 (5 min). Hot-reloadable.',
  true,
  '{"default": {"enabled": true, "value": "300"}}'::jsonb,
  100,
  '{"default": "300"}'::jsonb,
  'system',
  false
) ON CONFLICT DO NOTHING;
