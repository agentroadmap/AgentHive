BEGIN;

DO $$
DECLARE
    item record;
BEGIN
    FOR item IN
        SELECT *
        FROM (VALUES
            ('agent_registry', 'roadmap_workforce'),
            ('agency_profile', 'roadmap_workforce'),
            ('agent_capability', 'roadmap_workforce'),
            ('agent_conflicts', 'roadmap_workforce'),
            ('agent_health', 'roadmap_workforce'),
            ('agent_heartbeat_log', 'roadmap_workforce'),
            ('agent_runs', 'roadmap_workforce'),
            ('agent_trust', 'roadmap_workforce'),
            ('agent_workload', 'roadmap_workforce'),
            ('team', 'roadmap_workforce'),
            ('team_member', 'roadmap_workforce'),
            ('agent_memory', 'roadmap_efficiency'),
            ('agent_budget_ledger', 'roadmap_efficiency'),
            ('budget_allowance', 'roadmap_efficiency'),
            ('cache_write_log', 'roadmap_efficiency'),
            ('cache_hit_log', 'roadmap_efficiency'),
            ('context_window_log', 'roadmap_efficiency'),
            ('spending_caps', 'roadmap_efficiency'),
            ('spending_log', 'roadmap_efficiency')
        ) AS moved_table(table_name, target_schema)
    LOOP
        IF EXISTS (
            SELECT 1
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'roadmap'
              AND c.relname = item.table_name
              AND c.relkind IN ('r', 'p')
        ) THEN
            EXECUTE format('ALTER TABLE roadmap.%I SET SCHEMA %I', item.table_name, item.target_schema);
        END IF;
    END LOOP;
END;
$$;

CREATE OR REPLACE VIEW roadmap.agent_registry AS SELECT * FROM roadmap_workforce.agent_registry;
CREATE OR REPLACE VIEW roadmap.agency_profile AS SELECT * FROM roadmap_workforce.agency_profile;
CREATE OR REPLACE VIEW roadmap.agent_capability AS SELECT * FROM roadmap_workforce.agent_capability;
CREATE OR REPLACE VIEW roadmap.agent_conflicts AS SELECT * FROM roadmap_workforce.agent_conflicts;
CREATE OR REPLACE VIEW roadmap.agent_health AS SELECT * FROM roadmap_workforce.agent_health;
CREATE OR REPLACE VIEW roadmap.agent_heartbeat_log AS SELECT * FROM roadmap_workforce.agent_heartbeat_log;
CREATE OR REPLACE VIEW roadmap.agent_runs AS SELECT * FROM roadmap_workforce.agent_runs;
CREATE OR REPLACE VIEW roadmap.agent_trust AS SELECT * FROM roadmap_workforce.agent_trust;
CREATE OR REPLACE VIEW roadmap.agent_workload AS SELECT * FROM roadmap_workforce.agent_workload;
CREATE OR REPLACE VIEW roadmap.team AS SELECT * FROM roadmap_workforce.team;
CREATE OR REPLACE VIEW roadmap.team_member AS SELECT * FROM roadmap_workforce.team_member;

CREATE OR REPLACE VIEW roadmap.agent_memory AS SELECT * FROM roadmap_efficiency.agent_memory;
CREATE OR REPLACE VIEW roadmap.agent_budget_ledger AS SELECT * FROM roadmap_efficiency.agent_budget_ledger;
CREATE OR REPLACE VIEW roadmap.budget_allowance AS SELECT * FROM roadmap_efficiency.budget_allowance;
CREATE OR REPLACE VIEW roadmap.cache_write_log AS SELECT * FROM roadmap_efficiency.cache_write_log;
CREATE OR REPLACE VIEW roadmap.cache_hit_log AS SELECT * FROM roadmap_efficiency.cache_hit_log;
CREATE OR REPLACE VIEW roadmap.context_window_log AS SELECT * FROM roadmap_efficiency.context_window_log;
CREATE OR REPLACE VIEW roadmap.spending_caps AS SELECT * FROM roadmap_efficiency.spending_caps;
CREATE OR REPLACE VIEW roadmap.spending_log AS SELECT * FROM roadmap_efficiency.spending_log;

CREATE OR REPLACE FUNCTION roadmap.fn_check_spending_cap()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_daily_total numeric(14,6);
    v_daily_limit numeric(12,2);
BEGIN
    SELECT COALESCE(SUM(cost_usd), 0) INTO v_daily_total
    FROM roadmap_efficiency.spending_log
    WHERE agent_identity = NEW.agent_identity
      AND created_at >= date_trunc('day', now());

    SELECT daily_limit_usd INTO v_daily_limit
    FROM roadmap_efficiency.spending_caps
    WHERE agent_identity = NEW.agent_identity;

    IF v_daily_limit IS NOT NULL AND v_daily_total > v_daily_limit THEN
        UPDATE roadmap_efficiency.spending_caps
        SET is_frozen = true,
            frozen_reason = 'Daily limit USD ' || v_daily_limit || ' exceeded',
            updated_at = now()
        WHERE agent_identity = NEW.agent_identity
          AND is_frozen = false;
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION roadmap.fn_rollup_budget_consumed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.budget_id IS NOT NULL THEN
        UPDATE roadmap_efficiency.budget_allowance
        SET consumed_usd = consumed_usd + NEW.cost_usd
        WHERE id = NEW.budget_id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION roadmap.fn_sync_workload()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_agent_id int8;
    v_delta int4;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT id INTO v_agent_id FROM roadmap_workforce.agent_registry
        WHERE agent_identity = NEW.agent_identity;
        v_delta := 1;
    ELSIF TG_OP = 'UPDATE' AND OLD.released_at IS NULL AND NEW.released_at IS NOT NULL THEN
        SELECT id INTO v_agent_id FROM roadmap_workforce.agent_registry
        WHERE agent_identity = NEW.agent_identity;
        v_delta := -1;
    ELSE
        RETURN NEW;
    END IF;

    INSERT INTO roadmap_workforce.agent_workload (agent_id, active_lease_count, updated_at)
    VALUES (v_agent_id, GREATEST(0, v_delta), now())
    ON CONFLICT (agent_id) DO UPDATE
        SET active_lease_count = GREATEST(0, roadmap_workforce.agent_workload.active_lease_count + v_delta),
            updated_at = now();

    RETURN NEW;
END;
$$;

COMMIT;
