-- Migration 148: P304 — transport_registry hot-reload trigger
--
-- Summary:
--   fn_notify_transport_registry_changed fires pg_notify('transport_registry_changed')
--   on INSERT or UPDATE of roadmap.transport_registry.
--   TransportRegistry (src/core/messaging/gateway/registry.ts) LISTENs and
--   reloads its in-memory adapter map within 2s (AC#9).

CREATE OR REPLACE FUNCTION roadmap.fn_notify_transport_registry_changed()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('transport_registry_changed', NEW.transport_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_transport_registry_changed ON roadmap.transport_registry;

CREATE TRIGGER trg_transport_registry_changed
  AFTER INSERT OR UPDATE ON roadmap.transport_registry
  FOR EACH ROW EXECUTE FUNCTION roadmap.fn_notify_transport_registry_changed();

COMMENT ON FUNCTION roadmap.fn_notify_transport_registry_changed() IS
'Fires pg_notify(transport_registry_changed) on every transport registry change.
Consumed by TransportRegistry.initialize() LISTEN client in the gateway (P304).';
