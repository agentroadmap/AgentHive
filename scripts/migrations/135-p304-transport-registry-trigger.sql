-- P304: pg_notify on transport_registry change so gateway can hot-reload adapter map
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
