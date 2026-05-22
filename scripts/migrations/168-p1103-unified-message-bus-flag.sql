-- P1103 AC-1: Insert feature flags for unified message bus cutover.
-- Phase 0 — flags default OFF; operator flips them during rollout.

INSERT INTO roadmap.feature_flag
    (flag_name, display_name, description, enabled_default, rollout_percent, updated_by)
VALUES
    ('unified_message_bus_dualwrite',
     'Unified Message Bus Dual-Write',
     'P1103: flip message_ledger to primary; liaison_message becomes mirror',
     false, 0, 'p1103'),
    ('unified_message_bus_cutover',
     'Unified Message Bus Cutover',
     'P1103: stop writing to liaison_message; ledger is sole store',
     false, 0, 'p1103')
ON CONFLICT (flag_name) DO NOTHING;
