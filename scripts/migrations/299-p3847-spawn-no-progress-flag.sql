-- Migration 299: P3847 Part B — silent no-progress watchdog threshold flag
--
-- Seeds AGENTHIVE_SPAWN_NO_PROGRESS_MS (default 5 min). The no-progress watchdog
-- (src/core/pipeline/no-progress-watchdog.ts) reaps a status='running' agent_run
-- that has shown no tool-call/checkpoint/output progress for this long — well
-- before the ~20-min hard spawn timeout. Lower it to react faster; raise it to be
-- more conservative. Floor enforced at 30 s in the ConfigKey parser.
--
-- Idempotent: ON CONFLICT (flag_name, scope) DO NOTHING.

INSERT INTO core.runtime_flag (flag_name, scope, value_jsonb, description) VALUES
  ('AGENTHIVE_SPAWN_NO_PROGRESS_MS', 'global', '300000',
   'P3847: silent no-progress watchdog threshold in ms — a running spawn with no tool-call/output for this long is reaped before the hard timeout (default 5 min).')
ON CONFLICT (flag_name, scope) DO NOTHING;
