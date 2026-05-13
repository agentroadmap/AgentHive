-- Migration 146 — P441 follow-up: seed static service_registry + service_responsibility
-- Extracted from codex-four's revised migration 071. Migration 071 created the schema/tables;
-- this migration seeds the canonical service stubs and static ownership matrix.
-- All INSERTs are idempotent (ON CONFLICT DO NOTHING).

-- Seed service_registry stubs so FK constraints on service_responsibility can
-- reference them. These are informational; real services upsert their own rows.
INSERT INTO control_runtime.service_registry (service_id, service_type, host)
VALUES
    ('orchestrator',       'orchestrator',    ''),
    ('offer-provider',     'offer-provider',  ''),
    ('mcp-server',         'mcp-server',      ''),
    ('state-feed-listener','feed-listener',   '')
ON CONFLICT (service_id) DO NOTHING;

INSERT INTO control_runtime.service_responsibility (service_id, responsibility, mode)
VALUES
    -- Primary writers
    ('orchestrator',        'state_machine_transition', 'primary'),
    ('orchestrator',        'maturity_sync',            'primary'),
    ('orchestrator',        'workflow_spawn',            'primary'),
    ('orchestrator',        'service_lease_management', 'primary'),
    ('orchestrator',        'gate_evaluation',          'primary'),
    ('offer-provider',      'work_offer_claim',         'primary'),
    ('offer-provider',      'subprocess_spawn',         'primary'),
    ('mcp-server',          'proposal_crud',            'primary'),
    ('state-feed-listener', 'feed_event_publication',   'primary'),
    -- Passive observers
    ('mcp-server',          'state_machine_transition', 'passive'),
    ('state-feed-listener', 'state_machine_transition', 'passive'),
    ('mcp-server',          'work_offer_claim',         'passive')
ON CONFLICT DO NOTHING;
