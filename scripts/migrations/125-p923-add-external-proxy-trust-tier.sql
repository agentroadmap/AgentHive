-- Migration 125: Add 'external_proxy' trust tier for P923 Discord bridge
--
-- Extends message_ledger.trust_tier CHECK constraint to include 'external_proxy',
-- and updates roadmap_workforce.agent_registry.trust_tier constraint to match.
-- This allows fn_liaison_message_send_v2 to mark messages from external bridges
-- with the 'external_proxy' trust tier per AC-12 specification.
--
-- Idempotent: uses DROP CONSTRAINT IF EXISTS and recreates with new enum values.

BEGIN;

-- ─── 1. Drop old trust_tier CHECK constraint on roadmap.message_ledger ───────

ALTER TABLE roadmap.message_ledger
DROP CONSTRAINT IF EXISTS "message_ledger_trust_tier_check";

-- ─── 2. Add new trust_tier CHECK constraint with 'external_proxy' ────────────

ALTER TABLE roadmap.message_ledger
ADD CONSTRAINT message_ledger_trust_tier_check
CHECK (trust_tier IN ('authority', 'known', 'restricted', 'blocked', 'external_proxy'));

-- ─── 3. Drop old trust_tier CHECK constraint on roadmap_workforce.agent_registry ──

ALTER TABLE roadmap_workforce.agent_registry
DROP CONSTRAINT IF EXISTS "agent_registry_trust_tier_check";

-- ─── 4. Add new trust_tier CHECK constraint with 'external_proxy' ────────────

ALTER TABLE roadmap_workforce.agent_registry
ADD CONSTRAINT agent_registry_trust_tier_check
CHECK (trust_tier = ANY (ARRAY['authority'::text, 'trusted'::text, 'known'::text, 'restricted'::text, 'blocked'::text, 'external_proxy'::text]));

COMMIT;
