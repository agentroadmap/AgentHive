-- P922 Host-aware NOTIFY test
-- Tests dual-fire NOTIFY on host_id and per-agency channel

-- Setup: Insert test agencies (with required fields)
-- First ensure host_model_policy entries exist
INSERT INTO roadmap.host_model_policy (host_name, allowed_providers, default_model)
VALUES
  ('mac-1', ARRAY['test-provider'], 'claude-opus'),
  ('host-2', ARRAY['test-provider'], 'claude-opus')
ON CONFLICT (host_name) DO NOTHING;

-- Now insert test agencies
INSERT INTO roadmap.agency (agency_id, host_id, display_name, provider, status)
VALUES
  ('test-agency-1', 'mac-1', 'Test Agency 1', 'test-provider', 'active'),
  ('test-agency-2', 'mac-1', 'Test Agency 2', 'test-provider', 'active'),
  ('test-agency-3', 'host-2', 'Test Agency 3', 'test-provider', 'active')
ON CONFLICT (agency_id) DO NOTHING;

-- AC-5: Channel name computation
-- Compute the host_dispatch channel first (LISTEN takes an identifier, not an expression)
SELECT roadmap.fn_host_dispatch_channel('mac-1') as host_dispatch_channel;
-- Result: host_dispatch_60beb87851831752981415630eb72f15 (deterministic md5)

-- Test 1: Insert with host_id='mac-1' — both channels fire
-- Expected: per-agency channel liaison_message_test-agency-1 fires
-- Expected: host_dispatch channel host_dispatch_60beb87851831752981415630eb72f15 fires

-- Session A (per-agency channel listener):
-- psql -c "LISTEN liaison_message_test-agency-1; SELECT pg_sleep(60);"

-- Session B (host dispatch channel listener):
-- psql -c "LISTEN host_dispatch_60beb87851831752981415630eb72f15; SELECT pg_sleep(60);"

-- Session C (inserter):
INSERT INTO roadmap.liaison_message
  (message_id, agency_id, sequence, direction, kind, correlation_id, payload, signed_at, signature, host_id)
VALUES
  ('550e8400-e29b-41d4-a716-446655440000'::uuid, 'test-agency-1', 1, 'orchestrator->liaison', 'test_kind', '00000000-0000-0000-0000-000000000000'::uuid, '{}', now(), 'sig', 'mac-1')
ON CONFLICT (agency_id, sequence) DO NOTHING;

-- Both Session A and B should receive notifications

-- Test 2: Insert with host_id=NULL — only per-agency channel fires
-- Expected: per-agency channel liaison_message_test-agency-3 fires
-- Expected: host_dispatch channel does NOT fire

INSERT INTO roadmap.liaison_message
  (message_id, agency_id, sequence, direction, kind, correlation_id, payload, signed_at, signature, host_id)
VALUES
  ('550e8400-e29b-41d4-a716-446655440001'::uuid, 'test-agency-3', 1, 'orchestrator->liaison', 'test_kind', '00000000-0000-0000-0000-000000000001'::uuid, '{}', now(), 'sig', NULL)
ON CONFLICT (agency_id, sequence) DO NOTHING;

-- Only Session A (if listening to liaison_message_test-agency-3) should receive notification
-- No host dispatch notification fires

-- AC-13: Boundary test — special characters in host_id
-- Test with special characters
SELECT
  roadmap.fn_host_dispatch_channel('/foo/bar') as slash_chars,
  roadmap.fn_host_dispatch_channel('host 1') as space_chars,
  roadmap.fn_host_dispatch_channel('café') as unicode_chars;

-- All should produce valid 46-byte alphanumeric identifiers

-- Verify the columns exist and are nullable
SELECT
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_schema='roadmap' AND table_name='liaison_message'
  AND column_name IN ('host_id', 'agency_id', 'message_id')
ORDER BY ordinal_position;

-- AC-3: Verify the partial index exists and is usable
EXPLAIN (ANALYZE, BUFFERS)
SELECT message_id, agency_id, host_id, kind, direction, sequence, created_at
FROM roadmap.liaison_message
WHERE host_id = 'mac-1' AND acked_at IS NULL
ORDER BY created_at ASC, message_id ASC
LIMIT 10
FOR UPDATE SKIP LOCKED;

-- Index scan should be used (Index Scan using idx_liaison_message_host_pending)
