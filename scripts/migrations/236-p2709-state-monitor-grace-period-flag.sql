-- P2709 AC-4: seed the state-monitor grace-period runtime flag.
-- Read via FlagKeys.PROPOSAL_STATE_MONITOR_GRACE_PERIOD_SEC (TTL-cached);
-- operators tune live with: UPDATE core.runtime_flag SET value_jsonb='600'
--   WHERE flag_name='PROPOSAL_STATE_MONITOR_GRACE_PERIOD_SEC';

INSERT INTO core.runtime_flag (flag_name, value_jsonb, description)
VALUES (
  'PROPOSAL_STATE_MONITOR_GRACE_PERIOD_SEC',
  '300',
  'State-monitor grace period (sec) after a gate hold/reject before maturity auto-advance is allowed (P2709). Default 300.'
)
ON CONFLICT (flag_name) DO NOTHING;
