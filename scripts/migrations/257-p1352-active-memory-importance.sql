-- P1352 AC-7: v_active_memory gains importance_score (needed for top-K briefing injection).
-- Captures a view change applied live on 2026-06-12; idempotent.
CREATE OR REPLACE VIEW roadmap.v_active_memory AS
 SELECT id,
    agent_identity,
    layer,
    key,
    value,
    metadata,
    ttl_seconds,
    expires_at,
    body_vector,
    importance_score,
    created_at,
    updated_at
   FROM agent_memory
  WHERE expires_at IS NULL OR expires_at > now();
