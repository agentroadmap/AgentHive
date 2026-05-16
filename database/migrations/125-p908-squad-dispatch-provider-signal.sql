-- P908-B: add provider_signal column to squad_dispatch.
-- Written by offer-dispatch-handler on spawn exit to record the classified
-- provider error signal ("rate_limit", "credit_exhausted") or NULL on success.
-- The orchestrator subscribes to pg_notify('offer_completed') and reads this
-- signal to update provider_health cooldown state without parsing LLM output.

ALTER TABLE roadmap_workforce.squad_dispatch
    ADD COLUMN IF NOT EXISTS provider_signal text;
