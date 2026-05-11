-- P907 AC3: Schema enforcement for reply_to and correlation_id propagation
-- Ensures DAG structure (reply_to < id) and auto-propagates correlation_id from parent.

-- 1. ADD CHECK constraint: reply_to must point to earlier message (DAG property)
ALTER TABLE roadmap.message_ledger
  ADD CONSTRAINT chk_reply_to_dag CHECK (reply_to IS NULL OR reply_to < id);

-- 2. Trigger function to auto-copy correlation_id from parent when NEW.correlation_id IS NULL
CREATE OR REPLACE FUNCTION roadmap.fn_message_ledger_inherit_correlation_id()
RETURNS TRIGGER AS $$
BEGIN
    -- If NEW.correlation_id is already set, return early (app pre-computed).
    IF NEW.correlation_id IS NOT NULL THEN
        RETURN NEW;
    END IF;

    -- If this is a reply (NEW.reply_to IS NOT NULL), inherit parent's correlation_id
    IF NEW.reply_to IS NOT NULL THEN
        SELECT correlation_id INTO NEW.correlation_id
        FROM roadmap.message_ledger
        WHERE id = NEW.reply_to;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Trigger to run BEFORE INSERT
-- This runs after trg_message_ledger_set_thread_id so thread_id is already populated.
DROP TRIGGER IF EXISTS trg_message_ledger_inherit_correlation_id ON roadmap.message_ledger;
CREATE TRIGGER trg_message_ledger_inherit_correlation_id
    BEFORE INSERT ON roadmap.message_ledger
    FOR EACH ROW
    EXECUTE FUNCTION roadmap.fn_message_ledger_inherit_correlation_id();
