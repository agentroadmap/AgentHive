-- AgentHive consolidated PostgreSQL baseline DDL
-- Generated: 2026-04-13
-- Source: live roadmap schema from agenthive plus latest accepted/proposal-backed schema deltas.
-- Intended use: create a fresh AgentHive database/schema. Not intended as an in-place migration.
-- Notes:
--   * Ignores legacy public-schema tables and roadmap/ folder documents.
--   * Keeps canonical proposal columns as live/code-compatible: maturity and dependency.
--   * Uses text maturity lifecycle values; history lives in proposal_maturity_transitions.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

--
-- PostgreSQL database dump
--

-- Dumped from database version 16.13 (Debian 16.13-1.pgdg13+1)
-- Dumped by pg_dump version 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: roadmap; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA roadmap;

CREATE SCHEMA IF NOT EXISTS roadmap_proposal;
CREATE SCHEMA IF NOT EXISTS roadmap_workforce;
CREATE SCHEMA IF NOT EXISTS roadmap_efficiency;


--
-- Name: fn_audit_sensitive_tables(); Type: FUNCTION; Schema: roadmap; Owner: -
--

CREATE FUNCTION roadmap.fn_audit_sensitive_tables() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_entity_id text;
    v_before    jsonb;
    v_after     jsonb;
    v_action    text;
BEGIN
    v_action := lower(TG_OP);

    IF TG_OP = 'DELETE' THEN
        v_entity_id := OLD.id::text;
        v_before    := to_jsonb(OLD);
        v_after     := NULL;
    ELSIF TG_OP = 'INSERT' THEN
        v_entity_id := NEW.id::text;
        v_before    := NULL;
        v_after     := to_jsonb(NEW);
    ELSE
        v_entity_id := NEW.id::text;
        v_before    := to_jsonb(OLD);
        v_after     := to_jsonb(NEW);
    END IF;

    INSERT INTO roadmap.audit_log
        (entity_type, entity_id, action, changed_by, before_json, after_json)
    VALUES (
        TG_TABLE_NAME,
        v_entity_id,
        v_action,
        COALESCE(current_setting('app.agent_identity', true), session_user),
        v_before,
        v_after
    );

    RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: fn_budget_threshold_notify(); Type: FUNCTION; Schema: roadmap; Owner: -
--

CREATE FUNCTION roadmap.fn_budget_threshold_notify() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_pct numeric;
BEGIN
    IF NEW.budget_allocated_usd = 0 THEN RETURN NEW; END IF;

    v_pct := NEW.budget_remaining_usd / NEW.budget_allocated_usd;

    -- Cross 5% threshold (downward)
    IF v_pct <= 0.05
       AND (NEW.budget_remaining_usd + NEW.cost_usd) / NEW.budget_allocated_usd > 0.05
    THEN
        PERFORM pg_notify('budget_threshold_breached', jsonb_build_object(
            'proposal_id',    NEW.proposal_id,
            'threshold_pct',  5,
            'remaining_usd',  NEW.budget_remaining_usd,
            'cumulative_usd', NEW.cumulative_cost_usd,
            'ts',             to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        )::text);

    -- Cross 20% threshold (downward)
    ELSIF v_pct <= 0.20
          AND (NEW.budget_remaining_usd + NEW.cost_usd) / NEW.budget_allocated_usd > 0.20
    THEN
        PERFORM pg_notify('budget_threshold_breached', jsonb_build_object(
            'proposal_id',    NEW.proposal_id,
            'threshold_pct',  20,
            'remaining_usd',  NEW.budget_remaining_usd,
            'cumulative_usd', NEW.cumulative_cost_usd,
            'ts',             to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        )::text);
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: fn_check_dag_cycle(); Type: FUNCTION; Schema: roadmap; Owner: -
--

CREATE FUNCTION roadmap.fn_check_dag_cycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_cycle_found bool;
BEGIN
    IF NEW.dependency_type NOT IN ('blocks', 'depended_by') THEN
        RETURN NEW;
    END IF;

    WITH RECURSIVE ancestors AS (
        SELECT to_proposal_id AS node
        FROM   roadmap_proposal.proposal_dependencies
        WHERE  from_proposal_id = NEW.to_proposal_id
          AND  dependency_type IN ('blocks','depended_by')
          AND  resolved = false
        UNION
        SELECT d.to_proposal_id
        FROM   roadmap_proposal.proposal_dependencies d
        JOIN   ancestors a ON d.from_proposal_id = a.node
        WHERE  d.dependency_type IN ('blocks','depended_by')
          AND  d.resolved = false
    )
    SELECT EXISTS (SELECT 1 FROM ancestors WHERE node = NEW.from_proposal_id)
    INTO   v_cycle_found;

    IF v_cycle_found THEN
        RAISE EXCEPTION
            'Adding dependency from P% to P% would create a cycle in the proposal DAG',
            NEW.from_proposal_id, NEW.to_proposal_id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: fn_check_lease_available(); Type: FUNCTION; Schema: roadmap; Owner: -
--

CREATE FUNCTION roadmap.fn_check_lease_available() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM roadmap_proposal.proposal_lease
        WHERE  proposal_id  = NEW.proposal_id
          AND  released_at  IS NULL
          AND  (expires_at  IS NULL OR expires_at > now())
    ) THEN
        RAISE EXCEPTION 'Proposal % already has an active lease', NEW.proposal_id
            USING ERRCODE = 'unique_violation';
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: fn_check_spending_cap(); Type: FUNCTION; Schema: roadmap; Owner: -
--

CREATE FUNCTION roadmap.fn_check_spending_cap() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_daily_total numeric(14,6);
    v_daily_limit numeric(12,2);
BEGIN
    SELECT COALESCE(SUM(cost_usd), 0) INTO v_daily_total
    FROM   roadmap_efficiency.spending_log
    WHERE  agent_identity = NEW.agent_identity
      AND  created_at >= date_trunc('day', now());

    SELECT daily_limit_usd INTO v_daily_limit
    FROM   roadmap_efficiency.spending_caps
    WHERE  agent_identity = NEW.agent_identity;

    IF v_daily_limit IS NOT NULL AND v_daily_total > v_daily_limit THEN
        UPDATE roadmap_efficiency.spending_caps
        SET    is_frozen     = true,
               frozen_reason = 'Daily limit USD ' || v_daily_limit || ' exceeded',
               updated_at    = now()
        WHERE  agent_identity = NEW.agent_identity
          AND  is_frozen = false;
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: fn_enqueue_mature_proposals(); Type: FUNCTION; Schema: roadmap; Owner: -
--

CREATE FUNCTION roadmap.fn_enqueue_mature_proposals() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    rec RECORD;
    v_count int := 0;
    v_gate text;
    v_to_state text;
    v_task_prompt text;
BEGIN
    FOR rec IN (
        SELECT p.id, p.display_id, p.status
        FROM roadmap_proposal.proposal p
        WHERE p.maturity = 'mature'
          AND NOT EXISTS (
              SELECT 1 FROM roadmap.transition_queue tq
              WHERE tq.proposal_id = p.id
                AND tq.gate IS NOT NULL
                AND tq.status IN ('pending', 'processing')
          )
    ) LOOP
        CASE UPPER(rec.status)
            WHEN 'DRAFT'   THEN v_gate := 'D1'; v_to_state := 'REVIEW';
            WHEN 'REVIEW'  THEN v_gate := 'D2'; v_to_state := 'DEVELOP';
            WHEN 'DEVELOP' THEN v_gate := 'D3'; v_to_state := 'MERGE';
            WHEN 'MERGE'   THEN v_gate := 'D4'; v_to_state := 'COMPLETE';
            ELSE CONTINUE;
        END CASE;

        SELECT gt.task_prompt INTO v_task_prompt
        FROM roadmap.gate_task_templates gt
        WHERE gt.gate_number = REPLACE(v_gate, 'D', '')::int
          AND gt.is_active = true
        LIMIT 1;

        INSERT INTO roadmap.transition_queue (
            proposal_id, from_stage, to_stage, triggered_by,
            gate, status, metadata
        ) VALUES (
            rec.id, rec.status, v_to_state, 'gate_scan',
            v_gate, 'pending',
            jsonb_build_object(
                'task', COALESCE(v_task_prompt, 'Process gate ' || v_gate || ' for proposal ' || rec.display_id),
                'gate', v_gate,
                'proposal_display_id', rec.display_id,
                'spawn', jsonb_build_object(
                    'worktree', 'claude/one',
                    'timeoutMs', 300000
                )
            )
        )
        ON CONFLICT (proposal_id, gate)
        WHERE gate IS NOT NULL AND transition_queue.status IN ('pending', 'processing')
        DO NOTHING;

        v_count := v_count + 1;
    END LOOP;

    IF v_count > 0 THEN
        PERFORM pg_notify('transition_queued', jsonb_build_object(
            'source', 'gate_scan',
            'enqueued', v_count,
            'ts', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        )::text);
    END IF;

    RETURN v_count;
END;
$$;


--
-- Name: FUNCTION fn_enqueue_mature_proposals(); Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON FUNCTION roadmap.fn_enqueue_mature_proposals() IS 'Pull-scan: enqueues any mature proposals not already in the transition queue. Returns count of newly enqueued items. Called every poll cycle.';


--
-- Name: fn_event_lease_change(); Type: FUNCTION; Schema: roadmap; Owner: -
--

CREATE FUNCTION roadmap.fn_event_lease_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO roadmap_proposal.proposal_event (proposal_id, event_type, payload)
        VALUES (
            NEW.proposal_id, 'lease_claimed',
            jsonb_build_object(
                'agent',      NEW.agent_identity,
                'expires_at', NEW.expires_at
            )
        );
    ELSIF TG_OP = 'UPDATE' AND OLD.released_at IS NULL AND NEW.released_at IS NOT NULL THEN
        INSERT INTO roadmap_proposal.proposal_event (proposal_id, event_type, payload)
        VALUES (
            NEW.proposal_id, 'lease_released',
            jsonb_build_object(
                'agent',          NEW.agent_identity,
                'release_reason', NEW.release_reason
            )
        );
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: fn_init_proposal_maturity(); Type: FUNCTION; Schema: roadmap; Owner: -
--

CREATE FUNCTION roadmap.fn_init_proposal_maturity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.maturity IS NULL THEN
    NEW.maturity := 'new';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: fn_log_proposal_state_change(); Type: FUNCTION; Schema: roadmap; Owner: -
--

CREATE FUNCTION roadmap.fn_log_proposal_state_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_agent text;
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        v_agent := COALESCE(current_setting('app.agent_identity', true), 'system');

        -- 1. Append to audit jsonb
        NEW.audit := NEW.audit || jsonb_build_object(
            'TS',       to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'Agent',    v_agent,
            'Activity', 'StatusChange',
            'From',     OLD.status,
            'To',       NEW.status
        );

        -- 2. State transitions ledger
        INSERT INTO roadmap_proposal.proposal_state_transitions
            (proposal_id, from_state, to_state, transition_reason, transitioned_by)
        VALUES (NEW.id, OLD.status, NEW.status, 'system', v_agent);

        -- 3. Outbox event
        INSERT INTO roadmap_proposal.proposal_event (proposal_id, event_type, payload)
        VALUES (
            NEW.id,
            'status_changed',
            jsonb_build_object(
                'from',  OLD.status,
                'to',    NEW.status,
                'agent', v_agent,
                'ts',    to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            )
        );
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: fn_notify_gate_ready(); Type: FUNCTION; Schema: roadmap; Owner: -
--

CREATE FUNCTION roadmap.fn_notify_gate_ready() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_gate        text;
    v_to_state    text;
    v_task_prompt text;
    v_queue_id    int8;
BEGIN
    IF NEW.maturity = 'mature'
       AND OLD.maturity IS DISTINCT FROM 'mature' THEN
        CASE UPPER(NEW.status)
            WHEN 'DRAFT'   THEN v_gate := 'D1'; v_to_state := 'REVIEW';
            WHEN 'REVIEW'  THEN v_gate := 'D2'; v_to_state := 'DEVELOP';
            WHEN 'DEVELOP' THEN v_gate := 'D3'; v_to_state := 'MERGE';
            WHEN 'MERGE'   THEN v_gate := 'D4'; v_to_state := 'COMPLETE';
            ELSE
                PERFORM pg_notify('proposal_gate_ready', jsonb_build_object(
                    'proposal_id', NEW.id,
                    'display_id',  NEW.display_id,
                    'stage',       NEW.status,
                    'reason',      'no_gate_defined_for_state',
                    'ts',          to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                )::text);
                RETURN NEW;
        END CASE;

        SELECT gt.task_prompt INTO v_task_prompt
        FROM roadmap.gate_task_templates gt
        WHERE gt.gate_number = REPLACE(v_gate, 'D', '')::int
          AND gt.is_active = true
        LIMIT 1;

        INSERT INTO roadmap.transition_queue (
            proposal_id, from_stage, to_stage, triggered_by,
            gate, status, metadata
        ) VALUES (
            NEW.id,
            NEW.status,
            v_to_state,
            'gate_pipeline',
            v_gate,
            'pending',
            jsonb_build_object(
                'task', COALESCE(v_task_prompt, 'Process gate ' || v_gate || ' for proposal ' || NEW.display_id),
                'gate', v_gate,
                'proposal_display_id', NEW.display_id,
                'spawn', jsonb_build_object(
                    'worktree', 'claude/one',
                    'timeoutMs', 300000
                )
            )
        )
        ON CONFLICT (proposal_id, gate)
        WHERE gate IS NOT NULL AND transition_queue.status IN ('pending', 'processing')
        DO NOTHING
        RETURNING id INTO v_queue_id;

        IF v_queue_id IS NOT NULL THEN
            PERFORM pg_notify('transition_queued', jsonb_build_object(
                'queue_id',     v_queue_id,
                'proposal_id',  NEW.id,
                'display_id',   NEW.display_id,
                'gate',         v_gate,
                'from_stage',   NEW.status,
                'to_stage',     v_to_state,
                'ts',           to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            )::text);
        END IF;
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: fn_notify_new_message(); Type: FUNCTION; Schema: roadmap; Owner: -
--

CREATE FUNCTION roadmap.fn_notify_new_message() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM pg_notify(
        'new_message',
        jsonb_build_object(
            'message_id',    NEW.id,
            'from_agent',    NEW.from_agent,
            'to_agent',      NEW.to_agent,
            'channel',       COALESCE(NEW.channel, 'broadcast'),
            'message_type',  COALESCE(NEW.message_type, 'text'),
            'proposal_id',   NEW.proposal_id,
            'created_at',    NEW.created_at
        )::text
    );
    RETURN NEW;
END;
$$;


--
-- Name: fn_notify_proposal_event(); Type: FUNCTION; Schema: roadmap; Owner: -
--

CREATE FUNCTION roadmap.fn_notify_proposal_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM pg_notify('roadmap_events', jsonb_build_object('event_id', NEW.id, 'type', NEW.event_type, 'proposal', NEW.proposal_id)::text);
    RETURN NEW;
END;
$$;


--
-- Name: fn_proposal_display_id(); Type: FUNCTION; Schema: roadmap; Owner: -
--

CREATE FUNCTION roadmap.fn_proposal_display_id() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.display_id := 'P' || LPAD(NEW.id::text, 3, '0');
    RETURN NEW;
END;
$$;


--
-- Name: fn_rollup_budget_consumed(); Type: FUNCTION; Schema: roadmap; Owner: -
--

CREATE FUNCTION roadmap.fn_rollup_budget_consumed() RETURNS trigger
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


--
-- Name: fn_set_memory_expires(); Type: FUNCTION; Schema: roadmap; Owner: -
--

CREATE FUNCTION roadmap.fn_set_memory_expires() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.ttl_seconds IS NOT NULL THEN
        NEW.expires_at := NEW.created_at + (NEW.ttl_seconds || ' seconds')::interval;
    ELSE
        NEW.expires_at := NULL;
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: fn_set_updated_at(); Type: FUNCTION; Schema: roadmap; Owner: -
--

CREATE FUNCTION roadmap.fn_set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;


--
-- Name: fn_set_version_number(); Type: FUNCTION; Schema: roadmap; Owner: -
--

CREATE FUNCTION roadmap.fn_set_version_number() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.version_number IS NULL THEN
        SELECT COALESCE(MAX(version_number), 0) + 1
        INTO   NEW.version_number
        FROM   roadmap_proposal.proposal_version
        WHERE  proposal_id = NEW.proposal_id;
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: fn_spawn_workflow(); Type: FUNCTION; Schema: roadmap; Owner: -
--

CREATE FUNCTION roadmap.fn_spawn_workflow() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_template_id int8;
    v_first_stage text;
BEGIN
    -- Look up workflow template bound to this proposal type
    SELECT wt.id, ws.stage_name
    INTO   v_template_id, v_first_stage
    FROM   roadmap_proposal.proposal_type_config ptc
    JOIN   roadmap.workflow_templates wt ON wt.name = ptc.workflow_name
    JOIN   roadmap.workflow_stages ws    ON ws.template_id = wt.id
    WHERE  ptc.type = NEW.type
    ORDER  BY ws.stage_order
    LIMIT  1;

    IF v_template_id IS NOT NULL THEN
        INSERT INTO roadmap.workflows (template_id, proposal_id, current_stage)
        VALUES (v_template_id, NEW.id, COALESCE(v_first_stage, NEW.status));
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: fn_sync_proposal_maturity(); Type: FUNCTION; Schema: roadmap; Owner: -
--

CREATE FUNCTION roadmap.fn_sync_proposal_maturity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_level text;
BEGIN
  -- Only act on status changes
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- Determine maturity level from new status
  v_level := CASE
    WHEN NEW.status IN ('DEPLOYED','COMPLETE','MERGED','CLOSED','WONT_FIX') THEN 'mature'
    WHEN NEW.status IN ('FIX','DEVELOP','REVIEW','REVIEWING','MERGE','ESCALATE') THEN 'active'
    WHEN NEW.status IN ('REJECTED','DISCARDED','ABANDONED') THEN 'obsolete'
    ELSE 'new'
  END;

  NEW.maturity := v_level;
  RETURN NEW;
END;
$$;


--
-- Name: fn_sync_workload(); Type: FUNCTION; Schema: roadmap; Owner: -
--

CREATE FUNCTION roadmap.fn_sync_workload() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_agent_id int8;
    v_delta    int4;
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
            updated_at         = now();

    RETURN NEW;
END;
$$;


--
-- Name: fn_validate_proposal_fields(); Type: FUNCTION; Schema: roadmap; Owner: -
--

CREATE FUNCTION roadmap.fn_validate_proposal_fields() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE
    v_required text[];
    v_field     text;
    v_value     text;
BEGIN
    SELECT required_fields INTO v_required
    FROM   roadmap_proposal.proposal_type_config
    WHERE  type = NEW.type;

    IF v_required IS NULL THEN
        RETURN NEW;
    END IF;

    FOREACH v_field IN ARRAY v_required LOOP
        EXECUTE format('SELECT ($1).%I::text', v_field) INTO v_value USING NEW;
        IF v_value IS NULL OR trim(v_value) = '' THEN
            RAISE EXCEPTION 'Proposal type "%" requires field "%" to be non-empty',
                NEW.type, v_field
                USING ERRCODE = 'check_violation';
        END IF;
    END LOOP;

    RETURN NEW;
END;
$_$;


--
-- Name: log_proposal_state_change(); Type: FUNCTION; Schema: roadmap; Owner: -
--

CREATE FUNCTION roadmap.log_proposal_state_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM roadmap_proposal.proposal_valid_transitions
        WHERE UPPER(from_state) = UPPER(COALESCE(OLD.status, 'NEW'))
          AND UPPER(to_state) = UPPER(NEW.status)
    ) OR OLD.status IS NULL THEN
        INSERT INTO roadmap_proposal.proposal_state_transitions (
            proposal_id, from_state, to_state, transition_reason, transitioned_by, notes
        ) VALUES (
            NEW.id,
            COALESCE(OLD.status, 'NEW'),
            NEW.status,
            'mature',
            NULL,
            'Status changed from ' || COALESCE(OLD.status, 'NEW') || ' to ' || NEW.status
        );
    END IF;
    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: acl; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.acl (
    id bigint NOT NULL,
    subject text NOT NULL,
    resource text NOT NULL,
    action text NOT NULL,
    granted boolean DEFAULT true NOT NULL,
    granted_by text NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    scope_ref text,
    CONSTRAINT acl_action_check CHECK ((action = ANY (ARRAY['read'::text, 'write'::text, 'approve'::text, 'transition'::text, 'admin'::text])))
);


--
-- Name: TABLE acl; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap.acl IS 'Access control list binding subjects (agents/teams) to permitted actions on resources';


--
-- Name: COLUMN acl.expires_at; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap.acl.expires_at IS 'NULL = permanent grant; non-null = time-bounded permission, cleaned up by scheduled_job';


--
-- Name: COLUMN acl.scope_ref; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap.acl.scope_ref IS 'Optional scoping: proposal display_id, team name, or workflow name — narrows the grant';


--
-- Name: acl_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap.acl ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap.acl_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: agency_profile; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_workforce.agency_profile (
    id bigint NOT NULL,
    agent_id bigint NOT NULL,
    github_repo text NOT NULL,
    branch text DEFAULT 'main'::text NOT NULL,
    commit_sha text,
    profile_path text DEFAULT 'agent.json'::text NOT NULL,
    last_synced_at timestamp with time zone,
    sync_status text DEFAULT 'pending'::text NOT NULL,
    sync_error text,
    profile_data jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agency_profile_status_check CHECK ((sync_status = ANY (ARRAY['pending'::text, 'syncing'::text, 'ok'::text, 'error'::text])))
);


--
-- Name: TABLE agency_profile; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap_workforce.agency_profile IS 'Agent profile loaded from a GitHub repo; synced on demand or on schedule';


--
-- Name: COLUMN agency_profile.profile_data; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_workforce.agency_profile.profile_data IS 'Cached copy of parsed agent.json; refreshed on each successful sync';


--
-- Name: agency_profile_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap_workforce.agency_profile ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap_workforce.agency_profile_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: agent_budget_ledger; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_efficiency.agent_budget_ledger (
    id bigint NOT NULL,
    proposal_id bigint NOT NULL,
    agent_run_id bigint,
    agent_identity text NOT NULL,
    model_used text NOT NULL,
    tokens_in integer DEFAULT 0,
    tokens_out integer DEFAULT 0,
    cost_usd numeric(10,6) NOT NULL,
    budget_allocated_usd numeric(10,4) DEFAULT 10.00,
    budget_remaining_usd numeric(10,6) NOT NULL,
    cumulative_cost_usd numeric(10,6) NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_budget_ledger_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap_efficiency.agent_budget_ledger ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap_efficiency.agent_budget_ledger_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: agent_capability; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_workforce.agent_capability (
    id bigint NOT NULL,
    agent_id bigint NOT NULL,
    capability text NOT NULL,
    proficiency integer DEFAULT 3 NOT NULL,
    verified_by text,
    verified_at timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_capability_proficiency_chk CHECK (((proficiency >= 1) AND (proficiency <= 5)))
);


--
-- Name: TABLE agent_capability; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap_workforce.agent_capability IS 'Structured capability rows; replaces opaque skills jsonb for queryable routing';


--
-- Name: COLUMN agent_capability.capability; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_workforce.agent_capability.capability IS 'Controlled term, e.g. python, architecture-review, security-audit, llm-prompting';


--
-- Name: COLUMN agent_capability.proficiency; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_workforce.agent_capability.proficiency IS '1=novice, 3=competent, 5=expert';


--
-- Name: agent_capability_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap_workforce.agent_capability ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap_workforce.agent_capability_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: agent_conflicts; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_workforce.agent_conflicts (
    id bigint NOT NULL,
    proposal_id bigint NOT NULL,
    agent_a text NOT NULL,
    agent_b text NOT NULL,
    topic text NOT NULL,
    position_a text NOT NULL,
    position_b text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    resolved_by text,
    resolution text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    CONSTRAINT agent_conflicts_status_check CHECK ((status = ANY (ARRAY['open'::text, 'escalated'::text, 'resolved'::text, 'dismissed'::text])))
);


--
-- Name: agent_conflicts_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap_workforce.agent_conflicts ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap_workforce.agent_conflicts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: agent_memory; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_efficiency.agent_memory (
    id bigint NOT NULL,
    agent_identity text NOT NULL,
    layer text NOT NULL,
    memory_level text DEFAULT 'agent'::text NOT NULL,
    key text NOT NULL,
    value text,
    metadata jsonb,
    ttl_seconds integer,
    expires_at timestamp with time zone,
    body_vector public.vector(1536),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_memory_layer_check CHECK ((layer = ANY (ARRAY['episodic'::text, 'semantic'::text, 'working'::text, 'procedural'::text]))),
    CONSTRAINT agent_memory_level_check CHECK ((memory_level = ANY (ARRAY['universal'::text, 'project'::text, 'team'::text, 'agent'::text, 'task'::text])))
);


--
-- Name: COLUMN agent_memory.layer; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_efficiency.agent_memory.layer IS 'episodic=events, semantic=facts, working=current task, procedural=skills';
COMMENT ON COLUMN roadmap_efficiency.agent_memory.memory_level IS 'Five-level context hierarchy: universal, project, team, agent, task. Use this to pull lean context for LLM calls without changing the legacy memory layer API.';


--
-- Name: COLUMN agent_memory.ttl_seconds; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_efficiency.agent_memory.ttl_seconds IS 'Memory TTL in seconds; NULL = permanent. expires_at is set by insert trigger.';


--
-- Name: agent_memory_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap_efficiency.agent_memory ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap_efficiency.agent_memory_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: agent_registry; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_workforce.agent_registry (
    id bigint NOT NULL,
    agent_identity text NOT NULL,
    agent_type text NOT NULL,
    role text,
    skills jsonb,
    preferred_model text,
    status text DEFAULT 'active'::text NOT NULL,
    github_handle text,
    memory_decay_score numeric(5,2) DEFAULT 0 NOT NULL,
    moral_alignment_score numeric(5,2) DEFAULT 100 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_registry_memory_decay_check CHECK (((memory_decay_score >= (0)::numeric) AND (memory_decay_score <= (100)::numeric))),
    CONSTRAINT agent_registry_moral_alignment_check CHECK (((moral_alignment_score >= (0)::numeric) AND (moral_alignment_score <= (100)::numeric))),
    CONSTRAINT agent_registry_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text, 'suspended'::text]))),
    CONSTRAINT agent_registry_type_check CHECK ((agent_type = ANY (ARRAY['human'::text, 'llm'::text, 'tool'::text, 'hybrid'::text])))
);


--
-- Name: TABLE agent_registry; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap_workforce.agent_registry IS 'Registry of all agents (human or AI) participating in the roadmap system';


--
-- Name: COLUMN agent_registry.agent_identity; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_workforce.agent_registry.agent_identity IS 'Stable unique handle used across all tables as a text reference';


--
-- Name: COLUMN agent_registry.preferred_model; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_workforce.agent_registry.preferred_model IS 'Default model for LLM agents; null for human agents';


--
-- Name: agent_registry_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap_workforce.agent_registry ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap_workforce.agent_registry_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: agent_runs; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_workforce.agent_runs (
    id bigint NOT NULL,
    proposal_id bigint,
    display_id text,
    agent_identity text NOT NULL,
    stage text NOT NULL,
    model_used text NOT NULL,
    tokens_in integer DEFAULT 0,
    tokens_out integer DEFAULT 0,
    cost_usd numeric(10,6) DEFAULT 0,
    duration_ms integer,
    status text DEFAULT 'running'::text NOT NULL,
    error_detail text,
    input_hash text,
    output_summary text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT agent_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: agent_runs_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap_workforce.agent_runs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap_workforce.agent_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: agent_workload; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_workforce.agent_workload (
    agent_id bigint NOT NULL,
    active_lease_count integer DEFAULT 0 NOT NULL,
    context_load_score numeric(6,2) DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_workload_count_check CHECK ((active_lease_count >= 0))
);


--
-- Name: TABLE agent_workload; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap_workforce.agent_workload IS 'Live capacity snapshot per agent; maintained by proposal_lease triggers';


--
-- Name: COLUMN agent_workload.context_load_score; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_workforce.agent_workload.context_load_score IS 'Rolling estimate of context pressure (e.g. sum of open proposal body sizes); updated by application';


--
-- Name: attachment_registry; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.attachment_registry (
    id bigint NOT NULL,
    proposal_id bigint,
    uploaded_by text,
    file_name text,
    relative_path text,
    content_hash text,
    vision_summary text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: attachment_registry_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap.attachment_registry ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap.attachment_registry_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: audit_log; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.audit_log (
    id bigint NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    action text NOT NULL,
    changed_by text,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    before_json jsonb,
    after_json jsonb,
    CONSTRAINT audit_log_action_check CHECK ((action = ANY (ARRAY['insert'::text, 'update'::text, 'delete'::text])))
);


--
-- Name: TABLE audit_log; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap.audit_log IS 'Cross-entity before/after audit trail; covers ACL, budget, agent, and resource changes';


--
-- Name: COLUMN audit_log.entity_id; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap.audit_log.entity_id IS 'PK of the affected row cast to text (int8 or text PK both fit)';


--
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap.audit_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: budget_allowance; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_efficiency.budget_allowance (
    id bigint NOT NULL,
    label text NOT NULL,
    owner_identity text NOT NULL,
    scope text NOT NULL,
    scope_ref text,
    allocated_usd numeric(14,2) NOT NULL,
    consumed_usd numeric(14,6) DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    valid_from timestamp with time zone DEFAULT now() NOT NULL,
    valid_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    team_id bigint,
    CONSTRAINT budget_allowance_positive CHECK ((allocated_usd > (0)::numeric)),
    CONSTRAINT budget_allowance_scope_check CHECK ((scope = ANY (ARRAY['global'::text, 'proposal'::text, 'team'::text])))
);


--
-- Name: TABLE budget_allowance; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap_efficiency.budget_allowance IS 'Named budget envelopes; consumed_usd maintained by spending_log insert trigger';


--
-- Name: COLUMN budget_allowance.team_id; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_efficiency.budget_allowance.team_id IS 'FK to team when scope=team; replaces opaque scope_ref text for team envelopes';


--
-- Name: budget_allowance_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap_efficiency.budget_allowance ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap_efficiency.budget_allowance_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: cache_hit_log; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_efficiency.cache_hit_log (
    id bigint NOT NULL,
    cache_write_id bigint NOT NULL,
    run_id text,
    agent_identity text NOT NULL,
    tokens_read integer NOT NULL,
    cost_saved_usd numeric(14,6) NOT NULL,
    hit_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE cache_hit_log; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap_efficiency.cache_hit_log IS 'Append-only hit log per cache entry; replaces mutable hit_count/cost_saved_usd on cache_write_log';


--
-- Name: COLUMN cache_hit_log.cost_saved_usd; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_efficiency.cache_hit_log.cost_saved_usd IS 'Saving for this specific hit = tokens_read * (normal_cost - cache_read_cost)';


--
-- Name: cache_hit_log_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap_efficiency.cache_hit_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap_efficiency.cache_hit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: cache_write_log; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_efficiency.cache_write_log (
    id bigint NOT NULL,
    agent_identity text NOT NULL,
    proposal_id bigint,
    model_name text NOT NULL,
    cache_key text NOT NULL,
    tokens_written integer NOT NULL,
    written_at timestamp with time zone DEFAULT now() NOT NULL,
    run_id text NOT NULL
);


--
-- Name: TABLE cache_write_log; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap_efficiency.cache_write_log IS 'Immutable record of a cache write event; hits tracked in cache_hit_log';


--
-- Name: cache_write_log_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap_efficiency.cache_write_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap_efficiency.cache_write_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: channel_subscription; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.channel_subscription (
    agent_identity text NOT NULL,
    channel text NOT NULL,
    subscribed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT channel_subscription_channel_check CHECK ((channel ~ '^(direct|team:.+|broadcast|system)$'::text))
);


--
-- Name: TABLE channel_subscription; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap.channel_subscription IS 'P149: Agents subscribed to channels for push notifications via pg_notify';


--
-- Name: COLUMN channel_subscription.agent_identity; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap.channel_subscription.agent_identity IS 'FK to agent_registry — the subscribing agent';


--
-- Name: COLUMN channel_subscription.channel; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap.channel_subscription.channel IS 'Channel pattern: direct, team:<name>, broadcast, system';


--
-- Name: context_window_log; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_efficiency.context_window_log (
    id bigint NOT NULL,
    agent_identity text NOT NULL,
    proposal_id bigint,
    model_name text NOT NULL,
    input_tokens integer NOT NULL,
    output_tokens integer NOT NULL,
    total_tokens integer GENERATED ALWAYS AS ((input_tokens + output_tokens)) STORED,
    context_limit integer,
    was_truncated boolean DEFAULT false NOT NULL,
    truncation_note text,
    run_id text,
    logged_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE context_window_log; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap_efficiency.context_window_log IS 'Per-run token usage; total_tokens is a generated column';


--
-- Name: context_window_log_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap_efficiency.context_window_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap_efficiency.context_window_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: cubics; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.cubics (
    cubic_id text DEFAULT (gen_random_uuid())::text NOT NULL,
    status text DEFAULT 'idle'::text NOT NULL,
    phase text DEFAULT 'design'::text NOT NULL,
    agent_identity text,
    worktree_path text,
    budget_usd numeric(10,2) DEFAULT 0,
    lock_holder text,
    lock_phase text,
    locked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    activated_at timestamp with time zone,
    completed_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb
);


--
-- Name: TABLE cubics; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap.cubics IS 'Isolated execution environments for agent workspaces (P058 Cubic Orchestration)';


--
-- Name: decision_queue; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.decision_queue (
    id bigint NOT NULL,
    proposal_id bigint NOT NULL,
    stage text NOT NULL,
    gate_number integer,
    requested_by text NOT NULL,
    evidence_summary text,
    estimated_cost_usd numeric(10,6),
    impact_score integer,
    status text DEFAULT 'pending'::text NOT NULL,
    outcome text,
    decided_by text,
    decision_notes text,
    process_after timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    CONSTRAINT decision_queue_gate_number_check CHECK (((gate_number >= 1) AND (gate_number <= 4))),
    CONSTRAINT decision_queue_impact_score_check CHECK (((impact_score >= 0) AND (impact_score <= 100))),
    CONSTRAINT decision_queue_outcome_check CHECK ((outcome = ANY (ARRAY['mature'::text, 'revise'::text, 'depend'::text, 'discard'::text]))),
    CONSTRAINT decision_queue_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'evaluating'::text, 'decided'::text, 'expired'::text])))
);


--
-- Name: decision_queue_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap.decision_queue ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap.decision_queue_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: embedding_index_registry; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.embedding_index_registry (
    id bigint NOT NULL,
    table_name text NOT NULL,
    row_id bigint NOT NULL,
    model_name text NOT NULL,
    embedding_dim integer NOT NULL,
    refreshed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE embedding_index_registry; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap.embedding_index_registry IS 'Tracks which model produced each body_vector and when; stale rows indicate a re-embed is needed after a model upgrade';


--
-- Name: COLUMN embedding_index_registry.table_name; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap.embedding_index_registry.table_name IS 'e.g. proposal, proposal_discussions, agent_memory';


--
-- Name: embedding_index_registry_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap.embedding_index_registry ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap.embedding_index_registry_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: escalation_log; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.escalation_log (
    id integer NOT NULL,
    obstacle_type text NOT NULL,
    proposal_id text,
    agent_identity text,
    escalated_to text NOT NULL,
    escalated_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolution_note text,
    severity text DEFAULT 'medium'::text NOT NULL,
    CONSTRAINT escalation_log_obstacle_type_check CHECK ((obstacle_type = ANY (ARRAY['BUDGET_EXHAUSTED'::text, 'LOOP_DETECTED'::text, 'CYCLE_DETECTED'::text, 'AGENT_DEAD'::text, 'PIPELINE_BLOCKED'::text, 'AC_GATE_FAILED'::text, 'DEPENDENCY_UNRESOLVED'::text]))),
    CONSTRAINT escalation_log_severity_check CHECK ((severity = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'critical'::text])))
);


--
-- Name: TABLE escalation_log; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap.escalation_log IS 'P078: Obstacle escalation records with resolution tracking';


--
-- Name: COLUMN escalation_log.obstacle_type; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap.escalation_log.obstacle_type IS 'Type of obstacle that triggered escalation';


--
-- Name: COLUMN escalation_log.escalated_to; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap.escalation_log.escalated_to IS 'Target squad, role, or human operator for resolution';


--
-- Name: escalation_log_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

CREATE SEQUENCE roadmap.escalation_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: escalation_log_id_seq; Type: SEQUENCE OWNED BY; Schema: roadmap; Owner: -
--

ALTER SEQUENCE roadmap.escalation_log_id_seq OWNED BY roadmap.escalation_log.id;


--
-- Name: extracted_patterns; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.extracted_patterns (
    id text NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    code_example text,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    usage_count integer DEFAULT 0 NOT NULL,
    success_rate integer DEFAULT 0 NOT NULL,
    related_entries jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT extracted_patterns_success_rate_check CHECK (((success_rate >= 0) AND (success_rate <= 100)))
);


--
-- Name: TABLE extracted_patterns; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap.extracted_patterns IS 'P061: Reusable patterns extracted from successful solutions';


--
-- Name: COLUMN extracted_patterns.success_rate; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap.extracted_patterns.success_rate IS 'Success rate percentage 0-100 when using this pattern';


--
-- Name: gate_task_templates; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.gate_task_templates (
    id bigint NOT NULL,
    gate_number integer NOT NULL,
    from_state text NOT NULL,
    to_state text NOT NULL,
    task_prompt text NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT gate_task_templates_gate_number_check CHECK (((gate_number >= 1) AND (gate_number <= 4)))
);


--
-- Name: TABLE gate_task_templates; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap.gate_task_templates IS 'Task prompts for each gate (D1–D4). Spawned agents receive these as their task.';


--
-- Name: gate_task_templates_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap.gate_task_templates ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap.gate_task_templates_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: knowledge_entries; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.knowledge_entries (
    id text NOT NULL,
    type text NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    keywords jsonb DEFAULT '[]'::jsonb NOT NULL,
    related_proposals jsonb DEFAULT '[]'::jsonb NOT NULL,
    source_proposal_id text,
    author text NOT NULL,
    confidence integer DEFAULT 50 NOT NULL,
    helpful_count integer DEFAULT 0 NOT NULL,
    reference_count integer DEFAULT 0 NOT NULL,
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_entries_confidence_check CHECK (((confidence >= 0) AND (confidence <= 100))),
    CONSTRAINT knowledge_entries_type_check CHECK ((type = ANY (ARRAY['solution'::text, 'pattern'::text, 'decision'::text, 'obstacle'::text, 'learned'::text])))
);


--
-- Name: TABLE knowledge_entries; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap.knowledge_entries IS 'P061: Persistent knowledge base entries for agent collective intelligence';


--
-- Name: COLUMN knowledge_entries.type; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap.knowledge_entries.type IS 'Entry type: solution, pattern, decision, obstacle, learned';


--
-- Name: COLUMN knowledge_entries.confidence; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap.knowledge_entries.confidence IS 'Confidence score 0-100; used for ranking in search results';


--
-- Name: maturity; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.maturity (
    level integer NOT NULL,
    name text NOT NULL,
    description text,
    CONSTRAINT maturity_level_check CHECK ((level >= 0))
);


--
-- Name: TABLE maturity; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap.maturity IS 'Lookup defining what each integer maturity level means; referenced by workflow_stages.maturity_gate. We simplify the scale to 0-3, added ''Obsolete'' as a possible state for old proposals that are no longer relevant';


--
-- Name: mcp_tool_assignment; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.mcp_tool_assignment (
    id bigint NOT NULL,
    agent_id bigint NOT NULL,
    tool_id bigint NOT NULL,
    is_enabled boolean DEFAULT true NOT NULL,
    granted_by text,
    granted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE mcp_tool_assignment; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap.mcp_tool_assignment IS 'Per-agent MCP tool enablement; only listed+enabled tools are accessible';


--
-- Name: mcp_tool_assignment_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap.mcp_tool_assignment ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap.mcp_tool_assignment_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: mcp_tool_registry; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.mcp_tool_registry (
    id bigint NOT NULL,
    tool_name text NOT NULL,
    tool_version text DEFAULT '1.0.0'::text NOT NULL,
    endpoint_url text,
    description text,
    capabilities jsonb,
    is_active boolean DEFAULT true NOT NULL,
    requires_auth boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE mcp_tool_registry; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap.mcp_tool_registry IS 'Catalogue of available MCP tools with endpoint and capability metadata';


--
-- Name: mcp_tool_registry_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap.mcp_tool_registry ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap.mcp_tool_registry_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: message_ledger; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.message_ledger (
    id bigint NOT NULL,
    from_agent text NOT NULL,
    to_agent text,
    channel text,
    message_type text DEFAULT 'text'::text,
    message_content text,
    proposal_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT message_ledger_channel_check CHECK (((channel IS NULL) OR (channel ~ '^(direct|team:.+|broadcast|system)$'::text))),
    CONSTRAINT message_ledger_type_check CHECK ((message_type = ANY (ARRAY['text'::text, 'task'::text, 'notify'::text, 'ack'::text, 'error'::text, 'event'::text])))
);


--
-- Name: COLUMN message_ledger.to_agent; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap.message_ledger.to_agent IS 'NULL = broadcast; from_agent has FK for referential integrity';


--
-- Name: COLUMN message_ledger.channel; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap.message_ledger.channel IS 'direct, team:<n>, broadcast, or system';


--
-- Name: message_ledger_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap.message_ledger ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap.message_ledger_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: model_assignment; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.model_assignment (
    id bigint NOT NULL,
    proposal_type text,
    pipeline_stage text,
    model_name text NOT NULL,
    priority integer DEFAULT 5 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE model_assignment; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap.model_assignment IS 'Maps proposal type + pipeline stage to preferred model; highest priority active row wins';


--
-- Name: model_assignment_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap.model_assignment ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap.model_assignment_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: model_metadata; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.model_metadata (
    id bigint NOT NULL,
    model_name text NOT NULL,
    provider text NOT NULL,
    cost_per_1k_input numeric(14,6),
    cost_per_1k_output numeric(14,6),
    max_tokens integer,
    context_window integer,
    capabilities jsonb,
    rating integer,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT model_metadata_rating_check CHECK (((rating >= 1) AND (rating <= 5)))
);


--
-- Name: TABLE model_metadata; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap.model_metadata IS 'Catalogue of LLM models with cost and capability metadata';


--
-- Name: COLUMN model_metadata.cost_per_1k_input; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap.model_metadata.cost_per_1k_input IS 'USD per 1k input tokens — 6dp to capture sub-cent pricing';


--
-- Name: COLUMN model_metadata.context_window; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap.model_metadata.context_window IS 'Maximum context window in tokens';


--
-- Name: COLUMN model_metadata.capabilities; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap.model_metadata.capabilities IS 'Feature flags: vision, tool_use, cache, json_mode, etc.';


--
-- Name: model_metadata_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap.model_metadata ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap.model_metadata_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: notification; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.notification (
    id bigint NOT NULL,
    recipient text NOT NULL,
    surface text NOT NULL,
    event_type text NOT NULL,
    payload jsonb,
    proposal_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source_event_id bigint,
    CONSTRAINT notification_surface_check CHECK ((surface = ANY (ARRAY['tui'::text, 'web'::text, 'mobile'::text, 'all'::text])))
);


--
-- Name: TABLE notification; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap.notification IS 'Fan-out notification table for TUI, Web Dashboard, and Mobile consumers';


--
-- Name: COLUMN notification.source_event_id; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap.notification.source_event_id IS 'Links notification back to the proposal_event that generated it';


--
-- Name: notification_delivery; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.notification_delivery (
    id bigint NOT NULL,
    notification_id bigint NOT NULL,
    surface text NOT NULL,
    delivered_at timestamp with time zone,
    acknowledged_at timestamp with time zone,
    failure_reason text,
    CONSTRAINT notification_delivery_surface_check CHECK ((surface = ANY (ARRAY['tui'::text, 'web'::text, 'mobile'::text])))
);


--
-- Name: TABLE notification_delivery; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap.notification_delivery IS 'Per-surface delivery receipt; a notification can be delivered to web but pending on mobile';


--
-- Name: COLUMN notification_delivery.acknowledged_at; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap.notification_delivery.acknowledged_at IS 'Set when user explicitly dismisses the notification on that surface';


--
-- Name: notification_delivery_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap.notification_delivery ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap.notification_delivery_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: notification_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap.notification ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap.notification_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: notification_queue; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.notification_queue (
    id bigint NOT NULL,
    proposal_id bigint,
    severity text DEFAULT 'INFO'::text NOT NULL,
    channel text DEFAULT 'discord'::text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    metadata jsonb,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    delivered_at timestamp with time zone,
    CONSTRAINT notification_queue_channel_check CHECK ((channel = ANY (ARRAY['discord'::text, 'email'::text, 'sms'::text, 'push'::text, 'digest'::text]))),
    CONSTRAINT notification_queue_severity_check CHECK ((severity = ANY (ARRAY['INFO'::text, 'ALERT'::text, 'URGENT'::text, 'CRITICAL'::text]))),
    CONSTRAINT notification_queue_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text, 'suppressed'::text])))
);


--
-- Name: notification_queue_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap.notification_queue ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap.notification_queue_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: prompt_template; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.prompt_template (
    id bigint NOT NULL,
    name text NOT NULL,
    version integer NOT NULL,
    proposal_type text,
    pipeline_stage text,
    content text NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE prompt_template; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap.prompt_template IS 'Versioned system prompts and context preambles; agents resolve by type+stage, highest active version wins';


--
-- Name: COLUMN prompt_template.proposal_type; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap.prompt_template.proposal_type IS 'NULL = default for all types; specific type overrides the default';


--
-- Name: COLUMN prompt_template.pipeline_stage; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap.prompt_template.pipeline_stage IS 'NULL = applies to all stages; specific stage overrides';


--
-- Name: prompt_template_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap.prompt_template ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap.prompt_template_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: proposal; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_proposal.proposal (
    id bigint NOT NULL,
    display_id text NOT NULL,
    parent_id bigint,
    type text NOT NULL,
    status text DEFAULT 'Draft'::text NOT NULL,
    title text NOT NULL,
    summary text,
    motivation text,
    design text,
    drawbacks text,
    alternatives text,
    dependency text,
    priority text,
    maturity            text DEFAULT 'new'::text NOT NULL,
    workflow_name text DEFAULT 'RFC 5-Stage'::text,
    status_term_category text GENERATED ALWAYS AS ('proposal_state'::text) STORED,
    maturity_term_category text GENERATED ALWAYS AS ('maturity'::text) STORED,
    body_vector public.vector(1536),
    tags jsonb,
    audit jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    modified_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT proposal_maturity_check CHECK ((maturity = ANY (ARRAY['new'::text, 'active'::text, 'mature'::text, 'obsolete'::text])))
);


--
-- Name: COLUMN proposal.id; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_proposal.proposal.id IS 'Auto-generated identity; referenced by other objects';


--
-- Name: COLUMN proposal.display_id; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_proposal.proposal.display_id IS 'P+number id used in lists/display — P001, P042, P1001 — auto-filled by trigger';


--
-- Name: COLUMN proposal.parent_id; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_proposal.proposal.parent_id IS 'Parent proposal id; constructs a hierarchical relation';


--
-- Name: COLUMN proposal.type; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_proposal.proposal.type IS 'Controlled term for proposal type; dictates workflow via proposal_type_config';


--
-- Name: COLUMN proposal.status; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_proposal.proposal.status IS 'Current state within the workflow state machine; values are open, validated against proposal_valid_transitions';


--
-- Name: COLUMN proposal.maturity; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_proposal.proposal.maturity IS '{"Draft":"Mature","Review":"Mature","Develop":"Active"}';


--
-- Name: COLUMN proposal.dependency; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_proposal.proposal.dependency IS 'Prose description of dependencies; structured dependencies live in proposal_dependencies';


--
-- Name: COLUMN proposal.priority; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_proposal.proposal.priority IS 'Loosely described priority in markdown; queue ordering is DAG-derived via v_proposal_queue, not this field';


--
-- Name: COLUMN proposal.body_vector; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_proposal.proposal.body_vector IS 'pgvector embedding for semantic search';


--
-- Name: COLUMN proposal.tags; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_proposal.proposal.tags IS 'Search tags; may include category, domain, and intelligently identified keywords';


--
-- Name: COLUMN proposal.audit; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_proposal.proposal.audit IS 'Array of audit events: [{"TS":"<iso8601>","Agent":"<name>","Activity":"<verb>","Reason":"<text>"}]';


--
-- Name: COLUMN proposal.maturity; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_proposal.proposal.maturity IS 'Current maturity within the active state. Universal lifecycle: new → active → mature → obsolete. Repeats within each state as proposals iterate. When set to mature, triggers gate pipeline via trg_gate_ready. History is in proposal_maturity_transitions (timestamped, decision-backed).';


--
-- Name: proposal_acceptance_criteria; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_proposal.proposal_acceptance_criteria (
    id bigint NOT NULL,
    proposal_id bigint NOT NULL,
    item_number integer NOT NULL,
    criterion_text text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    verified_by text,
    verification_notes text,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT proposal_ac_item_positive CHECK ((item_number > 0)),
    CONSTRAINT proposal_ac_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'pass'::text, 'fail'::text, 'blocked'::text, 'waived'::text])))
);


--
-- Name: proposal_acceptance_criteria_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap_proposal.proposal_acceptance_criteria ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap_proposal.proposal_acceptance_criteria_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



--
-- Name: proposal_decision; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_proposal.proposal_decision (
    id bigint NOT NULL,
    proposal_id bigint NOT NULL,
    decision text NOT NULL,
    authority text NOT NULL,
    rationale text,
    binding boolean DEFAULT true NOT NULL,
    decided_at timestamp with time zone DEFAULT now() NOT NULL,
    superseded_by bigint,
    CONSTRAINT proposal_decision_decision_check CHECK ((decision = ANY (ARRAY['approved'::text, 'rejected'::text, 'deferred'::text, 'escalated'::text])))
);


--
-- Name: TABLE proposal_decision; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap_proposal.proposal_decision IS 'Formal approve/reject/defer/escalate decisions with authority and rationale';


--
-- Name: COLUMN proposal_decision.binding; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_proposal.proposal_decision.binding IS 'True = decision is final and pipeline-enforced; false = advisory only';


--
-- Name: COLUMN proposal_decision.superseded_by; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_proposal.proposal_decision.superseded_by IS 'Points to the newer decision if this one was overturned';


--
-- Name: proposal_decision_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap_proposal.proposal_decision ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap_proposal.proposal_decision_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: proposal_dependencies; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_proposal.proposal_dependencies (
    id bigint NOT NULL,
    from_proposal_id bigint NOT NULL,
    to_proposal_id bigint NOT NULL,
    dependency_type text DEFAULT 'blocks'::text NOT NULL,
    resolved boolean DEFAULT false NOT NULL,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT proposal_deps_no_self CHECK ((from_proposal_id <> to_proposal_id)),
    CONSTRAINT proposal_deps_type_check CHECK ((dependency_type = ANY (ARRAY['blocks'::text, 'depended_by'::text, 'supersedes'::text, 'relates'::text])))
);


--
-- Name: TABLE proposal_dependencies; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap_proposal.proposal_dependencies IS 'Structured DAG of proposal dependencies; drives queue priority in v_proposal_queue';


--
-- Name: proposal_dependencies_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap_proposal.proposal_dependencies ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap_proposal.proposal_dependencies_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: proposal_discussions; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_proposal.proposal_discussions (
    id bigint NOT NULL,
    proposal_id bigint NOT NULL,
    parent_id bigint,
    author_identity text NOT NULL,
    context_prefix text,
    body text NOT NULL,
    body_markdown text,
    body_vector public.vector(1536),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT proposal_discussions_context_check CHECK ((context_prefix = ANY (ARRAY['arch:'::text, 'team:'::text, 'critical:'::text, 'security:'::text, 'general:'::text, 'feedback:'::text, 'concern:'::text, 'poc:'::text])))
);


--
-- Name: proposal_discussions_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap_proposal.proposal_discussions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap_proposal.proposal_discussions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: proposal_event; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_proposal.proposal_event (
    id bigint NOT NULL,
    proposal_id bigint NOT NULL,
    event_type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    dispatched_at timestamp with time zone,
    CONSTRAINT proposal_event_type_check CHECK ((event_type = ANY (ARRAY['status_changed'::text, 'decision_made'::text, 'lease_claimed'::text, 'lease_released'::text, 'dependency_added'::text, 'dependency_resolved'::text, 'ac_updated'::text, 'review_submitted'::text, 'maturity_changed'::text, 'milestone_achieved'::text, 'proposal_created'::text])))
);


--
-- Name: TABLE proposal_event; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap_proposal.proposal_event IS 'Transactional outbox: one row per domain event, written atomically with the mutation that caused it';


--
-- Name: COLUMN proposal_event.dispatched_at; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_proposal.proposal_event.dispatched_at IS 'Set by the dispatcher after successful delivery; NULL = pending';


--
-- Name: proposal_event_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap_proposal.proposal_event ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap_proposal.proposal_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: proposal_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap_proposal.proposal ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap_proposal.proposal_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: proposal_labels; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_proposal.proposal_labels (
    proposal_id bigint NOT NULL,
    label text NOT NULL,
    applied_by text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: proposal_lease; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_proposal.proposal_lease (
    id bigint NOT NULL,
    proposal_id bigint NOT NULL,
    agent_identity text NOT NULL,
    claimed_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    released_at timestamp with time zone,
    release_reason text,
    is_active boolean GENERATED ALWAYS AS ((released_at IS NULL)) STORED
);


--
-- Name: TABLE proposal_lease; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap_proposal.proposal_lease IS 'Claim/lease model: an agent claims a proposal to work on it; one active lease per proposal at a time';


--
-- Name: COLUMN proposal_lease.expires_at; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_proposal.proposal_lease.expires_at IS 'Optional TTL; expired leases should be reaped by a scheduled job';


--
-- Name: COLUMN proposal_lease.release_reason; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_proposal.proposal_lease.release_reason IS 'Why the lease was released: completed, expired, reassigned, etc.';


--
-- Name: COLUMN proposal_lease.is_active; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_proposal.proposal_lease.is_active IS 'Generated column: true while released_at IS NULL';


--
-- Name: proposal_lease_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap_proposal.proposal_lease ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap_proposal.proposal_lease_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: proposal_maturity_transitions; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_proposal.proposal_maturity_transitions (
    id bigint NOT NULL,
    proposal_id bigint NOT NULL,
    from_maturity text NOT NULL,
    to_maturity text NOT NULL,
    transition_reason text NOT NULL,
    transitioned_by text NOT NULL,
    decision_notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT proposal_maturity_trans_from_check CHECK ((from_maturity = ANY (ARRAY['new'::text, 'active'::text, 'mature'::text, 'obsolete'::text]))),
    CONSTRAINT proposal_maturity_trans_reason_check CHECK ((transition_reason = ANY (ARRAY['submit'::text, 'decision'::text, 'system'::text]))),
    CONSTRAINT proposal_maturity_trans_to_check CHECK ((to_maturity = ANY (ARRAY['new'::text, 'active'::text, 'mature'::text, 'obsolete'::text])))
);


--
-- Name: TABLE proposal_maturity_transitions; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap_proposal.proposal_maturity_transitions IS 'Timestamped ledger of maturity lifecycle changes within each state. Every transition is backed by agent identity and optional decision notes. This replaces the old JSONB maturity map — history via transitions, not inline.';


--
-- Name: proposal_maturity_transitions_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap_proposal.proposal_maturity_transitions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap_proposal.proposal_maturity_transitions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: proposal_milestone; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_proposal.proposal_milestone (
    id bigint NOT NULL,
    proposal_id bigint NOT NULL,
    label text NOT NULL,
    due_at timestamp with time zone,
    achieved_at timestamp with time zone,
    status text DEFAULT 'pending'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT proposal_milestone_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'achieved'::text, 'missed'::text, 'waived'::text])))
);


--
-- Name: proposal_milestone_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap_proposal.proposal_milestone ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap_proposal.proposal_milestone_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: proposal_reviews; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_proposal.proposal_reviews (
    id bigint NOT NULL,
    proposal_id bigint NOT NULL,
    reviewer_identity text NOT NULL,
    verdict text NOT NULL,
    findings jsonb,
    notes text,
    comment text,
    is_blocking boolean DEFAULT false NOT NULL,
    reviewed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT proposal_reviews_verdict_check CHECK ((verdict = ANY (ARRAY['approve'::text, 'request_changes'::text, 'reject'::text])))
);


--
-- Name: proposal_reviews_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap_proposal.proposal_reviews ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap_proposal.proposal_reviews_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: proposal_state_transitions; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_proposal.proposal_state_transitions (
    id bigint NOT NULL,
    proposal_id bigint NOT NULL,
    from_state text NOT NULL,
    to_state text NOT NULL,
    transition_reason text NOT NULL,
    transitioned_by text,
    depends_on_id bigint,
    notes text,
    emoji character(4),
    transitioned_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: COLUMN proposal_state_transitions.transition_reason; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_proposal.proposal_state_transitions.transition_reason IS 'Open text — validated against proposal_valid_transitions at application layer, not by CHECK';


--
-- Name: COLUMN proposal_state_transitions.depends_on_id; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_proposal.proposal_state_transitions.depends_on_id IS 'FK to proposal.id — dependency that unblocked or triggered this transition';


--
-- Name: proposal_state_transitions_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap_proposal.proposal_state_transitions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap_proposal.proposal_state_transitions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: proposal_template; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_proposal.proposal_template (
    id bigint NOT NULL,
    type text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    label text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    summary_md text,
    motivation_md text,
    design_md text,
    drawbacks_md text,
    alternatives_md text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE proposal_template; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap_proposal.proposal_template IS 'Versioned content scaffolds per proposal type; default template is pre-filled by fn_spawn_workflow on insert';


--
-- Name: COLUMN proposal_template.is_default; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_proposal.proposal_template.is_default IS 'Only one default per type; enforced by partial unique index below';


--
-- Name: proposal_template_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap_proposal.proposal_template ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap_proposal.proposal_template_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: proposal_type_config; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_proposal.proposal_type_config (
    type text NOT NULL,
    workflow_name text NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    required_fields text[] DEFAULT ARRAY[]::text[] NOT NULL,
    optional_fields text[] DEFAULT ARRAY[]::text[] NOT NULL
);


--
-- Name: TABLE proposal_type_config; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap_proposal.proposal_type_config IS 'Binds each proposal type to its workflow template; type → workflow is the authoritative mapping';


--
-- Name: COLUMN proposal_type_config.workflow_name; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_proposal.proposal_type_config.workflow_name IS 'Changing this affects new proposals of this type; in-flight proposals keep their existing workflow instance';


--
-- Name: COLUMN proposal_type_config.required_fields; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_proposal.proposal_type_config.required_fields IS 'Proposal fields that must be non-null for this type, e.g. {motivation,design} for RFC';


--
-- Name: COLUMN proposal_type_config.optional_fields; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_proposal.proposal_type_config.optional_fields IS 'Fields shown in the editor for this type but not mandatory';


--
-- Name: proposal_valid_transitions; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_proposal.proposal_valid_transitions (
    id bigint NOT NULL,
    workflow_name text NOT NULL,
    from_state text NOT NULL,
    to_state text NOT NULL,
    allowed_reasons text[],
    allowed_roles text[],
    requires_ac text DEFAULT 'none'::text NOT NULL,
    CONSTRAINT proposal_valid_transitions_ac_check CHECK ((requires_ac = ANY (ARRAY['none'::text, 'all'::text, 'critical'::text])))
);


--
-- Name: TABLE proposal_valid_transitions; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap_proposal.proposal_valid_transitions IS 'Valid state machine edges per workflow; status values are open — validated here, not by a CHECK constraint on proposal';


--
-- Name: proposal_valid_transitions_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap_proposal.proposal_valid_transitions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap_proposal.proposal_valid_transitions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: proposal_version; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_proposal.proposal_version (
    id bigint NOT NULL,
    proposal_id bigint NOT NULL,
    author_identity text NOT NULL,
    version_number integer NOT NULL,
    change_summary text,
    body_delta text,
    metadata_delta_json jsonb,
    git_commit_sha text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: proposal_version_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap_proposal.proposal_version ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap_proposal.proposal_version_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: proposal_versions; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_proposal.proposal_versions (
    id bigint NOT NULL,
    proposal_id bigint NOT NULL,
    version_number integer NOT NULL,
    body_markdown text NOT NULL,
    diff_summary text,
    git_sha text,
    committed_by text NOT NULL,
    committed_at timestamp with time zone DEFAULT now()
);


--
-- Name: proposal_versions_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap_proposal.proposal_versions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap_proposal.proposal_versions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: research_cache; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.research_cache (
    id bigint NOT NULL,
    proposal_id bigint,
    agent_identity text NOT NULL,
    topic text NOT NULL,
    content text NOT NULL,
    source_url text,
    source_type text DEFAULT 'web_fetch'::text,
    relevance_score numeric(4,3) DEFAULT 0.5,
    tags text[],
    is_superseded boolean DEFAULT false NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT research_cache_source_type_check CHECK ((source_type = ANY (ARRAY['web_fetch'::text, 'codebase_scan'::text, 'adr'::text, 'manual'::text, 'agent_synthesis'::text])))
);


--
-- Name: research_cache_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap.research_cache ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap.research_cache_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: resource_allocation; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.resource_allocation (
    id bigint NOT NULL,
    agent_id bigint NOT NULL,
    resource_type text NOT NULL,
    resource_key text NOT NULL,
    label text,
    is_active boolean DEFAULT true NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT resource_allocation_type_check CHECK ((resource_type = ANY (ARRAY['api_key'::text, 'worktree'::text, 'workspace'::text, 'mcp_tool'::text, 'budget'::text])))
);


--
-- Name: TABLE resource_allocation; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap.resource_allocation IS 'Maps agents to allocated resources: API keys, worktrees, workspaces, MCP tools';


--
-- Name: COLUMN resource_allocation.resource_key; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap.resource_allocation.resource_key IS 'Encrypted identifier or path; never store raw secrets here';


--
-- Name: resource_allocation_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap.resource_allocation ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap.resource_allocation_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: run_log; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.run_log (
    run_id text NOT NULL,
    agent_identity text NOT NULL,
    proposal_id bigint,
    model_name text,
    pipeline_stage text,
    status text DEFAULT 'running'::text NOT NULL,
    input_summary text,
    error_message text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT run_log_status_check CHECK ((status = ANY (ARRAY['running'::text, 'success'::text, 'error'::text, 'cancelled'::text])))
);


--
-- Name: TABLE run_log; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap.run_log IS 'Central run record; run_id anchors spending_log, context_window_log, and cache_write_log';


--
-- Name: COLUMN run_log.run_id; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap.run_log.run_id IS 'Caller-assigned key (UUID recommended); set before writing any child log rows';


--
-- Name: COLUMN run_log.input_summary; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap.run_log.input_summary IS 'Short description of what the run was asked to do; not the full prompt';


--
-- Name: scheduled_job; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.scheduled_job (
    id bigint NOT NULL,
    job_name text NOT NULL,
    description text,
    cron_expr text NOT NULL,
    is_enabled boolean DEFAULT true NOT NULL,
    last_run_at timestamp with time zone,
    last_status text,
    last_error text,
    last_duration_ms integer,
    next_run_at timestamp with time zone,
    run_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT scheduled_job_status_check CHECK (((last_status IS NULL) OR (last_status = ANY (ARRAY['ok'::text, 'error'::text, 'running'::text, 'skipped'::text]))))
);


--
-- Name: TABLE scheduled_job; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap.scheduled_job IS 'Registry and last-run state for all background maintenance jobs';


--
-- Name: COLUMN scheduled_job.cron_expr; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap.scheduled_job.cron_expr IS 'Standard cron expression, e.g. 0 * * * * for hourly';


--
-- Name: scheduled_job_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap.scheduled_job ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap.scheduled_job_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: spending_caps; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_efficiency.spending_caps (
    agent_identity text NOT NULL,
    daily_limit_usd numeric(12,2),
    monthly_limit_usd numeric(14,2),
    is_frozen boolean DEFAULT false NOT NULL,
    frozen_reason text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE spending_caps; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap_efficiency.spending_caps IS 'Per-agent spend limits; daily totals derived from spending_log, never stored here';


--
-- Name: COLUMN spending_caps.is_frozen; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_efficiency.spending_caps.is_frozen IS 'When true, agent cannot incur further costs until manually unfrozen';


--
-- Name: spending_log; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_efficiency.spending_log (
    id bigint NOT NULL,
    agent_identity text NOT NULL,
    proposal_id bigint,
    model_name text,
    cost_usd numeric(14,6) NOT NULL,
    token_count integer,
    run_id text,
    budget_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT spending_log_cost_positive CHECK ((cost_usd >= (0)::numeric))
);


--
-- Name: TABLE spending_log; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap_efficiency.spending_log IS 'Immutable cost ledger; daily/monthly totals are always derived, never stored';


--
-- Name: COLUMN spending_log.cost_usd; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap_efficiency.spending_log.cost_usd IS 'Per-event cost in USD to 6dp; matches model_metadata precision';


--
-- Name: spending_log_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap_efficiency.spending_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap_efficiency.spending_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: team; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_workforce.team (
    id bigint NOT NULL,
    team_name text NOT NULL,
    team_type text,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT team_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))
);


--
-- Name: team_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap_workforce.team ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap.team_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: team_member; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap_workforce.team_member (
    id bigint NOT NULL,
    team_id bigint NOT NULL,
    agent_id bigint NOT NULL,
    role text,
    joined_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: team_member_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap_workforce.team_member ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap_workforce.team_member_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: transition_queue; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.transition_queue (
    id bigint NOT NULL,
    proposal_id bigint NOT NULL,
    from_stage text NOT NULL,
    to_stage text NOT NULL,
    triggered_by text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    process_after timestamp with time zone DEFAULT now() NOT NULL,
    processing_at timestamp with time zone,
    completed_at timestamp with time zone,
    last_error text,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    gate text,
    CONSTRAINT transition_queue_gate_check CHECK (((gate IS NULL) OR (gate = ANY (ARRAY['D1'::text, 'D2'::text, 'D3'::text, 'D4'::text])))),
    CONSTRAINT transition_queue_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'done'::text, 'failed'::text])))
);


--
-- Name: COLUMN transition_queue.gate; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap.transition_queue.gate IS 'Gate number (D1–D4) for gate-initiated transitions. NULL for manual/agent-initiated transitions. Used with proposal_id for dedup: one pending gate entry per proposal.';


--
-- Name: transition_queue_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap.transition_queue ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap.transition_queue_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: user_session; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.user_session (
    id bigint NOT NULL,
    agent_identity text NOT NULL,
    surface text NOT NULL,
    session_token text NOT NULL,
    preferences jsonb,
    ip_address text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_active_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    CONSTRAINT user_session_surface_check CHECK ((surface = ANY (ARRAY['tui'::text, 'web'::text, 'mobile'::text])))
);


--
-- Name: TABLE user_session; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap.user_session IS 'Active sessions for human users across TUI, Web Dashboard, and Mobile surfaces';


--
-- Name: user_session_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap.user_session ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap.user_session_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: v_active_leases; Type: VIEW; Schema: roadmap; Owner: -
--

CREATE VIEW roadmap_proposal.v_active_leases AS
 SELECT pl.id,
    p.display_id,
    p.type,
    p.status,
    pl.agent_identity,
    pl.claimed_at,
    pl.expires_at,
        CASE
            WHEN (pl.expires_at IS NULL) THEN 'open'::text
            WHEN (pl.expires_at > now()) THEN 'active'::text
            ELSE 'expired'::text
        END AS lease_status
   FROM (roadmap_proposal.proposal_lease pl
     JOIN roadmap_proposal.proposal p ON ((p.id = pl.proposal_id)))
  WHERE (pl.released_at IS NULL);


--
-- Name: v_active_memory; Type: VIEW; Schema: roadmap; Owner: -
--

CREATE VIEW roadmap.v_active_memory AS
 SELECT id,
    agent_identity,
    layer,
    key,
    value,
    metadata,
    ttl_seconds,
    expires_at,
    body_vector,
    created_at,
    updated_at
   FROM roadmap_efficiency.agent_memory
  WHERE ((expires_at IS NULL) OR (expires_at > now()));


--
-- Name: v_blocked_proposals; Type: VIEW; Schema: roadmap; Owner: -
--

CREATE VIEW roadmap_proposal.v_blocked_proposals AS
 SELECT p.display_id AS blocked_proposal,
    pb.display_id AS blocked_by_proposal,
    d.dependency_type,
    d.created_at AS since
   FROM ((roadmap_proposal.proposal_dependencies d
     JOIN roadmap_proposal.proposal p ON ((p.id = d.from_proposal_id)))
     JOIN roadmap_proposal.proposal pb ON ((pb.id = d.to_proposal_id)))
  WHERE ((d.resolved = false) AND (d.dependency_type = 'blocks'::text));


--
-- Name: v_capable_agents; Type: VIEW; Schema: roadmap; Owner: -
--

CREATE VIEW roadmap.v_capable_agents AS
 SELECT ar.id,
    ar.agent_identity,
    ar.agent_type,
    ar.status,
    ac.capability,
    ac.proficiency,
    COALESCE(aw.active_lease_count, 0) AS active_leases,
    COALESCE(aw.context_load_score, (0)::numeric) AS context_load
   FROM ((roadmap_workforce.agent_registry ar
     JOIN roadmap_workforce.agent_capability ac ON ((ac.agent_id = ar.id)))
     LEFT JOIN roadmap_workforce.agent_workload aw ON ((aw.agent_id = ar.id)))
  WHERE (ar.status = 'active'::text);


--
-- Name: VIEW v_capable_agents; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON VIEW roadmap.v_capable_agents IS 'Active agents with their capabilities and current workload; filter on capability + proficiency, order by active_leases ASC to route leases';


--
-- Name: v_daily_spend; Type: VIEW; Schema: roadmap; Owner: -
--

CREATE VIEW roadmap.v_daily_spend AS
 SELECT agent_identity,
    (date_trunc('day'::text, created_at))::date AS spend_date,
    sum(cost_usd) AS total_usd,
    count(*) AS event_count
   FROM roadmap_efficiency.spending_log
  GROUP BY agent_identity, ((date_trunc('day'::text, created_at))::date);


--
-- Name: v_known_states; Type: VIEW; Schema: roadmap; Owner: -
--

CREATE VIEW roadmap.v_known_states AS
 SELECT DISTINCT proposal_valid_transitions.workflow_name,
    proposal_valid_transitions.from_state AS state
   FROM roadmap_proposal.proposal_valid_transitions
UNION
 SELECT DISTINCT proposal_valid_transitions.workflow_name,
    proposal_valid_transitions.to_state AS state
   FROM roadmap_proposal.proposal_valid_transitions;


--
-- Name: v_mature_queue; Type: VIEW; Schema: roadmap; Owner: -
--

CREATE VIEW roadmap_proposal.v_mature_queue AS
 SELECT p.id,
    p.display_id,
    p.type,
    p.title,
    p.status,
    p.maturity,
    p.priority,
    p.created_at,
    COALESCE(bc.blocker_count, (0)::bigint) AS blocks_count,
    COALESCE(dc.dep_count, (0)::bigint) AS depends_on_count
   FROM ((roadmap_proposal.proposal p
     LEFT JOIN ( SELECT proposal_dependencies.from_proposal_id AS proposal_id,
            count(*) AS blocker_count
           FROM roadmap_proposal.proposal_dependencies
          WHERE ((proposal_dependencies.resolved = false) AND (proposal_dependencies.dependency_type = 'blocks'::text))
          GROUP BY proposal_dependencies.from_proposal_id) bc ON ((bc.proposal_id = p.id)))
     LEFT JOIN ( SELECT proposal_dependencies.to_proposal_id AS proposal_id,
            count(*) AS dep_count
           FROM roadmap_proposal.proposal_dependencies
          WHERE ((proposal_dependencies.resolved = false) AND (proposal_dependencies.dependency_type = 'blocks'::text))
          GROUP BY proposal_dependencies.to_proposal_id) dc ON ((dc.proposal_id = p.id)))
  WHERE (p.maturity = 'mature'::text)
  ORDER BY bc.blocker_count DESC NULLS LAST, p.created_at;


--
-- Name: VIEW v_mature_queue; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON VIEW roadmap_proposal.v_mature_queue IS 'Proposals at mature maturity, ready for gate evaluation. Ordered by how many others they block (most impactful first).';


--
-- Name: webhook_subscription; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.webhook_subscription (
    id bigint NOT NULL,
    label text NOT NULL,
    endpoint_url text NOT NULL,
    event_types text[] NOT NULL,
    secret_hash text,
    is_active boolean DEFAULT true NOT NULL,
    last_delivery_at timestamp with time zone,
    last_status text,
    failure_count integer DEFAULT 0 NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE webhook_subscription; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap.webhook_subscription IS 'External subscribers to proposal_event; delivered by webhook_dispatcher job';


--
-- Name: COLUMN webhook_subscription.event_types; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap.webhook_subscription.event_types IS 'Array of event_type values from proposal_event this subscriber wants, e.g. {status_changed,decision_made}';


--
-- Name: COLUMN webhook_subscription.secret_hash; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap.webhook_subscription.secret_hash IS 'Store only the HMAC hash; plaintext secret lives only with the subscriber';


--
-- Name: COLUMN webhook_subscription.failure_count; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON COLUMN roadmap.webhook_subscription.failure_count IS 'Dispatcher increments on delivery failure; subscriber auto-disabled at threshold';


--
-- Name: v_pending_events; Type: VIEW; Schema: roadmap; Owner: -
--

CREATE VIEW roadmap.v_pending_events AS
 SELECT pe.id,
    pe.proposal_id,
    pe.event_type,
    pe.payload,
    pe.created_at,
    count(ws.id) AS subscriber_count
   FROM (roadmap_proposal.proposal_event pe
     JOIN roadmap.webhook_subscription ws ON (((ws.is_active = true) AND (pe.event_type = ANY (ws.event_types)))))
  WHERE (pe.dispatched_at IS NULL)
  GROUP BY pe.id, pe.proposal_id, pe.event_type, pe.payload, pe.created_at;


--
-- Name: VIEW v_pending_events; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON VIEW roadmap.v_pending_events IS 'Undispatched outbox events with active subscriber count; polled by webhook_dispatcher job';


--
-- Name: v_proposal_blocked_status; Type: VIEW; Schema: roadmap; Owner: -
--

CREATE VIEW roadmap_proposal.v_proposal_blocked_status AS
 SELECT id,
    display_id,
    status,
    (EXISTS ( SELECT 1
           FROM roadmap_proposal.proposal_dependencies d
          WHERE ((d.from_proposal_id = p.id) AND (d.dependency_type = 'blocks'::text) AND (d.resolved = false)))) AS is_blocked,
    ( SELECT count(*) AS count
           FROM roadmap_proposal.proposal_dependencies d
          WHERE ((d.from_proposal_id = p.id) AND (d.resolved = false))) AS unresolved_dep_count
   FROM roadmap_proposal.proposal p;


--
-- Name: VIEW v_proposal_blocked_status; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON VIEW roadmap_proposal.v_proposal_blocked_status IS 'Dynamically computed block status per proposal; no stored flag — always current';


--
-- Name: workflow_templates; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.workflow_templates (
    id bigint NOT NULL,
    name text NOT NULL,
    description text,
    version text DEFAULT '1.0.0'::text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    is_system boolean DEFAULT false NOT NULL,
    stage_count integer,
    smdl_id text,
    smdl_definition jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    modified_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE workflow_templates; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap.workflow_templates IS 'Named workflow blueprints; bound to proposal types via proposal_type_config';


--
-- Name: workflows; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.workflows (
    id bigint NOT NULL,
    template_id bigint NOT NULL,
    proposal_id bigint NOT NULL,
    current_stage text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);


--
-- Name: TABLE workflows; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON TABLE roadmap.workflows IS 'Live workflow instance per proposal; template_id is the snapshot of the type config at creation time';


--
-- Name: v_proposal_full; Type: VIEW; Schema: roadmap; Owner: -
--

CREATE VIEW roadmap_proposal.v_proposal_full AS
 SELECT p.id,
    p.display_id,
    p.parent_id,
    p.type,
    p.status,
    p.maturity,
    p.title,
    p.summary,
    p.motivation,
    p.design,
    p.drawbacks,
    p.alternatives,
    p.dependency,
    p.priority,
    p.tags,
    p.audit,
    p.created_at,
    p.modified_at,
    COALESCE(dep.deps, '[]'::jsonb) AS dependencies,
    COALESCE(ac.criteria, '[]'::jsonb) AS acceptance_criteria,
    "dec".latest_decision,
    "dec".decision_at,
    lease.leased_by,
    lease.lease_expires,
    wf.workflow_name,
    wf.current_stage
   FROM (((((roadmap_proposal.proposal p
     LEFT JOIN LATERAL ( SELECT jsonb_agg(jsonb_build_object('to_display_id', pd.display_id, 'dependency_type', d.dependency_type, 'resolved', d.resolved)) AS deps
           FROM (roadmap_proposal.proposal_dependencies d
             JOIN roadmap_proposal.proposal pd ON ((pd.id = d.to_proposal_id)))
          WHERE (d.from_proposal_id = p.id)) dep ON (true))
     LEFT JOIN LATERAL ( SELECT jsonb_agg(jsonb_build_object('item_number', ac_1.item_number, 'criterion_text', ac_1.criterion_text, 'status', ac_1.status, 'verified_by', ac_1.verified_by) ORDER BY ac_1.item_number) AS criteria
           FROM roadmap_proposal.proposal_acceptance_criteria ac_1
          WHERE (ac_1.proposal_id = p.id)) ac ON (true))
     LEFT JOIN LATERAL ( SELECT pd.decision AS latest_decision,
            pd.decided_at AS decision_at
           FROM roadmap_proposal.proposal_decision pd
          WHERE (pd.proposal_id = p.id)
          ORDER BY pd.decided_at DESC
         LIMIT 1) "dec" ON (true))
     LEFT JOIN LATERAL ( SELECT pl.agent_identity AS leased_by,
            pl.expires_at AS lease_expires
           FROM roadmap_proposal.proposal_lease pl
          WHERE ((pl.proposal_id = p.id) AND (pl.released_at IS NULL))
          ORDER BY pl.claimed_at DESC
         LIMIT 1) lease ON (true))
     LEFT JOIN LATERAL ( SELECT ptc.workflow_name,
            w.current_stage
           FROM ((roadmap.workflows w
             JOIN roadmap.workflow_templates wt ON ((wt.id = w.template_id)))
             JOIN roadmap_proposal.proposal_type_config ptc ON ((ptc.workflow_name = wt.name)))
          WHERE (w.proposal_id = p.id)
         LIMIT 1) wf ON (true));


--
-- Name: VIEW v_proposal_full; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON VIEW roadmap_proposal.v_proposal_full IS 'Complete proposal with all child tables as JSONB. Used by MCP tools for full proposal rendering.';


--
-- Name: v_proposal_queue; Type: VIEW; Schema: roadmap; Owner: -
--

CREATE VIEW roadmap_proposal.v_proposal_queue AS
 WITH blocker_counts AS (
         SELECT proposal_dependencies.to_proposal_id AS proposal_id,
            count(*) AS blocker_count
           FROM roadmap_proposal.proposal_dependencies
          WHERE ((proposal_dependencies.resolved = false) AND (proposal_dependencies.dependency_type = 'blocks'::text))
          GROUP BY proposal_dependencies.to_proposal_id
        ), dependency_depth AS (
         SELECT proposal_dependencies.from_proposal_id AS proposal_id,
            count(*) AS dep_count
           FROM roadmap_proposal.proposal_dependencies
          WHERE (proposal_dependencies.resolved = false)
          GROUP BY proposal_dependencies.from_proposal_id
        )
 SELECT p.id,
    p.display_id,
    p.type,
    p.title,
    p.status,
    p.maturity,
    COALESCE(bc.blocker_count, (0)::bigint) AS blocks_count,
    COALESCE(dd.dep_count, (0)::bigint) AS depends_on_count,
    p.tags,
    p.created_at,
    row_number() OVER (ORDER BY COALESCE(bc.blocker_count, (0)::bigint) DESC, COALESCE(dd.dep_count, (0)::bigint), p.created_at) AS queue_position
   FROM ((roadmap_proposal.proposal p
     LEFT JOIN blocker_counts bc ON ((bc.proposal_id = p.id)))
     LEFT JOIN dependency_depth dd ON ((dd.proposal_id = p.id)))
  WHERE (p.status <> ALL (ARRAY['Done'::text, 'Discarded'::text, 'Rejected'::text]));


--
-- Name: VIEW v_proposal_queue; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON VIEW roadmap_proposal.v_proposal_queue IS 'DAG-derived queue: proposals ordered by how many others they block (blocker_count DESC), then by how many unresolved deps they have (dep_count ASC), then by age. This is the authoritative priority order; proposal.priority is descriptive only.';


--
-- Name: v_proposal_summary; Type: VIEW; Schema: roadmap; Owner: -
--

CREATE VIEW roadmap_proposal.v_proposal_summary AS
 SELECT p.id,
    p.display_id,
    p.type,
    p.title,
    p.status,
    p.priority,
    p.maturity,
    p.tags,
    ptc.workflow_name,
    w.current_stage,
    pl.agent_identity AS leased_by,
    pl.claimed_at AS leased_at,
    pl.expires_at AS lease_expires,
    pd.decision AS latest_decision,
    pd.decided_at AS decision_at,
    p.created_at,
    p.audit
   FROM ((((roadmap_proposal.proposal p
     LEFT JOIN roadmap_proposal.proposal_type_config ptc ON ((ptc.type = p.type)))
     LEFT JOIN roadmap.workflows w ON ((w.proposal_id = p.id)))
     LEFT JOIN LATERAL ( SELECT proposal_lease.agent_identity,
            proposal_lease.claimed_at,
            proposal_lease.expires_at
           FROM roadmap_proposal.proposal_lease
          WHERE ((proposal_lease.proposal_id = p.id) AND (proposal_lease.released_at IS NULL))
         LIMIT 1) pl ON (true))
     LEFT JOIN LATERAL ( SELECT proposal_decision.decision,
            proposal_decision.decided_at
           FROM roadmap_proposal.proposal_decision
          WHERE (proposal_decision.proposal_id = p.id)
          ORDER BY proposal_decision.decided_at DESC
         LIMIT 1) pd ON (true));


--
-- Name: v_run_summary; Type: VIEW; Schema: roadmap; Owner: -
--

CREATE VIEW roadmap.v_run_summary AS
 SELECT r.run_id,
    r.agent_identity,
    r.proposal_id,
    r.model_name,
    r.pipeline_stage,
    r.status,
    r.started_at,
    r.finished_at,
    (r.finished_at - r.started_at) AS duration,
    COALESCE(ctx.total_tokens, (0)::bigint) AS total_tokens,
    COALESCE(ctx.was_truncated, false) AS was_truncated,
    COALESCE(sl.cost_usd, (0)::numeric) AS cost_usd,
    COALESCE(ch.cache_hits, (0)::bigint) AS cache_hits,
    COALESCE(ch.cache_saved_usd, (0)::numeric) AS cache_saved_usd
   FROM (((roadmap.run_log r
     LEFT JOIN LATERAL ( SELECT sum(context_window_log.total_tokens) AS total_tokens,
            bool_or(context_window_log.was_truncated) AS was_truncated
           FROM roadmap_efficiency.context_window_log
          WHERE (context_window_log.run_id = r.run_id)) ctx ON (true))
     LEFT JOIN LATERAL ( SELECT sum(spending_log.cost_usd) AS cost_usd
           FROM roadmap_efficiency.spending_log
          WHERE (spending_log.run_id = r.run_id)) sl ON (true))
     LEFT JOIN LATERAL ( SELECT count(*) AS cache_hits,
            sum(chl.cost_saved_usd) AS cache_saved_usd
           FROM (roadmap_efficiency.cache_hit_log chl
             JOIN roadmap_efficiency.cache_write_log cwl ON ((cwl.id = chl.cache_write_id)))
          WHERE (cwl.run_id = r.run_id)) ch ON (true));


--
-- Name: VIEW v_run_summary; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON VIEW roadmap.v_run_summary IS 'Per-run rollup joining tokens, cost, and cache savings; replaces ad-hoc cross-table joins on run_id';


--
-- Name: v_stale_embeddings; Type: VIEW; Schema: roadmap; Owner: -
--

CREATE VIEW roadmap.v_stale_embeddings AS
 SELECT er.table_name,
    er.row_id,
    er.model_name,
    er.refreshed_at,
    mm.is_active AS model_is_active,
    (now() - er.refreshed_at) AS age
   FROM (roadmap.embedding_index_registry er
     JOIN roadmap.model_metadata mm ON ((mm.model_name = er.model_name)))
  WHERE ((mm.is_active = false) OR (er.refreshed_at < (now() - '30 days'::interval)));


--
-- Name: VIEW v_stale_embeddings; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON VIEW roadmap.v_stale_embeddings IS 'Embeddings from inactive models or not refreshed in 30 days; consumed by embedding_refresh job';


--
-- Name: v_undelivered_notifications; Type: VIEW; Schema: roadmap; Owner: -
--

CREATE VIEW roadmap.v_undelivered_notifications AS
 SELECT n.id,
    n.recipient,
    n.surface AS target_surface,
    n.event_type,
    n.payload,
    n.proposal_id,
    n.created_at,
    nd.surface AS delivery_surface,
    nd.delivered_at,
    nd.failure_reason
   FROM (roadmap.notification n
     LEFT JOIN roadmap.notification_delivery nd ON (((nd.notification_id = n.id) AND (nd.delivered_at IS NOT NULL))))
  WHERE ((nd.notification_id IS NULL) OR (nd.failure_reason IS NOT NULL));


--
-- Name: VIEW v_undelivered_notifications; Type: COMMENT; Schema: roadmap; Owner: -
--

COMMENT ON VIEW roadmap.v_undelivered_notifications IS 'Notifications with no successful delivery on any surface; polled by push dispatcher';


--
-- Name: webhook_subscription_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap.webhook_subscription ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap.webhook_subscription_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: workflow_roles; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.workflow_roles (
    id bigint NOT NULL,
    template_id bigint NOT NULL,
    role_name text NOT NULL,
    description text,
    clearance integer DEFAULT 1 NOT NULL,
    is_default boolean DEFAULT false NOT NULL
);


--
-- Name: workflow_roles_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap.workflow_roles ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap.workflow_roles_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: workflow_stages; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.workflow_stages (
    id bigint NOT NULL,
    template_id bigint NOT NULL,
    stage_name text NOT NULL,
    stage_order integer NOT NULL,
    maturity_gate integer DEFAULT 2,
    requires_ac boolean DEFAULT false NOT NULL,
    gating_config jsonb
);


--
-- Name: workflow_stages_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap.workflow_stages ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap.workflow_stages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: workflow_templates_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap.workflow_templates ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap.workflow_templates_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: workflow_transitions; Type: TABLE; Schema: roadmap; Owner: -
--

CREATE TABLE roadmap.workflow_transitions (
    id bigint NOT NULL,
    template_id bigint NOT NULL,
    from_stage text NOT NULL,
    to_stage text NOT NULL,
    labels text[],
    allowed_roles text[],
    requires_ac boolean DEFAULT false NOT NULL,
    gating_rules jsonb
);


--
-- Name: workflow_transitions_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap.workflow_transitions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap.workflow_transitions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: workflows_id_seq; Type: SEQUENCE; Schema: roadmap; Owner: -
--

ALTER TABLE roadmap.workflows ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME roadmap.workflows_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: escalation_log id; Type: DEFAULT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.escalation_log ALTER COLUMN id SET DEFAULT nextval('roadmap.escalation_log_id_seq'::regclass);


--
-- Name: acl acl_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.acl
    ADD CONSTRAINT acl_pkey PRIMARY KEY (id);


--
-- Name: acl acl_subject_resource_action_key; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.acl
    ADD CONSTRAINT acl_subject_resource_action_key UNIQUE (subject, resource, action);


--
-- Name: agency_profile agency_profile_agent_key; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_workforce.agency_profile
    ADD CONSTRAINT agency_profile_agent_key UNIQUE (agent_id);


--
-- Name: agency_profile agency_profile_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_workforce.agency_profile
    ADD CONSTRAINT agency_profile_pkey PRIMARY KEY (id);


--
-- Name: agent_budget_ledger agent_budget_ledger_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_efficiency.agent_budget_ledger
    ADD CONSTRAINT agent_budget_ledger_pkey PRIMARY KEY (id);


--
-- Name: agent_capability agent_capability_agent_cap_key; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_workforce.agent_capability
    ADD CONSTRAINT agent_capability_agent_cap_key UNIQUE (agent_id, capability);


--
-- Name: agent_capability agent_capability_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_workforce.agent_capability
    ADD CONSTRAINT agent_capability_pkey PRIMARY KEY (id);


--
-- Name: agent_conflicts agent_conflicts_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_workforce.agent_conflicts
    ADD CONSTRAINT agent_conflicts_pkey PRIMARY KEY (id);


--
-- Name: agent_memory agent_memory_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_efficiency.agent_memory
    ADD CONSTRAINT agent_memory_pkey PRIMARY KEY (id);


--
-- Name: agent_registry agent_registry_agent_identity_key; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_workforce.agent_registry
    ADD CONSTRAINT agent_registry_agent_identity_key UNIQUE (agent_identity);


--
-- Name: agent_registry agent_registry_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_workforce.agent_registry
    ADD CONSTRAINT agent_registry_pkey PRIMARY KEY (id);


--
-- Name: agent_runs agent_runs_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_workforce.agent_runs
    ADD CONSTRAINT agent_runs_pkey PRIMARY KEY (id);


--
-- Name: agent_workload agent_workload_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_workforce.agent_workload
    ADD CONSTRAINT agent_workload_pkey PRIMARY KEY (agent_id);


--
-- Name: attachment_registry attachment_registry_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.attachment_registry
    ADD CONSTRAINT attachment_registry_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: budget_allowance budget_allowance_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_efficiency.budget_allowance
    ADD CONSTRAINT budget_allowance_pkey PRIMARY KEY (id);


--
-- Name: cache_hit_log cache_hit_log_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_efficiency.cache_hit_log
    ADD CONSTRAINT cache_hit_log_pkey PRIMARY KEY (id);


--
-- Name: cache_write_log cache_write_log_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_efficiency.cache_write_log
    ADD CONSTRAINT cache_write_log_pkey PRIMARY KEY (id);


--
-- Name: channel_subscription channel_subscription_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.channel_subscription
    ADD CONSTRAINT channel_subscription_pkey PRIMARY KEY (agent_identity, channel);


--
-- Name: context_window_log context_window_log_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_efficiency.context_window_log
    ADD CONSTRAINT context_window_log_pkey PRIMARY KEY (id);


--
-- Name: cubics cubics_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.cubics
    ADD CONSTRAINT cubics_pkey PRIMARY KEY (cubic_id);


--
-- Name: decision_queue decision_queue_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.decision_queue
    ADD CONSTRAINT decision_queue_pkey PRIMARY KEY (id);


--
-- Name: embedding_index_registry embedding_index_registry_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.embedding_index_registry
    ADD CONSTRAINT embedding_index_registry_pkey PRIMARY KEY (id);


--
-- Name: embedding_index_registry embedding_index_registry_table_row_key; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.embedding_index_registry
    ADD CONSTRAINT embedding_index_registry_table_row_key UNIQUE (table_name, row_id);


--
-- Name: escalation_log escalation_log_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.escalation_log
    ADD CONSTRAINT escalation_log_pkey PRIMARY KEY (id);


--
-- Name: extracted_patterns extracted_patterns_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.extracted_patterns
    ADD CONSTRAINT extracted_patterns_pkey PRIMARY KEY (id);


--
-- Name: gate_task_templates gate_task_templates_gate_key; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.gate_task_templates
    ADD CONSTRAINT gate_task_templates_gate_key UNIQUE (gate_number);


--
-- Name: gate_task_templates gate_task_templates_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.gate_task_templates
    ADD CONSTRAINT gate_task_templates_pkey PRIMARY KEY (id);


--
-- Name: knowledge_entries knowledge_entries_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.knowledge_entries
    ADD CONSTRAINT knowledge_entries_pkey PRIMARY KEY (id);


--
-- Name: maturity maturity_name_key; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.maturity
    ADD CONSTRAINT maturity_name_key UNIQUE (name);


--
-- Name: maturity maturity_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.maturity
    ADD CONSTRAINT maturity_pkey PRIMARY KEY (level);


--
-- Name: mcp_tool_assignment mcp_tool_assignment_agent_tool; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.mcp_tool_assignment
    ADD CONSTRAINT mcp_tool_assignment_agent_tool UNIQUE (agent_id, tool_id);


--
-- Name: mcp_tool_assignment mcp_tool_assignment_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.mcp_tool_assignment
    ADD CONSTRAINT mcp_tool_assignment_pkey PRIMARY KEY (id);


--
-- Name: mcp_tool_registry mcp_tool_registry_name_ver_key; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.mcp_tool_registry
    ADD CONSTRAINT mcp_tool_registry_name_ver_key UNIQUE (tool_name, tool_version);


--
-- Name: mcp_tool_registry mcp_tool_registry_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.mcp_tool_registry
    ADD CONSTRAINT mcp_tool_registry_pkey PRIMARY KEY (id);


--
-- Name: message_ledger message_ledger_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.message_ledger
    ADD CONSTRAINT message_ledger_pkey PRIMARY KEY (id);


--
-- Name: model_assignment model_assignment_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.model_assignment
    ADD CONSTRAINT model_assignment_pkey PRIMARY KEY (id);


--
-- Name: model_metadata model_metadata_model_name_key; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.model_metadata
    ADD CONSTRAINT model_metadata_model_name_key UNIQUE (model_name);


--
-- Name: model_metadata model_metadata_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.model_metadata
    ADD CONSTRAINT model_metadata_pkey PRIMARY KEY (id);


--
-- Name: notification_delivery notification_delivery_notif_surf_key; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.notification_delivery
    ADD CONSTRAINT notification_delivery_notif_surf_key UNIQUE (notification_id, surface);


--
-- Name: notification_delivery notification_delivery_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.notification_delivery
    ADD CONSTRAINT notification_delivery_pkey PRIMARY KEY (id);


--
-- Name: notification notification_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.notification
    ADD CONSTRAINT notification_pkey PRIMARY KEY (id);


--
-- Name: notification_queue notification_queue_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.notification_queue
    ADD CONSTRAINT notification_queue_pkey PRIMARY KEY (id);


--
-- Name: prompt_template prompt_template_name_ver_key; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.prompt_template
    ADD CONSTRAINT prompt_template_name_ver_key UNIQUE (name, version);


--
-- Name: prompt_template prompt_template_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.prompt_template
    ADD CONSTRAINT prompt_template_pkey PRIMARY KEY (id);


--
-- Name: proposal_acceptance_criteria proposal_ac_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_acceptance_criteria
    ADD CONSTRAINT proposal_ac_pkey PRIMARY KEY (id);


--
-- Name: proposal_acceptance_criteria proposal_ac_proposal_item; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_acceptance_criteria
    ADD CONSTRAINT proposal_ac_proposal_item UNIQUE (proposal_id, item_number);



--
-- Name: proposal_decision proposal_decision_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_decision
    ADD CONSTRAINT proposal_decision_pkey PRIMARY KEY (id);


--
-- Name: proposal_dependencies proposal_deps_from_to_key; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_dependencies
    ADD CONSTRAINT proposal_deps_from_to_key UNIQUE (from_proposal_id, to_proposal_id);


--
-- Name: proposal_dependencies proposal_deps_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_dependencies
    ADD CONSTRAINT proposal_deps_pkey PRIMARY KEY (id);


--
-- Name: proposal_discussions proposal_discussions_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_discussions
    ADD CONSTRAINT proposal_discussions_pkey PRIMARY KEY (id);


--
-- Name: proposal proposal_display_id_key; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal
    ADD CONSTRAINT proposal_display_id_key UNIQUE (display_id);


--
-- Name: proposal_event proposal_event_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_event
    ADD CONSTRAINT proposal_event_pkey PRIMARY KEY (id);


--
-- Name: proposal_labels proposal_labels_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_labels
    ADD CONSTRAINT proposal_labels_pkey PRIMARY KEY (proposal_id, label);


--
-- Name: proposal_lease proposal_lease_one_active; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_lease
    ADD CONSTRAINT proposal_lease_one_active UNIQUE NULLS NOT DISTINCT (proposal_id, released_at);


--
-- Name: proposal_lease proposal_lease_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_lease
    ADD CONSTRAINT proposal_lease_pkey PRIMARY KEY (id);


--
-- Name: proposal_maturity_transitions proposal_maturity_trans_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_maturity_transitions
    ADD CONSTRAINT proposal_maturity_trans_pkey PRIMARY KEY (id);


--
-- Name: proposal_milestone proposal_milestone_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_milestone
    ADD CONSTRAINT proposal_milestone_pkey PRIMARY KEY (id);


--
-- Name: proposal proposal_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal
    ADD CONSTRAINT proposal_pkey PRIMARY KEY (id);


--
-- Name: proposal_reviews proposal_reviews_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_reviews
    ADD CONSTRAINT proposal_reviews_pkey PRIMARY KEY (id);


--
-- Name: proposal_reviews proposal_reviews_unique; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_reviews
    ADD CONSTRAINT proposal_reviews_unique UNIQUE NULLS NOT DISTINCT (proposal_id, reviewer_identity);


--
-- Name: proposal_reviews proposal_reviews_unique_reviewer; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_reviews
    ADD CONSTRAINT proposal_reviews_unique_reviewer UNIQUE NULLS NOT DISTINCT (proposal_id, reviewer_identity);


--
-- Name: proposal_state_transitions proposal_state_transitions_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_state_transitions
    ADD CONSTRAINT proposal_state_transitions_pkey PRIMARY KEY (id);


--
-- Name: proposal_template proposal_template_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_template
    ADD CONSTRAINT proposal_template_pkey PRIMARY KEY (id);


--
-- Name: proposal_template proposal_template_type_ver_key; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_template
    ADD CONSTRAINT proposal_template_type_ver_key UNIQUE (type, version);


--
-- Name: proposal_type_config proposal_type_config_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_type_config
    ADD CONSTRAINT proposal_type_config_pkey PRIMARY KEY (type);


--
-- Name: proposal_valid_transitions proposal_valid_transitions_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_valid_transitions
    ADD CONSTRAINT proposal_valid_transitions_pkey PRIMARY KEY (id);


--
-- Name: proposal_valid_transitions proposal_valid_transitions_wf_from_to; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_valid_transitions
    ADD CONSTRAINT proposal_valid_transitions_wf_from_to UNIQUE (workflow_name, from_state, to_state);


--
-- Name: proposal_version proposal_version_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_version
    ADD CONSTRAINT proposal_version_pkey PRIMARY KEY (id);


--
-- Name: proposal_version proposal_version_proposal_ver; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_version
    ADD CONSTRAINT proposal_version_proposal_ver UNIQUE (proposal_id, version_number);


--
-- Name: proposal_versions proposal_versions_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_versions
    ADD CONSTRAINT proposal_versions_pkey PRIMARY KEY (id);


--
-- Name: proposal_versions proposal_versions_proposal_id_version_number_key; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_versions
    ADD CONSTRAINT proposal_versions_proposal_id_version_number_key UNIQUE (proposal_id, version_number);


--
-- Name: research_cache research_cache_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.research_cache
    ADD CONSTRAINT research_cache_pkey PRIMARY KEY (id);


--
-- Name: resource_allocation resource_allocation_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.resource_allocation
    ADD CONSTRAINT resource_allocation_pkey PRIMARY KEY (id);


--
-- Name: run_log run_log_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.run_log
    ADD CONSTRAINT run_log_pkey PRIMARY KEY (run_id);


--
-- Name: scheduled_job scheduled_job_name_key; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.scheduled_job
    ADD CONSTRAINT scheduled_job_name_key UNIQUE (job_name);


--
-- Name: scheduled_job scheduled_job_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.scheduled_job
    ADD CONSTRAINT scheduled_job_pkey PRIMARY KEY (id);


--
-- Name: spending_caps spending_caps_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_efficiency.spending_caps
    ADD CONSTRAINT spending_caps_pkey PRIMARY KEY (agent_identity);


--
-- Name: spending_log spending_log_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_efficiency.spending_log
    ADD CONSTRAINT spending_log_pkey PRIMARY KEY (id);


--
-- Name: team_member team_member_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_workforce.team_member
    ADD CONSTRAINT team_member_pkey PRIMARY KEY (id);


--
-- Name: team_member team_member_unique; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_workforce.team_member
    ADD CONSTRAINT team_member_unique UNIQUE (team_id, agent_id);


--
-- Name: team team_name_key; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_workforce.team
    ADD CONSTRAINT team_name_key UNIQUE (team_name);


--
-- Name: team team_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_workforce.team
    ADD CONSTRAINT team_pkey PRIMARY KEY (id);


--
-- Name: transition_queue transition_queue_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.transition_queue
    ADD CONSTRAINT transition_queue_pkey PRIMARY KEY (id);


--
-- Name: user_session user_session_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.user_session
    ADD CONSTRAINT user_session_pkey PRIMARY KEY (id);


--
-- Name: user_session user_session_token_key; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.user_session
    ADD CONSTRAINT user_session_token_key UNIQUE (session_token);


--
-- Name: webhook_subscription webhook_subscription_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.webhook_subscription
    ADD CONSTRAINT webhook_subscription_pkey PRIMARY KEY (id);


--
-- Name: webhook_subscription webhook_subscription_url_key; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.webhook_subscription
    ADD CONSTRAINT webhook_subscription_url_key UNIQUE (endpoint_url);


--
-- Name: workflow_roles workflow_roles_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.workflow_roles
    ADD CONSTRAINT workflow_roles_pkey PRIMARY KEY (id);


--
-- Name: workflow_roles workflow_roles_tmpl_role_key; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.workflow_roles
    ADD CONSTRAINT workflow_roles_tmpl_role_key UNIQUE (template_id, role_name);


--
-- Name: workflow_stages workflow_stages_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.workflow_stages
    ADD CONSTRAINT workflow_stages_pkey PRIMARY KEY (id);


--
-- Name: workflow_stages workflow_stages_tmpl_name_key; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.workflow_stages
    ADD CONSTRAINT workflow_stages_tmpl_name_key UNIQUE (template_id, stage_name);


--
-- Name: workflow_stages workflow_stages_tmpl_order_key; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.workflow_stages
    ADD CONSTRAINT workflow_stages_tmpl_order_key UNIQUE (template_id, stage_order);


--
-- Name: workflow_templates workflow_templates_name_key; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.workflow_templates
    ADD CONSTRAINT workflow_templates_name_key UNIQUE (name);


--
-- Name: workflow_templates workflow_templates_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.workflow_templates
    ADD CONSTRAINT workflow_templates_pkey PRIMARY KEY (id);


--
-- Name: workflow_transitions workflow_transitions_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.workflow_transitions
    ADD CONSTRAINT workflow_transitions_pkey PRIMARY KEY (id);


--
-- Name: workflow_transitions workflow_transitions_tmpl_from_to; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.workflow_transitions
    ADD CONSTRAINT workflow_transitions_tmpl_from_to UNIQUE (template_id, from_stage, to_stage);


--
-- Name: workflows workflows_pkey; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.workflows
    ADD CONSTRAINT workflows_pkey PRIMARY KEY (id);


--
-- Name: workflows workflows_proposal_key; Type: CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.workflows
    ADD CONSTRAINT workflows_proposal_key UNIQUE (proposal_id);


--
-- Name: idx_ac_proposal; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_ac_proposal ON roadmap_proposal.proposal_acceptance_criteria USING btree (proposal_id);


--
-- Name: idx_ac_status; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_ac_status ON roadmap_proposal.proposal_acceptance_criteria USING btree (status);


--
-- Name: idx_acl_expires; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_acl_expires ON roadmap.acl USING btree (expires_at) WHERE (expires_at IS NOT NULL);


--
-- Name: idx_agent_conflicts_open; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_agent_conflicts_open ON roadmap_workforce.agent_conflicts USING btree (created_at DESC) WHERE (status = 'open'::text);


--
-- Name: idx_agent_conflicts_proposal; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_agent_conflicts_proposal ON roadmap_workforce.agent_conflicts USING btree (proposal_id);


--
-- Name: idx_agent_runs_proposal; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_agent_runs_proposal ON roadmap_workforce.agent_runs USING btree (proposal_id);


--
-- Name: idx_agent_runs_started; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_agent_runs_started ON roadmap_workforce.agent_runs USING btree (started_at DESC);


--
-- Name: idx_agent_runs_status; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_agent_runs_status ON roadmap_workforce.agent_runs USING btree (status) WHERE (status = 'running'::text);


--
-- Name: idx_attachment_proposal; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_attachment_proposal ON roadmap.attachment_registry USING btree (proposal_id);


--
-- Name: idx_audit_changed; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_audit_changed ON roadmap.audit_log USING btree (changed_at DESC);


--
-- Name: idx_audit_entity; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_audit_entity ON roadmap.audit_log USING btree (entity_type, entity_id);


--
-- Name: idx_audit_who; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_audit_who ON roadmap.audit_log USING btree (changed_by) WHERE (changed_by IS NOT NULL);


--
-- Name: idx_budget_ledger_proposal_latest; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_budget_ledger_proposal_latest ON roadmap_efficiency.agent_budget_ledger USING btree (proposal_id, recorded_at DESC);


--
-- Name: idx_budget_team; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_budget_team ON roadmap_efficiency.budget_allowance USING btree (team_id) WHERE (team_id IS NOT NULL);


--
-- Name: idx_cache_agent; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_cache_agent ON roadmap_efficiency.cache_write_log USING btree (agent_identity);


--
-- Name: idx_cache_hit_agent; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_cache_hit_agent ON roadmap_efficiency.cache_hit_log USING btree (agent_identity);


--
-- Name: idx_cache_hit_at; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_cache_hit_at ON roadmap_efficiency.cache_hit_log USING btree (hit_at DESC);


--
-- Name: idx_cache_hit_write; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_cache_hit_write ON roadmap_efficiency.cache_hit_log USING btree (cache_write_id);


--
-- Name: idx_cache_key; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_cache_key ON roadmap_efficiency.cache_write_log USING btree (cache_key);


--
-- Name: idx_capability_agent; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_capability_agent ON roadmap_workforce.agent_capability USING btree (agent_id);


--
-- Name: idx_capability_proficiency; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_capability_proficiency ON roadmap_workforce.agent_capability USING btree (capability, proficiency);


--
-- Name: idx_capability_term; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_capability_term ON roadmap_workforce.agent_capability USING btree (capability);


--
-- Name: idx_channel_subscription_channel; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_channel_subscription_channel ON roadmap.channel_subscription USING btree (channel);



--
-- Name: idx_ctx_agent; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_ctx_agent ON roadmap_efficiency.context_window_log USING btree (agent_identity);


--
-- Name: idx_ctx_proposal; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_ctx_proposal ON roadmap_efficiency.context_window_log USING btree (proposal_id) WHERE (proposal_id IS NOT NULL);


--
-- Name: idx_ctx_truncated; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_ctx_truncated ON roadmap_efficiency.context_window_log USING btree (logged_at DESC) WHERE (was_truncated = true);


--
-- Name: idx_cubics_lock; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_cubics_lock ON roadmap.cubics USING btree (lock_holder) WHERE (lock_holder IS NOT NULL);


--
-- Name: idx_cubics_status; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_cubics_status ON roadmap.cubics USING btree (status);


--
-- Name: idx_decision_at; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_decision_at ON roadmap_proposal.proposal_decision USING btree (decided_at DESC);


--
-- Name: idx_decision_proposal; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_decision_proposal ON roadmap_proposal.proposal_decision USING btree (proposal_id);


--
-- Name: idx_decision_queue_pending; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_decision_queue_pending ON roadmap.decision_queue USING btree (process_after) WHERE (status = 'pending'::text);


--
-- Name: idx_decision_queue_proposal; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_decision_queue_proposal ON roadmap.decision_queue USING btree (proposal_id);


--
-- Name: idx_deps_from; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_deps_from ON roadmap_proposal.proposal_dependencies USING btree (from_proposal_id);


--
-- Name: idx_deps_to; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_deps_to ON roadmap_proposal.proposal_dependencies USING btree (to_proposal_id);


--
-- Name: idx_deps_unresolved; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_deps_unresolved ON roadmap_proposal.proposal_dependencies USING btree (from_proposal_id) WHERE (resolved = false);


--
-- Name: idx_discussion_author; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_discussion_author ON roadmap_proposal.proposal_discussions USING btree (author_identity);


--
-- Name: idx_discussion_context; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_discussion_context ON roadmap_proposal.proposal_discussions USING btree (context_prefix) WHERE (context_prefix IS NOT NULL);


--
-- Name: idx_discussion_created; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_discussion_created ON roadmap_proposal.proposal_discussions USING btree (created_at DESC);


--
-- Name: idx_discussion_parent; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_discussion_parent ON roadmap_proposal.proposal_discussions USING btree (parent_id) WHERE (parent_id IS NOT NULL);


--
-- Name: idx_discussion_proposal; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_discussion_proposal ON roadmap_proposal.proposal_discussions USING btree (proposal_id);


--
-- Name: idx_discussion_vector; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_discussion_vector ON roadmap_proposal.proposal_discussions USING hnsw (body_vector public.vector_cosine_ops) WITH (m='16', ef_construction='64');


--
-- Name: idx_embed_model; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_embed_model ON roadmap.embedding_index_registry USING btree (model_name);


--
-- Name: idx_embed_refresh; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_embed_refresh ON roadmap.embedding_index_registry USING btree (refreshed_at);


--
-- Name: idx_embed_table; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_embed_table ON roadmap.embedding_index_registry USING btree (table_name);


--
-- Name: idx_escalation_proposal; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_escalation_proposal ON roadmap.escalation_log USING btree (proposal_id) WHERE (proposal_id IS NOT NULL);


--
-- Name: idx_escalation_type; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_escalation_type ON roadmap.escalation_log USING btree (obstacle_type);


--
-- Name: idx_escalation_unresolved; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_escalation_unresolved ON roadmap.escalation_log USING btree (escalated_at DESC) WHERE (resolved_at IS NULL);


--
-- Name: idx_event_proposal; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_event_proposal ON roadmap_proposal.proposal_event USING btree (proposal_id);


--
-- Name: idx_event_type; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_event_type ON roadmap_proposal.proposal_event USING btree (event_type);


--
-- Name: idx_event_undispatched; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_event_undispatched ON roadmap_proposal.proposal_event USING btree (created_at) WHERE (dispatched_at IS NULL);


--
-- Name: idx_kb_author; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_kb_author ON roadmap.knowledge_entries USING btree (author);


--
-- Name: idx_kb_confidence; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_kb_confidence ON roadmap.knowledge_entries USING btree (confidence DESC);


--
-- Name: idx_kb_helpful; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_kb_helpful ON roadmap.knowledge_entries USING btree (helpful_count DESC);


--
-- Name: idx_kb_source_proposal; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_kb_source_proposal ON roadmap.knowledge_entries USING btree (source_proposal_id) WHERE (source_proposal_id IS NOT NULL);


--
-- Name: idx_kb_type; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_kb_type ON roadmap.knowledge_entries USING btree (type);


--
-- Name: idx_labels_label; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_labels_label ON roadmap_proposal.proposal_labels USING btree (label);


--
-- Name: idx_lease_agent; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_lease_agent ON roadmap_proposal.proposal_lease USING btree (agent_identity) WHERE (released_at IS NULL);


--
-- Name: idx_lease_expires; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_lease_expires ON roadmap_proposal.proposal_lease USING btree (expires_at) WHERE ((expires_at IS NOT NULL) AND (released_at IS NULL));


--
-- Name: idx_lease_proposal; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_lease_proposal ON roadmap_proposal.proposal_lease USING btree (proposal_id) WHERE (released_at IS NULL);


--
-- Name: idx_maturity_trans_at; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_maturity_trans_at ON roadmap_proposal.proposal_maturity_transitions USING btree (created_at DESC);


--
-- Name: idx_maturity_trans_proposal; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_maturity_trans_proposal ON roadmap_proposal.proposal_maturity_transitions USING btree (proposal_id);


--
-- Name: idx_maturity_trans_to; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_maturity_trans_to ON roadmap_proposal.proposal_maturity_transitions USING btree (to_maturity);


--
-- Name: idx_mcp_active; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_mcp_active ON roadmap.mcp_tool_registry USING btree (tool_name) WHERE (is_active = true);


--
-- Name: idx_memory_agent; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_memory_agent ON roadmap_efficiency.agent_memory USING btree (agent_identity);


--
-- Name: idx_memory_expires; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_memory_expires ON roadmap_efficiency.agent_memory USING btree (expires_at) WHERE (expires_at IS NOT NULL);


--
-- Name: idx_memory_layer; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_memory_layer ON roadmap_efficiency.agent_memory USING btree (layer);

CREATE INDEX idx_memory_level ON roadmap_efficiency.agent_memory USING btree (memory_level);


--
-- Name: idx_memory_vector; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_memory_vector ON roadmap_efficiency.agent_memory USING hnsw (body_vector public.vector_cosine_ops);


--
-- Name: idx_message_created; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_message_created ON roadmap.message_ledger USING btree (created_at DESC);


--
-- Name: idx_message_from; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_message_from ON roadmap.message_ledger USING btree (from_agent);


--
-- Name: idx_message_proposal; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_message_proposal ON roadmap.message_ledger USING btree (proposal_id) WHERE (proposal_id IS NOT NULL);


--
-- Name: idx_message_to; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_message_to ON roadmap.message_ledger USING btree (to_agent) WHERE (to_agent IS NOT NULL);


--
-- Name: idx_milestone_due; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_milestone_due ON roadmap_proposal.proposal_milestone USING btree (due_at) WHERE (achieved_at IS NULL);


--
-- Name: idx_milestone_proposal; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_milestone_proposal ON roadmap_proposal.proposal_milestone USING btree (proposal_id);


--
-- Name: idx_notif_delivery_notif; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_notif_delivery_notif ON roadmap.notification_delivery USING btree (notification_id);


--
-- Name: idx_notif_delivery_undelivered; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_notif_delivery_undelivered ON roadmap.notification_delivery USING btree (notification_id) WHERE (delivered_at IS NULL);


--
-- Name: idx_notification_created; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_notification_created ON roadmap.notification USING btree (created_at DESC);


--
-- Name: idx_notification_queue_pending; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_notification_queue_pending ON roadmap.notification_queue USING btree (severity, created_at) WHERE (status = 'pending'::text);


--
-- Name: idx_patterns_usage; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_patterns_usage ON roadmap.extracted_patterns USING btree (usage_count DESC, success_rate DESC);


--
-- Name: idx_prompt_template_lookup; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_prompt_template_lookup ON roadmap.prompt_template USING btree (proposal_type, pipeline_stage, is_active, version DESC);


--
-- Name: idx_proposal_parent; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_proposal_parent ON roadmap_proposal.proposal USING btree (parent_id) WHERE (parent_id IS NOT NULL);


--
-- Name: idx_proposal_status; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_proposal_status ON roadmap_proposal.proposal USING btree (status);


--
-- Name: idx_proposal_template_default; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE UNIQUE INDEX idx_proposal_template_default ON roadmap_proposal.proposal_template USING btree (type) WHERE (is_default = true);


--
-- Name: idx_proposal_template_type; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_proposal_template_type ON roadmap_proposal.proposal_template USING btree (type);


--
-- Name: idx_proposal_type; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_proposal_type ON roadmap_proposal.proposal USING btree (type);


--
-- Name: idx_proposal_workflow; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_proposal_workflow ON roadmap_proposal.proposal USING btree (workflow_name);


--
-- Name: idx_pvt_from; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_pvt_from ON roadmap_proposal.proposal_valid_transitions USING btree (from_state);


--
-- Name: idx_pvt_to; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_pvt_to ON roadmap_proposal.proposal_valid_transitions USING btree (to_state);


--
-- Name: idx_research_cache_proposal; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_research_cache_proposal ON roadmap.research_cache USING btree (proposal_id) WHERE (is_superseded = false);


--
-- Name: idx_research_cache_source_type; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_research_cache_source_type ON roadmap.research_cache USING btree (source_type, created_at DESC) WHERE (is_superseded = false);


--
-- Name: idx_research_cache_topic_trgm; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_research_cache_topic_trgm ON roadmap.research_cache USING gin (topic roadmap.gin_trgm_ops) WHERE (is_superseded = false);


--
-- Name: idx_reviews_blocking; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_reviews_blocking ON roadmap_proposal.proposal_reviews USING btree (proposal_id) WHERE (is_blocking = true);


--
-- Name: idx_reviews_proposal; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_reviews_proposal ON roadmap_proposal.proposal_reviews USING btree (proposal_id);


--
-- Name: idx_reviews_reviewer; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_reviews_reviewer ON roadmap_proposal.proposal_reviews USING btree (reviewer_identity);


--
-- Name: idx_reviews_verdict; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_reviews_verdict ON roadmap_proposal.proposal_reviews USING btree (verdict);


--
-- Name: idx_run_agent; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_run_agent ON roadmap.run_log USING btree (agent_identity);


--
-- Name: idx_run_proposal; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_run_proposal ON roadmap.run_log USING btree (proposal_id) WHERE (proposal_id IS NOT NULL);


--
-- Name: idx_run_started; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_run_started ON roadmap.run_log USING btree (started_at DESC);


--
-- Name: idx_run_status; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_run_status ON roadmap.run_log USING btree (status) WHERE (status = 'running'::text);


--
-- Name: idx_session_agent; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_session_agent ON roadmap.user_session USING btree (agent_identity);


--
-- Name: idx_session_expires; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_session_expires ON roadmap.user_session USING btree (expires_at) WHERE (expires_at IS NOT NULL);


--
-- Name: idx_spending_agent; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_spending_agent ON roadmap_efficiency.spending_log USING btree (agent_identity);


--
-- Name: idx_spending_created; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_spending_created ON roadmap_efficiency.spending_log USING btree (created_at DESC);


--
-- Name: idx_spending_proposal; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_spending_proposal ON roadmap_efficiency.spending_log USING btree (proposal_id) WHERE (proposal_id IS NOT NULL);


--
-- Name: idx_state_transitions_created; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_state_transitions_created ON roadmap_proposal.proposal_state_transitions USING btree (transitioned_at DESC);


--
-- Name: idx_state_transitions_proposal; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_state_transitions_proposal ON roadmap_proposal.proposal_state_transitions USING btree (proposal_id);


--
-- Name: idx_state_transitions_state; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_state_transitions_state ON roadmap_proposal.proposal_state_transitions USING btree (to_state);


--
-- Name: idx_transition_queue_gate_dedup; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE UNIQUE INDEX idx_transition_queue_gate_dedup ON roadmap.transition_queue USING btree (proposal_id, gate) WHERE ((gate IS NOT NULL) AND (status = ANY (ARRAY['pending'::text, 'processing'::text])));


--
-- Name: idx_transition_queue_pending; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_transition_queue_pending ON roadmap.transition_queue USING btree (process_after) WHERE (status = 'pending'::text);


--
-- Name: idx_transition_queue_proposal; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_transition_queue_proposal ON roadmap.transition_queue USING btree (proposal_id);


--
-- Name: idx_transitions_at; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_transitions_at ON roadmap_proposal.proposal_state_transitions USING btree (transitioned_at DESC);


--
-- Name: idx_transitions_from; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_transitions_from ON roadmap_proposal.proposal_state_transitions USING btree (from_state);


--
-- Name: idx_transitions_proposal; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_transitions_proposal ON roadmap_proposal.proposal_state_transitions USING btree (proposal_id);


--
-- Name: idx_transitions_reason; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_transitions_reason ON roadmap_proposal.proposal_state_transitions USING btree (transition_reason);


--
-- Name: idx_transitions_to; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_transitions_to ON roadmap_proposal.proposal_state_transitions USING btree (to_state);


--
-- Name: idx_version_proposal; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_version_proposal ON roadmap_proposal.proposal_version USING btree (proposal_id);


--
-- Name: idx_versions_proposal; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_versions_proposal ON roadmap_proposal.proposal_versions USING btree (proposal_id, version_number DESC);


--
-- Name: idx_webhook_active; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_webhook_active ON roadmap.webhook_subscription USING btree (is_active) WHERE (is_active = true);


--
-- Name: idx_workflows_stage; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_workflows_stage ON roadmap.workflows USING btree (current_stage);


--
-- Name: idx_workflows_template; Type: INDEX; Schema: roadmap; Owner: -
--

CREATE INDEX idx_workflows_template ON roadmap.workflows USING btree (template_id);


--
-- Name: agent_memory trg_agent_memory_updated_at; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_agent_memory_updated_at BEFORE UPDATE ON roadmap_efficiency.agent_memory FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();


--
-- Name: agent_registry trg_agent_registry_updated_at; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_agent_registry_updated_at BEFORE UPDATE ON roadmap_workforce.agent_registry FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();


--
-- Name: acl trg_audit_acl; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_audit_acl AFTER INSERT OR DELETE OR UPDATE ON roadmap.acl FOR EACH ROW EXECUTE FUNCTION roadmap.fn_audit_sensitive_tables();


--
-- Name: agent_registry trg_audit_agent_registry; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_audit_agent_registry AFTER INSERT OR DELETE OR UPDATE ON roadmap_workforce.agent_registry FOR EACH ROW EXECUTE FUNCTION roadmap.fn_audit_sensitive_tables();


--
-- Name: resource_allocation trg_audit_resource_allocation; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_audit_resource_allocation AFTER INSERT OR DELETE OR UPDATE ON roadmap.resource_allocation FOR EACH ROW EXECUTE FUNCTION roadmap.fn_audit_sensitive_tables();


--
-- Name: spending_caps trg_audit_spending_caps; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_audit_spending_caps AFTER INSERT OR DELETE OR UPDATE ON roadmap_efficiency.spending_caps FOR EACH ROW EXECUTE FUNCTION roadmap.fn_audit_sensitive_tables();


--
-- Name: agent_budget_ledger trg_budget_threshold_notify; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_budget_threshold_notify AFTER INSERT ON roadmap_efficiency.agent_budget_ledger FOR EACH ROW EXECUTE FUNCTION roadmap.fn_budget_threshold_notify();


--
-- Name: proposal_dependencies trg_check_dag_cycle; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_check_dag_cycle BEFORE INSERT OR UPDATE ON roadmap_proposal.proposal_dependencies FOR EACH ROW EXECUTE FUNCTION roadmap.fn_check_dag_cycle();


--
-- Name: proposal_lease trg_check_lease_available; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_check_lease_available BEFORE INSERT ON roadmap_proposal.proposal_lease FOR EACH ROW EXECUTE FUNCTION roadmap.fn_check_lease_available();


--
-- Name: spending_log trg_check_spending_cap; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_check_spending_cap AFTER INSERT ON roadmap_efficiency.spending_log FOR EACH ROW EXECUTE FUNCTION roadmap.fn_check_spending_cap();


--
-- Name: proposal_lease trg_event_lease_change; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_event_lease_change AFTER INSERT OR UPDATE ON roadmap_proposal.proposal_lease FOR EACH ROW EXECUTE FUNCTION roadmap.fn_event_lease_change();


--
-- Name: proposal trg_gate_ready; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_gate_ready BEFORE UPDATE OF maturity ON roadmap_proposal.proposal FOR EACH ROW EXECUTE FUNCTION roadmap.fn_notify_gate_ready();


--
-- Name: knowledge_entries trg_kb_updated_at; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_kb_updated_at BEFORE UPDATE ON roadmap.knowledge_entries FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();


--
-- Name: mcp_tool_registry trg_mcp_tool_registry_updated_at; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_mcp_tool_registry_updated_at BEFORE UPDATE ON roadmap.mcp_tool_registry FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();


--
-- Name: message_ledger trg_message_notify; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_message_notify AFTER INSERT ON roadmap.message_ledger FOR EACH ROW EXECUTE FUNCTION roadmap.fn_notify_new_message();


--
-- Name: model_metadata trg_model_metadata_updated_at; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_model_metadata_updated_at BEFORE UPDATE ON roadmap.model_metadata FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();


--
-- Name: proposal_event trg_notify_event; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_notify_event AFTER INSERT ON roadmap_proposal.proposal_event FOR EACH ROW EXECUTE FUNCTION roadmap.fn_notify_proposal_event();


--
-- Name: extracted_patterns trg_patterns_updated_at; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_patterns_updated_at BEFORE UPDATE ON roadmap.extracted_patterns FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();


--
-- Name: proposal_acceptance_criteria trg_proposal_ac_updated_at; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_proposal_ac_updated_at BEFORE UPDATE ON roadmap_proposal.proposal_acceptance_criteria FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();


--
-- Name: proposal_dependencies trg_proposal_deps_updated_at; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_proposal_deps_updated_at BEFORE UPDATE ON roadmap_proposal.proposal_dependencies FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();


--
-- Name: proposal_discussions trg_proposal_discussions_updated_at; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_proposal_discussions_updated_at BEFORE UPDATE ON roadmap_proposal.proposal_discussions FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();


--
-- Name: proposal trg_proposal_display_id; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_proposal_display_id BEFORE INSERT ON roadmap_proposal.proposal FOR EACH ROW WHEN (((new.display_id IS NULL) OR (new.display_id = ''::text))) EXECUTE FUNCTION roadmap.fn_proposal_display_id();


--
-- Name: proposal trg_proposal_maturity_init; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_proposal_maturity_init BEFORE INSERT ON roadmap_proposal.proposal FOR EACH ROW EXECUTE FUNCTION roadmap.fn_init_proposal_maturity();


--
-- Name: proposal trg_proposal_maturity_sync; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_proposal_maturity_sync BEFORE UPDATE ON roadmap_proposal.proposal FOR EACH ROW EXECUTE FUNCTION roadmap.fn_sync_proposal_maturity();


--
-- Name: proposal trg_proposal_state_change; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_proposal_state_change BEFORE UPDATE OF status ON roadmap_proposal.proposal FOR EACH ROW EXECUTE FUNCTION roadmap.fn_log_proposal_state_change();


--
-- Name: proposal_type_config trg_proposal_type_config_updated_at; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_proposal_type_config_updated_at BEFORE UPDATE ON roadmap_proposal.proposal_type_config FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();


--
-- Name: resource_allocation trg_resource_allocation_updated_at; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_resource_allocation_updated_at BEFORE UPDATE ON roadmap.resource_allocation FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();


--
-- Name: spending_log trg_rollup_budget_consumed; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_rollup_budget_consumed AFTER INSERT ON roadmap_efficiency.spending_log FOR EACH ROW EXECUTE FUNCTION roadmap.fn_rollup_budget_consumed();


--
-- Name: agent_memory trg_set_memory_expires; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_set_memory_expires BEFORE INSERT ON roadmap_efficiency.agent_memory FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_memory_expires();


--
-- Name: proposal_version trg_set_version_number; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_set_version_number BEFORE INSERT ON roadmap_proposal.proposal_version FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_version_number();


--
-- Name: proposal trg_spawn_workflow; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_spawn_workflow AFTER INSERT ON roadmap_proposal.proposal FOR EACH ROW EXECUTE FUNCTION roadmap.fn_spawn_workflow();


--
-- Name: proposal_lease trg_sync_workload; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_sync_workload AFTER INSERT OR UPDATE ON roadmap_proposal.proposal_lease FOR EACH ROW EXECUTE FUNCTION roadmap.fn_sync_workload();


--
-- Name: proposal trg_validate_proposal_fields; Type: TRIGGER; Schema: roadmap; Owner: -
--

CREATE TRIGGER trg_validate_proposal_fields BEFORE INSERT OR UPDATE ON roadmap_proposal.proposal FOR EACH ROW EXECUTE FUNCTION roadmap.fn_validate_proposal_fields();


--
-- Name: agency_profile agency_profile_agent_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_workforce.agency_profile
    ADD CONSTRAINT agency_profile_agent_fkey FOREIGN KEY (agent_id) REFERENCES roadmap_workforce.agent_registry(id) ON DELETE CASCADE;


--
-- Name: agent_budget_ledger agent_budget_ledger_agent_run_id_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_efficiency.agent_budget_ledger
    ADD CONSTRAINT agent_budget_ledger_agent_run_id_fkey FOREIGN KEY (agent_run_id) REFERENCES roadmap_workforce.agent_runs(id) ON DELETE SET NULL;


--
-- Name: agent_budget_ledger agent_budget_ledger_proposal_id_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_efficiency.agent_budget_ledger
    ADD CONSTRAINT agent_budget_ledger_proposal_id_fkey FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE CASCADE;


--
-- Name: agent_capability agent_capability_agent_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_workforce.agent_capability
    ADD CONSTRAINT agent_capability_agent_fkey FOREIGN KEY (agent_id) REFERENCES roadmap_workforce.agent_registry(id) ON DELETE CASCADE;


--
-- Name: agent_capability agent_capability_verifier_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_workforce.agent_capability
    ADD CONSTRAINT agent_capability_verifier_fkey FOREIGN KEY (verified_by) REFERENCES roadmap_workforce.agent_registry(agent_identity) ON DELETE SET NULL;


--
-- Name: agent_conflicts agent_conflicts_proposal_id_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_workforce.agent_conflicts
    ADD CONSTRAINT agent_conflicts_proposal_id_fkey FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE CASCADE;


--
-- Name: agent_memory agent_memory_agent_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_efficiency.agent_memory
    ADD CONSTRAINT agent_memory_agent_fkey FOREIGN KEY (agent_identity) REFERENCES roadmap_workforce.agent_registry(agent_identity) ON DELETE CASCADE;


--
-- Name: agent_registry agent_registry_model_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_workforce.agent_registry
    ADD CONSTRAINT agent_registry_model_fkey FOREIGN KEY (preferred_model) REFERENCES roadmap.model_metadata(model_name) ON DELETE SET NULL;


--
-- Name: agent_runs agent_runs_proposal_id_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_workforce.agent_runs
    ADD CONSTRAINT agent_runs_proposal_id_fkey FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE SET NULL;


--
-- Name: agent_workload agent_workload_agent_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_workforce.agent_workload
    ADD CONSTRAINT agent_workload_agent_fkey FOREIGN KEY (agent_id) REFERENCES roadmap_workforce.agent_registry(id) ON DELETE CASCADE;


--
-- Name: attachment_registry attachment_registry_agent_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.attachment_registry
    ADD CONSTRAINT attachment_registry_agent_fkey FOREIGN KEY (uploaded_by) REFERENCES roadmap_workforce.agent_registry(agent_identity) ON DELETE SET NULL;


--
-- Name: attachment_registry attachment_registry_proposal_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.attachment_registry
    ADD CONSTRAINT attachment_registry_proposal_fkey FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE CASCADE;


--
-- Name: budget_allowance budget_allowance_team_id_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_efficiency.budget_allowance
    ADD CONSTRAINT budget_allowance_team_id_fkey FOREIGN KEY (team_id) REFERENCES roadmap_workforce.team(id) ON DELETE SET NULL;


--
-- Name: cache_hit_log cache_hit_log_agent_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_efficiency.cache_hit_log
    ADD CONSTRAINT cache_hit_log_agent_fkey FOREIGN KEY (agent_identity) REFERENCES roadmap_workforce.agent_registry(agent_identity) ON DELETE RESTRICT;


--
-- Name: cache_hit_log cache_hit_log_run_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_efficiency.cache_hit_log
    ADD CONSTRAINT cache_hit_log_run_fkey FOREIGN KEY (run_id) REFERENCES roadmap.run_log(run_id) ON DELETE SET NULL;


--
-- Name: cache_hit_log cache_hit_log_write_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_efficiency.cache_hit_log
    ADD CONSTRAINT cache_hit_log_write_fkey FOREIGN KEY (cache_write_id) REFERENCES roadmap_efficiency.cache_write_log(id) ON DELETE CASCADE;


--
-- Name: cache_write_log cache_write_log_agent_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_efficiency.cache_write_log
    ADD CONSTRAINT cache_write_log_agent_fkey FOREIGN KEY (agent_identity) REFERENCES roadmap_workforce.agent_registry(agent_identity) ON DELETE CASCADE;


--
-- Name: cache_write_log cache_write_log_proposal_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_efficiency.cache_write_log
    ADD CONSTRAINT cache_write_log_proposal_fkey FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE SET NULL;


--
-- Name: cache_write_log cache_write_log_run_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_efficiency.cache_write_log
    ADD CONSTRAINT cache_write_log_run_fkey FOREIGN KEY (run_id) REFERENCES roadmap.run_log(run_id) ON DELETE SET NULL;


--
-- Name: channel_subscription channel_subscription_agent_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.channel_subscription
    ADD CONSTRAINT channel_subscription_agent_fkey FOREIGN KEY (agent_identity) REFERENCES roadmap_workforce.agent_registry(agent_identity) ON DELETE CASCADE;


--
-- Name: context_window_log context_window_log_agent_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_efficiency.context_window_log
    ADD CONSTRAINT context_window_log_agent_fkey FOREIGN KEY (agent_identity) REFERENCES roadmap_workforce.agent_registry(agent_identity) ON DELETE CASCADE;


--
-- Name: context_window_log context_window_log_model_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_efficiency.context_window_log
    ADD CONSTRAINT context_window_log_model_fkey FOREIGN KEY (model_name) REFERENCES roadmap.model_metadata(model_name) ON DELETE RESTRICT;


--
-- Name: context_window_log context_window_log_proposal_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_efficiency.context_window_log
    ADD CONSTRAINT context_window_log_proposal_fkey FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE SET NULL;


--
-- Name: context_window_log context_window_log_run_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_efficiency.context_window_log
    ADD CONSTRAINT context_window_log_run_fkey FOREIGN KEY (run_id) REFERENCES roadmap.run_log(run_id) ON DELETE SET NULL;


--
-- Name: decision_queue decision_queue_proposal_id_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.decision_queue
    ADD CONSTRAINT decision_queue_proposal_id_fkey FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE CASCADE;


--
-- Name: embedding_index_registry embedding_index_registry_model_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.embedding_index_registry
    ADD CONSTRAINT embedding_index_registry_model_fkey FOREIGN KEY (model_name) REFERENCES roadmap.model_metadata(model_name) ON DELETE RESTRICT;


--
-- Name: proposal_decision fk_pd_proposal; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_decision
    ADD CONSTRAINT fk_pd_proposal FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE CASCADE;


--
-- Name: proposal_decision fk_pd_superseded; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_decision
    ADD CONSTRAINT fk_pd_superseded FOREIGN KEY (superseded_by) REFERENCES roadmap_proposal.proposal_decision(id) ON DELETE SET NULL;


--
-- Name: mcp_tool_assignment mcp_tool_assignment_agent_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.mcp_tool_assignment
    ADD CONSTRAINT mcp_tool_assignment_agent_fkey FOREIGN KEY (agent_id) REFERENCES roadmap_workforce.agent_registry(id) ON DELETE CASCADE;


--
-- Name: mcp_tool_assignment mcp_tool_assignment_tool_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.mcp_tool_assignment
    ADD CONSTRAINT mcp_tool_assignment_tool_fkey FOREIGN KEY (tool_id) REFERENCES roadmap.mcp_tool_registry(id) ON DELETE CASCADE;


--
-- Name: message_ledger message_ledger_from_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.message_ledger
    ADD CONSTRAINT message_ledger_from_fkey FOREIGN KEY (from_agent) REFERENCES roadmap_workforce.agent_registry(agent_identity) ON DELETE RESTRICT;


--
-- Name: message_ledger message_ledger_proposal_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.message_ledger
    ADD CONSTRAINT message_ledger_proposal_fkey FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE SET NULL;


--
-- Name: model_assignment model_assignment_model_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.model_assignment
    ADD CONSTRAINT model_assignment_model_fkey FOREIGN KEY (model_name) REFERENCES roadmap.model_metadata(model_name) ON DELETE RESTRICT;


--
-- Name: notification_delivery notification_delivery_notif_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.notification_delivery
    ADD CONSTRAINT notification_delivery_notif_fkey FOREIGN KEY (notification_id) REFERENCES roadmap.notification(id) ON DELETE CASCADE;


--
-- Name: notification notification_proposal_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.notification
    ADD CONSTRAINT notification_proposal_fkey FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE CASCADE;


--
-- Name: notification_queue notification_queue_proposal_id_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.notification_queue
    ADD CONSTRAINT notification_queue_proposal_id_fkey FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE SET NULL;


--
-- Name: notification notification_source_event_id_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.notification
    ADD CONSTRAINT notification_source_event_id_fkey FOREIGN KEY (source_event_id) REFERENCES roadmap_proposal.proposal_event(id) ON DELETE SET NULL;


--
-- Name: prompt_template prompt_template_author_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.prompt_template
    ADD CONSTRAINT prompt_template_author_fkey FOREIGN KEY (created_by) REFERENCES roadmap_workforce.agent_registry(agent_identity) ON DELETE RESTRICT;


--
-- Name: proposal_acceptance_criteria proposal_ac_proposal_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_acceptance_criteria
    ADD CONSTRAINT proposal_ac_proposal_fkey FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE CASCADE;


--
-- Name: proposal_acceptance_criteria proposal_ac_verifier_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_acceptance_criteria
    ADD CONSTRAINT proposal_ac_verifier_fkey FOREIGN KEY (verified_by) REFERENCES roadmap_workforce.agent_registry(agent_identity) ON DELETE SET NULL;



--
-- Name: proposal_dependencies proposal_deps_from_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_dependencies
    ADD CONSTRAINT proposal_deps_from_fkey FOREIGN KEY (from_proposal_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE CASCADE;


--
-- Name: proposal_dependencies proposal_deps_to_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_dependencies
    ADD CONSTRAINT proposal_deps_to_fkey FOREIGN KEY (to_proposal_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE CASCADE;


--
-- Name: proposal_discussions proposal_discussions_author_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_discussions
    ADD CONSTRAINT proposal_discussions_author_fkey FOREIGN KEY (author_identity) REFERENCES roadmap_workforce.agent_registry(agent_identity) ON DELETE RESTRICT;


--
-- Name: proposal_discussions proposal_discussions_parent_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_discussions
    ADD CONSTRAINT proposal_discussions_parent_fkey FOREIGN KEY (parent_id) REFERENCES roadmap_proposal.proposal_discussions(id) ON DELETE SET NULL;


--
-- Name: proposal_discussions proposal_discussions_proposal_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_discussions
    ADD CONSTRAINT proposal_discussions_proposal_fkey FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE CASCADE;


--
-- Name: proposal_event proposal_event_proposal_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_event
    ADD CONSTRAINT proposal_event_proposal_fkey FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE CASCADE;


--
-- Name: proposal_labels proposal_labels_agent_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_labels
    ADD CONSTRAINT proposal_labels_agent_fkey FOREIGN KEY (applied_by) REFERENCES roadmap_workforce.agent_registry(agent_identity) ON DELETE RESTRICT;


--
-- Name: proposal_labels proposal_labels_proposal_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_labels
    ADD CONSTRAINT proposal_labels_proposal_fkey FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE CASCADE;


--
-- Name: proposal_lease proposal_lease_agent_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_lease
    ADD CONSTRAINT proposal_lease_agent_fkey FOREIGN KEY (agent_identity) REFERENCES roadmap_workforce.agent_registry(agent_identity) ON DELETE RESTRICT;


--
-- Name: proposal_lease proposal_lease_proposal_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_lease
    ADD CONSTRAINT proposal_lease_proposal_fkey FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE CASCADE;


--
-- Name: proposal_maturity_transitions proposal_maturity_trans_proposal_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_maturity_transitions
    ADD CONSTRAINT proposal_maturity_trans_proposal_fkey FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE CASCADE;


--
-- Name: proposal_milestone proposal_milestone_proposal_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_milestone
    ADD CONSTRAINT proposal_milestone_proposal_fkey FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE CASCADE;


--
-- Name: proposal proposal_parent_id_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal
    ADD CONSTRAINT proposal_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE SET NULL;


--
-- Name: proposal_reviews proposal_reviews_proposal_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_reviews
    ADD CONSTRAINT proposal_reviews_proposal_fkey FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE CASCADE;


--
-- Name: proposal_reviews proposal_reviews_reviewer_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_reviews
    ADD CONSTRAINT proposal_reviews_reviewer_fkey FOREIGN KEY (reviewer_identity) REFERENCES roadmap_workforce.agent_registry(agent_identity) ON DELETE RESTRICT;


--
-- Name: proposal_state_transitions proposal_state_transitions_by_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_state_transitions
    ADD CONSTRAINT proposal_state_transitions_by_fkey FOREIGN KEY (transitioned_by) REFERENCES roadmap_workforce.agent_registry(agent_identity) ON DELETE SET NULL;


--
-- Name: proposal_state_transitions proposal_state_transitions_dep_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_state_transitions
    ADD CONSTRAINT proposal_state_transitions_dep_fkey FOREIGN KEY (depends_on_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE SET NULL;


--
-- Name: proposal_state_transitions proposal_state_transitions_proposal_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_state_transitions
    ADD CONSTRAINT proposal_state_transitions_proposal_fkey FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE CASCADE;


--
-- Name: proposal_template proposal_template_author_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_template
    ADD CONSTRAINT proposal_template_author_fkey FOREIGN KEY (created_by) REFERENCES roadmap_workforce.agent_registry(agent_identity) ON DELETE RESTRICT;


--
-- Name: proposal_template proposal_template_type_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_template
    ADD CONSTRAINT proposal_template_type_fkey FOREIGN KEY (type) REFERENCES roadmap_proposal.proposal_type_config(type) ON DELETE CASCADE;


--
-- Name: proposal_type_config proposal_type_config_wf_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_type_config
    ADD CONSTRAINT proposal_type_config_wf_fkey FOREIGN KEY (workflow_name) REFERENCES roadmap.workflow_templates(name) ON DELETE RESTRICT;


--
-- Name: proposal proposal_type_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal
    ADD CONSTRAINT proposal_type_fkey FOREIGN KEY (type) REFERENCES roadmap_proposal.proposal_type_config(type) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;


--
-- Name: proposal_valid_transitions proposal_valid_transitions_wf_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_valid_transitions
    ADD CONSTRAINT proposal_valid_transitions_wf_fkey FOREIGN KEY (workflow_name) REFERENCES roadmap.workflow_templates(name) ON DELETE RESTRICT;


--
-- Name: proposal_version proposal_version_author_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_version
    ADD CONSTRAINT proposal_version_author_fkey FOREIGN KEY (author_identity) REFERENCES roadmap_workforce.agent_registry(agent_identity) ON DELETE RESTRICT;


--
-- Name: proposal_version proposal_version_proposal_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_version
    ADD CONSTRAINT proposal_version_proposal_fkey FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE CASCADE;


--
-- Name: proposal_versions proposal_versions_proposal_id_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_proposal.proposal_versions
    ADD CONSTRAINT proposal_versions_proposal_id_fkey FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE CASCADE;


--
-- Name: research_cache research_cache_proposal_id_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.research_cache
    ADD CONSTRAINT research_cache_proposal_id_fkey FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE CASCADE;


--
-- Name: resource_allocation resource_allocation_agent_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.resource_allocation
    ADD CONSTRAINT resource_allocation_agent_fkey FOREIGN KEY (agent_id) REFERENCES roadmap_workforce.agent_registry(id) ON DELETE CASCADE;


--
-- Name: run_log run_log_agent_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.run_log
    ADD CONSTRAINT run_log_agent_fkey FOREIGN KEY (agent_identity) REFERENCES roadmap_workforce.agent_registry(agent_identity) ON DELETE RESTRICT;


--
-- Name: run_log run_log_model_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.run_log
    ADD CONSTRAINT run_log_model_fkey FOREIGN KEY (model_name) REFERENCES roadmap.model_metadata(model_name) ON DELETE SET NULL;


--
-- Name: run_log run_log_proposal_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.run_log
    ADD CONSTRAINT run_log_proposal_fkey FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE SET NULL;


--
-- Name: spending_caps spending_caps_agent_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_efficiency.spending_caps
    ADD CONSTRAINT spending_caps_agent_fkey FOREIGN KEY (agent_identity) REFERENCES roadmap_workforce.agent_registry(agent_identity) ON DELETE CASCADE;


--
-- Name: spending_log spending_log_agent_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_efficiency.spending_log
    ADD CONSTRAINT spending_log_agent_fkey FOREIGN KEY (agent_identity) REFERENCES roadmap_workforce.agent_registry(agent_identity) ON DELETE RESTRICT;


--
-- Name: spending_log spending_log_budget_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_efficiency.spending_log
    ADD CONSTRAINT spending_log_budget_fkey FOREIGN KEY (budget_id) REFERENCES roadmap_efficiency.budget_allowance(id) ON DELETE SET NULL;


--
-- Name: spending_log spending_log_model_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_efficiency.spending_log
    ADD CONSTRAINT spending_log_model_fkey FOREIGN KEY (model_name) REFERENCES roadmap.model_metadata(model_name) ON DELETE SET NULL;


--
-- Name: spending_log spending_log_proposal_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_efficiency.spending_log
    ADD CONSTRAINT spending_log_proposal_fkey FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE SET NULL;


--
-- Name: spending_log spending_log_run_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_efficiency.spending_log
    ADD CONSTRAINT spending_log_run_fkey FOREIGN KEY (run_id) REFERENCES roadmap.run_log(run_id) ON DELETE SET NULL;


--
-- Name: team_member team_member_agent_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_workforce.team_member
    ADD CONSTRAINT team_member_agent_fkey FOREIGN KEY (agent_id) REFERENCES roadmap_workforce.agent_registry(id) ON DELETE CASCADE;


--
-- Name: team_member team_member_team_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap_workforce.team_member
    ADD CONSTRAINT team_member_team_fkey FOREIGN KEY (team_id) REFERENCES roadmap_workforce.team(id) ON DELETE CASCADE;


--
-- Name: transition_queue transition_queue_proposal_id_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.transition_queue
    ADD CONSTRAINT transition_queue_proposal_id_fkey FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE CASCADE;


--
-- Name: user_session user_session_agent_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.user_session
    ADD CONSTRAINT user_session_agent_fkey FOREIGN KEY (agent_identity) REFERENCES roadmap_workforce.agent_registry(agent_identity) ON DELETE CASCADE;


--
-- Name: webhook_subscription webhook_subscription_agent_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.webhook_subscription
    ADD CONSTRAINT webhook_subscription_agent_fkey FOREIGN KEY (created_by) REFERENCES roadmap_workforce.agent_registry(agent_identity) ON DELETE RESTRICT;


--
-- Name: workflow_roles workflow_roles_template_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.workflow_roles
    ADD CONSTRAINT workflow_roles_template_fkey FOREIGN KEY (template_id) REFERENCES roadmap.workflow_templates(id) ON DELETE CASCADE;


--
-- Name: workflow_stages workflow_stages_maturity_gate_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.workflow_stages
    ADD CONSTRAINT workflow_stages_maturity_gate_fkey FOREIGN KEY (maturity_gate) REFERENCES roadmap.maturity(level) ON DELETE SET NULL;


--
-- Name: workflow_stages workflow_stages_template_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.workflow_stages
    ADD CONSTRAINT workflow_stages_template_fkey FOREIGN KEY (template_id) REFERENCES roadmap.workflow_templates(id) ON DELETE CASCADE;


--
-- Name: workflow_transitions workflow_transitions_template_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.workflow_transitions
    ADD CONSTRAINT workflow_transitions_template_fkey FOREIGN KEY (template_id) REFERENCES roadmap.workflow_templates(id) ON DELETE CASCADE;


--
-- Name: workflows workflows_proposal_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.workflows
    ADD CONSTRAINT workflows_proposal_fkey FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal(id) ON DELETE CASCADE;


--
-- Name: workflows workflows_template_fkey; Type: FK CONSTRAINT; Schema: roadmap; Owner: -
--

ALTER TABLE ONLY roadmap.workflows
    ADD CONSTRAINT workflows_template_fkey FOREIGN KEY (template_id) REFERENCES roadmap.workflow_templates(id) ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--

-- =============================================================================
-- Consolidated supplemental DDL not present in the live roadmap dump
-- =============================================================================

-- P090/P191: token efficiency metrics and semantic cache schemas.
CREATE SCHEMA IF NOT EXISTS metrics;
CREATE SCHEMA IF NOT EXISTS token_cache;

CREATE TABLE IF NOT EXISTS metrics.token_efficiency (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         uuid,
  agent_role         text,
  model              text        NOT NULL,
  task_type          text,
  proposal_id        text,
  input_tokens       int         NOT NULL DEFAULT 0,
  output_tokens      int         NOT NULL DEFAULT 0,
  cache_write_tokens int         NOT NULL DEFAULT 0,
  cache_read_tokens  int         NOT NULL DEFAULT 0,
  cache_hit_rate     numeric     GENERATED ALWAYS AS (
    CASE WHEN input_tokens > 0 THEN cache_read_tokens::numeric / input_tokens ELSE 0 END
  ) STORED,
  cost_microdollars  bigint,
  recorded_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_token_efficiency_recorded_at ON metrics.token_efficiency (recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_efficiency_agent_role ON metrics.token_efficiency (agent_role, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_efficiency_model ON metrics.token_efficiency (model, recorded_at DESC);

CREATE TABLE IF NOT EXISTS token_cache.semantic_responses (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  query_hash    text        NOT NULL,
  query_text    text        NOT NULL,
  response      jsonb       NOT NULL,
  agent_role    text,
  model         text        NOT NULL,
  input_tokens  int,
  output_tokens int,
  hit_count     int         NOT NULL DEFAULT 0,
  last_hit_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_semantic_responses_hash_role ON token_cache.semantic_responses (query_hash, agent_role);
CREATE INDEX IF NOT EXISTS idx_semantic_responses_hit_count ON token_cache.semantic_responses (hit_count DESC);

CREATE OR REPLACE VIEW metrics.v_daily_efficiency AS
SELECT date_trunc('day', recorded_at) AS day, agent_role, model, count(*) AS invocations,
  sum(input_tokens) AS total_input_tokens, sum(output_tokens) AS total_output_tokens,
  sum(cache_read_tokens) AS total_cache_read_tokens, round(avg(cache_hit_rate), 3) AS avg_cache_hit_rate,
  sum(cost_microdollars) AS total_cost_microdollars,
  round(CAST(sum(cost_microdollars) AS numeric) / 1000000, 4) AS total_cost_usd
FROM metrics.token_efficiency GROUP BY 1, 2, 3 ORDER BY 1 DESC, 5 DESC;

CREATE OR REPLACE VIEW metrics.v_weekly_efficiency AS
SELECT date_trunc('week', recorded_at) AS week_start, agent_role, model, count(*) AS invocations,
  sum(input_tokens) AS total_input_tokens, sum(output_tokens) AS total_output_tokens,
  sum(cache_read_tokens) AS total_cache_read_tokens, round(avg(cache_hit_rate), 3) AS avg_cache_hit_rate,
  sum(cost_microdollars) AS total_cost_microdollars,
  round(CAST(sum(cost_microdollars) AS numeric) / 1000000, 4) AS total_cost_usd
FROM metrics.token_efficiency GROUP BY 1, 2, 3 ORDER BY 1 DESC, 5 DESC;

CREATE OR REPLACE VIEW metrics.v_combined_metrics AS
SELECT d.day, d.agent_role, d.model, d.invocations, d.total_input_tokens, d.total_output_tokens,
  d.total_cache_read_tokens, d.avg_cache_hit_rate, d.total_cost_usd,
  CASE WHEN d.total_cost_usd > 0 THEN round((d.total_input_tokens + d.total_output_tokens) / d.total_cost_usd, 0) ELSE 0 END AS tokens_per_dollar,
  CASE WHEN d.total_input_tokens > 0 THEN round(CAST(d.total_cache_read_tokens AS numeric) / d.total_input_tokens * 100, 1) ELSE 0 END AS cache_efficiency_pct,
  w.invocations AS weekly_invocations, w.total_cost_usd AS weekly_cost_usd
FROM metrics.v_daily_efficiency d
LEFT JOIN metrics.v_weekly_efficiency w ON d.agent_role = w.agent_role AND d.model = w.model AND date_trunc('week', d.day) = w.week_start
ORDER BY d.day DESC, d.total_cost_usd DESC;

CREATE OR REPLACE VIEW metrics.v_agent_performance AS
SELECT agent_role, model, sum(invocations) AS total_invocations, sum(total_input_tokens) AS lifetime_input_tokens,
  sum(total_output_tokens) AS lifetime_output_tokens, round(avg(avg_cache_hit_rate), 3) AS overall_cache_hit_rate,
  sum(total_cost_usd) AS lifetime_cost_usd, round(sum(total_cost_usd) / NULLIF(sum(invocations), 0), 6) AS cost_per_invocation,
  round((sum(total_input_tokens) + sum(total_output_tokens)) / NULLIF(sum(total_cost_usd), 0), 0) AS tokens_per_dollar
FROM metrics.v_daily_efficiency GROUP BY 1, 2 ORDER BY lifetime_cost_usd DESC;

-- P063: pulse fleet observability tables expected by PgPulseHandlers.
CREATE TABLE IF NOT EXISTS roadmap_workforce.agent_health (
    agent_identity    text PRIMARY KEY REFERENCES roadmap_workforce.agent_registry(agent_identity) ON DELETE CASCADE,
    last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
    status            text NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy', 'stale', 'offline', 'crashed')),
    current_task      text,
    current_proposal  bigint REFERENCES roadmap_proposal.proposal(id) ON DELETE SET NULL,
    current_cubic     text REFERENCES roadmap.cubics(cubic_id) ON DELETE SET NULL,
    cpu_percent       numeric(5,2),
    memory_mb         integer,
    active_model      text,
    uptime_seconds    integer,
    metadata          jsonb DEFAULT '{}'::jsonb,
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS roadmap_workforce.agent_heartbeat_log (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    agent_identity    text NOT NULL REFERENCES roadmap_workforce.agent_registry(agent_identity) ON DELETE CASCADE,
    heartbeat_at      timestamptz NOT NULL DEFAULT now(),
    cpu_percent       numeric(5,2),
    memory_mb         integer,
    active_model      text,
    current_task      text,
    metadata          jsonb DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_heartbeat_log_agent_time ON roadmap_workforce.agent_heartbeat_log(agent_identity, heartbeat_at DESC);
CREATE OR REPLACE FUNCTION roadmap.fn_cleanup_old_heartbeats() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM roadmap_workforce.agent_heartbeat_log WHERE heartbeat_at < now() - interval '7 days';
END;
$$;
CREATE OR REPLACE FUNCTION roadmap.fn_agent_health_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_agent_health_updated_at BEFORE UPDATE ON roadmap_workforce.agent_health FOR EACH ROW EXECUTE FUNCTION roadmap.fn_agent_health_updated_at();

-- P148: worktree merge log.
CREATE TABLE IF NOT EXISTS roadmap.worktree_merge_log (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    proposal_id bigint NOT NULL REFERENCES roadmap_proposal.proposal(id) ON DELETE CASCADE,
    commit_sha text,
    status text NOT NULL CHECK (status IN ('merged', 'conflict', 'failed', 'pending')),
    conflict_files jsonb,
    error_message text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_worktree_merge_log_proposal ON roadmap.worktree_merge_log(proposal_id, created_at DESC);

-- P159/P080: cryptographic agent identity columns.
ALTER TABLE roadmap_workforce.agent_registry ADD COLUMN IF NOT EXISTS public_key text NULL;
ALTER TABLE roadmap_workforce.agent_registry ADD COLUMN IF NOT EXISTS key_rotated_at timestamptz NULL;

-- P163/P165: effective dependency blocking views.
ALTER TABLE roadmap_proposal.proposal_dependencies ADD COLUMN IF NOT EXISTS resolved_by text DEFAULT NULL;
CREATE OR REPLACE VIEW roadmap.v_effective_blocking AS
SELECT d.id AS dep_id, blocked.display_id AS blocked_by, blocked.title AS blocked_by_title,
    blocker.display_id AS blocking, blocker.title AS blocking_title,
    blocker.maturity AS blocking_maturity, blocker.status AS blocking_status,
    d.dependency_type, d.resolved_at,
    CASE WHEN d.resolved_at IS NOT NULL THEN 'resolved'
         WHEN blocker.maturity IN ('mature', 'obsolete') THEN 'auto_resolved'
         WHEN d.dependency_type = 'blocks' THEN 'blocking'
         ELSE d.dependency_type END AS effective_status
FROM roadmap_proposal.proposal_dependencies d
JOIN roadmap_proposal.proposal blocked ON blocked.id = d.from_proposal_id
JOIN roadmap_proposal.proposal blocker ON blocker.id = d.to_proposal_id
WHERE d.dependency_type = 'blocks';
CREATE OR REPLACE VIEW roadmap_proposal.v_blocking_diagram AS
SELECT 'i_depend_on'::text AS direction, d.from_proposal_id AS proposal_id, dep.display_id AS proposal_display_id,
    d.to_proposal_id AS related_id, rel.display_id AS related_display_id, rel.title AS related_title,
    rel.status AS related_status, rel.maturity AS related_maturity, d.dependency_type, d.resolved_at,
    CASE WHEN d.resolved_at IS NOT NULL THEN false
         WHEN d.dependency_type = 'blocks' AND rel.maturity NOT IN ('mature', 'obsolete') THEN true
         ELSE false END AS is_effective_blocker
FROM roadmap_proposal.proposal_dependencies d
JOIN roadmap_proposal.proposal dep ON dep.id = d.from_proposal_id
JOIN roadmap_proposal.proposal rel ON rel.id = d.to_proposal_id
UNION ALL
SELECT 'depends_on_me'::text AS direction, d.to_proposal_id AS proposal_id, rel.display_id AS proposal_display_id,
    d.from_proposal_id AS related_id, dep.display_id AS related_display_id, dep.title AS related_title,
    dep.status AS related_status, dep.maturity AS related_maturity, d.dependency_type, d.resolved_at,
    CASE WHEN d.resolved_at IS NOT NULL THEN false
         WHEN d.dependency_type = 'blocks' AND dep.maturity NOT IN ('mature', 'obsolete') THEN true
         ELSE false END AS is_effective_blocker
FROM roadmap_proposal.proposal_dependencies d
JOIN roadmap_proposal.proposal dep ON dep.id = d.from_proposal_id
JOIN roadmap_proposal.proposal rel ON rel.id = d.to_proposal_id;
DROP VIEW IF EXISTS roadmap_proposal.v_blocked_proposals;
CREATE VIEW roadmap_proposal.v_blocked_proposals AS
SELECT DISTINCT blocked.id, blocked.display_id, blocked.title, blocked.status, blocked.maturity,
    string_agg(DISTINCT blocker.display_id, ', ') AS blocked_by_proposals
FROM roadmap_proposal.proposal_dependencies d
JOIN roadmap_proposal.proposal blocked ON blocked.id = d.from_proposal_id
JOIN roadmap_proposal.proposal blocker ON blocker.id = d.to_proposal_id
WHERE d.dependency_type = 'blocks' AND d.resolved_at IS NULL AND blocker.maturity NOT IN ('mature', 'obsolete')
GROUP BY blocked.id, blocked.display_id, blocked.title, blocked.status, blocked.maturity;

-- P067/P149: document store, protocol threads, mentions, message read tracking.
CREATE TABLE IF NOT EXISTS roadmap.documents (
    id              bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    proposal_id     bigint NULL,
    title           text NOT NULL,
    content         text NOT NULL,
    doc_type        text DEFAULT 'spec' NOT NULL,
    author          text NOT NULL,
    version         integer DEFAULT 1 NOT NULL,
    created_at      timestamptz DEFAULT now() NOT NULL,
    updated_at      timestamptz DEFAULT now() NOT NULL,
    deleted_at      timestamptz NULL,
    tsvector_col    tsvector NULL,
    CONSTRAINT documents_pkey PRIMARY KEY (id),
    CONSTRAINT documents_proposal_fkey FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal (id) ON DELETE SET NULL,
    CONSTRAINT documents_author_fkey FOREIGN KEY (author) REFERENCES roadmap_workforce.agent_registry (agent_identity) ON DELETE RESTRICT,
    CONSTRAINT documents_doc_type_check CHECK (doc_type IN ('spec', 'decision', 'runbook', 'adr', 'design', 'other')),
    CONSTRAINT documents_version_check CHECK (version > 0)
);
CREATE INDEX IF NOT EXISTS idx_documents_tsvector ON roadmap.documents USING gin (tsvector_col);
CREATE INDEX IF NOT EXISTS idx_documents_proposal ON roadmap.documents (proposal_id) WHERE proposal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_active ON roadmap.documents (id) WHERE deleted_at IS NULL;
CREATE OR REPLACE FUNCTION roadmap.fn_documents_tsvector_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.tsvector_col := to_tsvector('english', coalesce(NEW.title, '') || ' ' || coalesce(NEW.content, ''));
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_documents_tsvector BEFORE INSERT OR UPDATE OF title, content ON roadmap.documents FOR EACH ROW EXECUTE FUNCTION roadmap.fn_documents_tsvector_update();
CREATE TRIGGER trg_documents_updated_at BEFORE UPDATE ON roadmap.documents FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();
CREATE TABLE IF NOT EXISTS roadmap.document_versions (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    document_id bigint NOT NULL,
    version integer NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    author text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT document_versions_pkey PRIMARY KEY (id),
    CONSTRAINT document_versions_doc_fkey FOREIGN KEY (document_id) REFERENCES roadmap.documents (id) ON DELETE CASCADE,
    CONSTRAINT document_versions_author_fkey FOREIGN KEY (author) REFERENCES roadmap_workforce.agent_registry (agent_identity) ON DELETE RESTRICT,
    CONSTRAINT document_versions_unique UNIQUE (document_id, version)
);
CREATE INDEX IF NOT EXISTS idx_doc_versions_document ON roadmap.document_versions (document_id);

ALTER TABLE roadmap.channel_subscription DROP CONSTRAINT IF EXISTS channel_subscription_pkey;
ALTER TABLE roadmap.channel_subscription ADD COLUMN IF NOT EXISTS id bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE ONLY roadmap.channel_subscription ADD CONSTRAINT channel_subscription_pkey PRIMARY KEY (id);
ALTER TABLE ONLY roadmap.channel_subscription ADD CONSTRAINT channel_subscription_unique UNIQUE (agent_identity, channel);
CREATE INDEX IF NOT EXISTS idx_channel_sub_agent ON roadmap.channel_subscription (agent_identity);

CREATE TABLE IF NOT EXISTS roadmap.protocol_threads (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    thread_id text NOT NULL,
    channel text NOT NULL,
    proposal_id bigint NULL,
    root_message text NOT NULL,
    root_author text NOT NULL,
    reply_count integer DEFAULT 0 NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    last_activity timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT protocol_threads_pkey PRIMARY KEY (id),
    CONSTRAINT protocol_threads_unique UNIQUE (thread_id),
    CONSTRAINT protocol_threads_proposal_fkey FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal (id) ON DELETE SET NULL,
    CONSTRAINT protocol_threads_author_fkey FOREIGN KEY (root_author) REFERENCES roadmap_workforce.agent_registry (agent_identity) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_protocol_threads_channel ON roadmap.protocol_threads (channel);
CREATE INDEX IF NOT EXISTS idx_protocol_threads_proposal ON roadmap.protocol_threads (proposal_id) WHERE proposal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_protocol_threads_activity ON roadmap.protocol_threads (last_activity DESC);
CREATE TABLE IF NOT EXISTS roadmap.protocol_replies (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    thread_id text NOT NULL,
    seq integer NOT NULL,
    author text NOT NULL,
    content text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT protocol_replies_pkey PRIMARY KEY (id),
    CONSTRAINT protocol_replies_thread_fkey FOREIGN KEY (thread_id) REFERENCES roadmap.protocol_threads (thread_id) ON DELETE CASCADE,
    CONSTRAINT protocol_replies_author_fkey FOREIGN KEY (author) REFERENCES roadmap_workforce.agent_registry (agent_identity) ON DELETE RESTRICT,
    CONSTRAINT protocol_replies_seq_unique UNIQUE (thread_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_protocol_replies_thread ON roadmap.protocol_replies (thread_id);
CREATE OR REPLACE FUNCTION roadmap.fn_thread_reply_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE roadmap.protocol_threads SET reply_count = reply_count + 1, last_activity = now() WHERE thread_id = NEW.thread_id;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_protocol_replies_count AFTER INSERT ON roadmap.protocol_replies FOR EACH ROW EXECUTE FUNCTION roadmap.fn_thread_reply_update();
CREATE TABLE IF NOT EXISTS roadmap.mentions (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    mentioned_agent text NOT NULL,
    mentioned_by text NOT NULL,
    proposal_id bigint NULL,
    thread_id text NULL,
    context text NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    read_at timestamptz NULL,
    CONSTRAINT mentions_pkey PRIMARY KEY (id),
    CONSTRAINT mentions_agent_fkey FOREIGN KEY (mentioned_agent) REFERENCES roadmap_workforce.agent_registry (agent_identity) ON DELETE CASCADE,
    CONSTRAINT mentions_by_fkey FOREIGN KEY (mentioned_by) REFERENCES roadmap_workforce.agent_registry (agent_identity) ON DELETE RESTRICT,
    CONSTRAINT mentions_proposal_fkey FOREIGN KEY (proposal_id) REFERENCES roadmap_proposal.proposal (id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_mentions_agent ON roadmap.mentions (mentioned_agent);
CREATE INDEX IF NOT EXISTS idx_mentions_proposal ON roadmap.mentions (proposal_id) WHERE proposal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mentions_unread ON roadmap.mentions (mentioned_agent) WHERE read_at IS NULL;

ALTER TABLE roadmap.message_ledger ADD COLUMN IF NOT EXISTS read_at timestamptz NULL;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'message_ledger_to_agent_fkey'
          AND conrelid = 'roadmap.message_ledger'::regclass
    ) THEN
        ALTER TABLE roadmap.message_ledger ADD CONSTRAINT message_ledger_to_agent_fkey
            FOREIGN KEY (to_agent) REFERENCES roadmap_workforce.agent_registry (agent_identity) ON DELETE RESTRICT;
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_message_unread ON roadmap.message_ledger (to_agent) WHERE read_at IS NULL AND to_agent IS NOT NULL;

-- P208/P209: draft agent trust model and external identity mapping.
ALTER TABLE roadmap_workforce.agent_registry
    ADD COLUMN IF NOT EXISTS trust_tier text NOT NULL DEFAULT 'restricted'
    CHECK (trust_tier IN ('authority', 'trusted', 'known', 'restricted', 'blocked'));

CREATE TABLE IF NOT EXISTS roadmap_workforce.agent_trust (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    agent_identity text NOT NULL,
    trusted_agent text NOT NULL,
    trust_level text NOT NULL,
    granted_by text NOT NULL,
    expires_at timestamptz NULL,
    reason text NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT agent_trust_pkey PRIMARY KEY (id),
    CONSTRAINT agent_trust_unique UNIQUE (agent_identity, trusted_agent),
    CONSTRAINT agent_trust_agent_fkey FOREIGN KEY (agent_identity) REFERENCES roadmap_workforce.agent_registry (agent_identity) ON DELETE CASCADE,
    CONSTRAINT agent_trust_trusted_agent_fkey FOREIGN KEY (trusted_agent) REFERENCES roadmap_workforce.agent_registry (agent_identity) ON DELETE CASCADE,
    CONSTRAINT agent_trust_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES roadmap_workforce.agent_registry (agent_identity) ON DELETE RESTRICT,
    CONSTRAINT agent_trust_level_check CHECK (trust_level IN ('authority', 'trusted', 'known', 'restricted', 'blocked'))
);
CREATE INDEX IF NOT EXISTS idx_agent_trust_agent_level ON roadmap_workforce.agent_trust (agent_identity, trust_level);
CREATE INDEX IF NOT EXISTS idx_agent_trust_trusted_level ON roadmap_workforce.agent_trust (trusted_agent, trust_level);
CREATE INDEX IF NOT EXISTS idx_agent_trust_expires_at ON roadmap_workforce.agent_trust (expires_at) WHERE expires_at IS NOT NULL;
CREATE TRIGGER trg_agent_trust_updated_at BEFORE UPDATE ON roadmap_workforce.agent_trust FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();

CREATE TABLE IF NOT EXISTS roadmap.channel_identities (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    channel text NOT NULL,
    external_id text NOT NULL,
    external_handle text NULL,
    agent_identity text NOT NULL,
    trust_tier text DEFAULT 'restricted' NOT NULL,
    verified boolean DEFAULT false NOT NULL,
    mapped_by text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    expires_at timestamptz NULL,
    CONSTRAINT channel_identities_pkey PRIMARY KEY (id),
    CONSTRAINT channel_identities_unique UNIQUE (channel, external_id),
    CONSTRAINT channel_identities_agent_fkey FOREIGN KEY (agent_identity) REFERENCES roadmap_workforce.agent_registry (agent_identity) ON DELETE CASCADE,
    CONSTRAINT channel_identities_mapped_by_fkey FOREIGN KEY (mapped_by) REFERENCES roadmap_workforce.agent_registry (agent_identity) ON DELETE RESTRICT,
    CONSTRAINT channel_identities_trust_tier_check CHECK (trust_tier IN ('authority', 'trusted', 'known', 'restricted', 'blocked'))
);
CREATE INDEX IF NOT EXISTS idx_channel_identities_agent ON roadmap.channel_identities (agent_identity);
CREATE INDEX IF NOT EXISTS idx_channel_identities_trust_tier ON roadmap.channel_identities (trust_tier);
CREATE INDEX IF NOT EXISTS idx_channel_identities_expires_at ON roadmap.channel_identities (expires_at) WHERE expires_at IS NOT NULL;
CREATE TRIGGER trg_channel_identities_updated_at BEFORE UPDATE ON roadmap.channel_identities FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();

-- =============================================================================
-- Gemini refactor overlay: domain schemas, term authority, and lease-facing views
-- =============================================================================

CREATE TABLE IF NOT EXISTS roadmap_proposal.proposal_projection_cache (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    proposal_id bigint NOT NULL REFERENCES roadmap_proposal.proposal (id) ON DELETE CASCADE,
    projection_key text NOT NULL,
    projection_format text DEFAULT 'yaml_md' NOT NULL CHECK (projection_format IN ('yaml_md', 'json')),
    projection_body text NOT NULL,
    source_hash text,
    created_at timestamptz DEFAULT now() NOT NULL,
    refreshed_at timestamptz DEFAULT now() NOT NULL,
    expires_at timestamptz,
    CONSTRAINT proposal_projection_cache_unique UNIQUE (proposal_id, projection_key, projection_format)
);
CREATE INDEX IF NOT EXISTS idx_proposal_projection_cache_expires ON roadmap_proposal.proposal_projection_cache (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS roadmap_proposal.gate_decision_log (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    proposal_id bigint NOT NULL REFERENCES roadmap_proposal.proposal (id) ON DELETE CASCADE,
    from_state text NOT NULL,
    to_state text NOT NULL,
    maturity text NOT NULL,
    gate text,
    decided_by text NOT NULL REFERENCES roadmap_workforce.agent_registry (agent_identity) ON DELETE RESTRICT,
    authority_agent text REFERENCES roadmap_workforce.agent_registry (agent_identity) ON DELETE SET NULL,
    decision text NOT NULL CHECK (decision IN ('advance', 'hold', 'reject', 'waive', 'escalate')),
    rationale text,
    signature_hash text,
    created_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gate_decision_log_proposal ON roadmap_proposal.gate_decision_log (proposal_id, created_at DESC);

CREATE TABLE IF NOT EXISTS roadmap.reference_terms (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    term_category text NOT NULL,
    term_value text NOT NULL,
    display_name text,
    description text,
    sort_order integer DEFAULT 0 NOT NULL,
    is_immutable boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT reference_terms_pkey PRIMARY KEY (id),
    CONSTRAINT reference_terms_unique UNIQUE (term_category, term_value)
);
CREATE INDEX IF NOT EXISTS idx_reference_terms_category ON roadmap.reference_terms (term_category, sort_order, term_value);
CREATE TRIGGER trg_reference_terms_updated_at BEFORE UPDATE ON roadmap.reference_terms FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();

INSERT INTO roadmap.reference_terms (term_category, term_value, display_name, sort_order, description) VALUES
    ('proposal_state', 'Draft', 'Draft', 10, 'Proposal is being shaped'),
    ('proposal_state', 'Review', 'Review', 20, 'Proposal is under review'),
    ('proposal_state', 'Develop', 'Develop', 30, 'Proposal is in implementation'),
    ('proposal_state', 'Merge', 'Merge', 40, 'Proposal implementation is ready to merge'),
    ('proposal_state', 'Complete', 'Complete', 50, 'Proposal is complete'),
    ('proposal_state', 'Rejected', 'Rejected', 60, 'Proposal was rejected'),
    ('proposal_state', 'Abandoned', 'Abandoned', 70, 'Proposal was abandoned'),
    ('proposal_state', 'Replaced', 'Replaced', 80, 'Proposal was superseded'),
    ('maturity', 'new', 'New', 10, 'New within the current workflow state'),
    ('maturity', 'active', 'Active', 20, 'Actively progressing within the current workflow state'),
    ('maturity', 'mature', 'Mature', 30, 'Ready for transition or gate evaluation'),
    ('maturity', 'obsolete', 'Obsolete', 40, 'No longer active'),
    ('proposal_type', 'theory', 'Theory', 10, 'Design or research-oriented proposal'),
    ('proposal_type', 'product', 'Product', 20, 'Product-level proposal'),
    ('proposal_type', 'feature', 'Feature', 30, 'Feature implementation proposal'),
    ('proposal_type', 'hotfix', 'Hotfix', 40, 'Urgent correction proposal'),
    ('trust_tier', 'authority', 'Authority', 10, 'Can override trust and governance decisions'),
    ('trust_tier', 'trusted', 'Trusted', 20, 'Full bidirectional agent communication'),
    ('trust_tier', 'known', 'Known', 30, 'Known sender with restricted action authority'),
    ('trust_tier', 'restricted', 'Restricted', 40, 'Deny-by-default sender'),
    ('trust_tier', 'blocked', 'Blocked', 50, 'Quarantined sender')
ON CONFLICT (term_category, term_value) DO NOTHING;

ALTER TABLE ONLY roadmap_proposal.proposal
    ADD CONSTRAINT proposal_status_reference_term_fkey
    FOREIGN KEY (status_term_category, status)
    REFERENCES roadmap.reference_terms (term_category, term_value);
ALTER TABLE ONLY roadmap_proposal.proposal
    ADD CONSTRAINT proposal_maturity_reference_term_fkey
    FOREIGN KEY (maturity_term_category, maturity)
    REFERENCES roadmap.reference_terms (term_category, term_value);

CREATE OR REPLACE FUNCTION roadmap.fn_validate_proposal_reference_terms() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM roadmap.reference_terms rt
        WHERE rt.term_category = 'proposal_state'
          AND rt.term_value = NEW.status
    ) THEN
        RAISE EXCEPTION 'Unknown proposal status "%"', NEW.status
            USING ERRCODE = 'check_violation',
                  HINT = 'Consult roadmap.reference_terms where term_category = proposal_state.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM roadmap.reference_terms rt
        WHERE rt.term_category = 'maturity'
          AND rt.term_value = NEW.maturity
    ) THEN
        RAISE EXCEPTION 'Unknown proposal maturity "%"', NEW.maturity
            USING ERRCODE = 'check_violation',
                  HINT = 'Consult roadmap.reference_terms where term_category = maturity.';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_proposal_reference_terms
    BEFORE INSERT OR UPDATE ON roadmap_proposal.proposal
    FOR EACH ROW
    EXECUTE FUNCTION roadmap.fn_validate_proposal_reference_terms();

CREATE TABLE IF NOT EXISTS roadmap.app_config (
    config_key text NOT NULL,
    config_value jsonb NOT NULL,
    config_category text DEFAULT 'general' NOT NULL,
    description text,
    is_sensitive boolean DEFAULT false NOT NULL,
    updated_by text REFERENCES roadmap_workforce.agent_registry (agent_identity) ON DELETE SET NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT app_config_pkey PRIMARY KEY (config_key)
);
CREATE INDEX IF NOT EXISTS idx_app_config_category ON roadmap.app_config (config_category);
CREATE TRIGGER trg_app_config_updated_at BEFORE UPDATE ON roadmap.app_config FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();

INSERT INTO roadmap.app_config (config_key, config_value, config_category, description) VALUES
    ('ui_mode', '"dashboard"', 'ui', 'Default interface mode'),
    ('git_auto_commit_status', 'true', 'git', 'Whether workflow automation may auto-commit'),
    ('export_path', '"export"', 'export', 'Default export directory')
ON CONFLICT (config_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS roadmap.mcp_registry (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    endpoint_name text NOT NULL,
    transport_type text NOT NULL,
    interaction_mode text DEFAULT 'chunky' NOT NULL,
    host text DEFAULT '127.0.0.1',
    port integer,
    endpoint_url text,
    heartbeat_interval_seconds integer DEFAULT 30 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT mcp_registry_pkey PRIMARY KEY (id),
    CONSTRAINT mcp_registry_endpoint_unique UNIQUE (endpoint_name),
    CONSTRAINT mcp_registry_interaction_mode_check CHECK (interaction_mode IN ('chunky', 'chatty')),
    CONSTRAINT mcp_registry_transport_check CHECK (transport_type IN ('sse', 'chatty', 'chunky', 'stdio', 'http'))
);
CREATE INDEX IF NOT EXISTS idx_mcp_registry_active ON roadmap.mcp_registry (is_active, transport_type);
CREATE TRIGGER trg_mcp_registry_updated_at BEFORE UPDATE ON roadmap.mcp_registry FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();

CREATE TABLE IF NOT EXISTS roadmap.ui_preferences (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    preference_scope text DEFAULT 'global' NOT NULL,
    agent_identity text REFERENCES roadmap_workforce.agent_registry (agent_identity) ON DELETE CASCADE,
    ui_surface text DEFAULT 'dashboard' NOT NULL,
    max_column_width integer DEFAULT 80 NOT NULL,
    theme text DEFAULT 'system' NOT NULL,
    refresh_rate_seconds integer DEFAULT 5 NOT NULL,
    preferences jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT ui_preferences_pkey PRIMARY KEY (id),
    CONSTRAINT ui_preferences_scope_check CHECK (preference_scope IN ('global', 'agent', 'team'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ui_preferences_unique ON roadmap.ui_preferences (preference_scope, COALESCE(agent_identity, ''), ui_surface);
CREATE INDEX IF NOT EXISTS idx_ui_preferences_agent ON roadmap.ui_preferences (agent_identity) WHERE agent_identity IS NOT NULL;
CREATE TRIGGER trg_ui_preferences_updated_at BEFORE UPDATE ON roadmap.ui_preferences FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();

CREATE OR REPLACE VIEW roadmap_proposal.v_proposal_full AS
 SELECT p.id,
    p.display_id,
    p.parent_id,
    p.type,
    p.status,
    p.maturity,
    p.title,
    p.summary,
    p.motivation,
    p.design,
    p.drawbacks,
    p.alternatives,
    p.dependency,
    p.priority,
    p.tags,
    p.audit,
    p.created_at,
    p.modified_at,
    COALESCE(dep.deps, '[]'::jsonb) AS dependencies,
    COALESCE(ac.criteria, '[]'::jsonb) AS acceptance_criteria,
    "dec".latest_decision,
    "dec".decision_at,
    lease.leased_by,
    lease.lease_expires,
    wf.workflow_name,
    wf.current_stage
   FROM (((((roadmap_proposal.proposal p
     LEFT JOIN LATERAL ( SELECT jsonb_agg(jsonb_build_object('to_display_id', pd.display_id, 'dependency_type', d.dependency_type, 'resolved', d.resolved)) AS deps
           FROM (roadmap_proposal.proposal_dependencies d
             JOIN roadmap_proposal.proposal pd ON ((pd.id = d.to_proposal_id)))
          WHERE (d.from_proposal_id = p.id)) dep ON (true))
     LEFT JOIN LATERAL ( SELECT jsonb_agg(jsonb_build_object('item_number', ac_1.item_number, 'criterion_text', ac_1.criterion_text, 'status', ac_1.status, 'verified_by', ac_1.verified_by) ORDER BY ac_1.item_number) AS criteria
           FROM roadmap_proposal.proposal_acceptance_criteria ac_1
          WHERE (ac_1.proposal_id = p.id)) ac ON (true))
     LEFT JOIN LATERAL ( SELECT pd.decision AS latest_decision,
            pd.decided_at AS decision_at
           FROM roadmap_proposal.proposal_decision pd
          WHERE (pd.proposal_id = p.id)
          ORDER BY pd.decided_at DESC
         LIMIT 1) "dec" ON (true))
     LEFT JOIN LATERAL ( SELECT pl.agent_identity AS leased_by,
            pl.expires_at AS lease_expires
           FROM roadmap_proposal.proposal_lease pl
          WHERE ((pl.proposal_id = p.id) AND (pl.released_at IS NULL))
          ORDER BY pl.claimed_at DESC
         LIMIT 1) lease ON (true))
     LEFT JOIN LATERAL ( SELECT ptc.workflow_name,
            w.current_stage
           FROM ((roadmap.workflows w
             JOIN roadmap.workflow_templates wt ON ((wt.id = w.template_id)))
             JOIN roadmap_proposal.proposal_type_config ptc ON ((ptc.workflow_name = wt.name)))
          WHERE (w.proposal_id = p.id)
         LIMIT 1) wf ON (true));

CREATE OR REPLACE VIEW roadmap_proposal.workflow_state AS
SELECT w.id, w.proposal_id, p.display_id, w.template_id, wt.name AS workflow_name,
       w.current_stage, p.status AS proposal_state, p.maturity AS lifecycle_maturity,
       w.started_at, w.completed_at
FROM roadmap.workflows w
JOIN roadmap.workflow_templates wt ON wt.id = w.template_id
JOIN roadmap_proposal.proposal p ON p.id = w.proposal_id;

CREATE OR REPLACE VIEW roadmap_proposal.claim_log AS
SELECT l.id AS claim_id, l.proposal_id, p.display_id, l.agent_identity,
       l.claimed_at, l.expires_at, l.released_at, l.release_reason, l.is_active,
       CASE
         WHEN l.released_at IS NOT NULL THEN 'released'
         WHEN l.expires_at IS NOT NULL AND l.expires_at <= now() THEN 'expired'
         ELSE 'active'
       END AS claim_status
FROM roadmap_proposal.proposal_lease l
JOIN roadmap_proposal.proposal p ON p.id = l.proposal_id;

CREATE OR REPLACE VIEW roadmap_workforce.agent_profile AS
SELECT ar.id, ar.agent_identity, ar.agent_type, ar.role, ar.skills, ar.preferred_model,
       ar.status, ar.github_handle, ar.trust_tier, ar.public_key, ar.key_rotated_at,
       aw.active_lease_count, aw.context_load_score, ap.github_repo, ap.branch,
       ap.profile_path, ap.sync_status, ap.profile_data, ar.created_at, ar.updated_at
FROM roadmap_workforce.agent_registry ar
LEFT JOIN roadmap_workforce.agent_workload aw ON aw.agent_id = ar.id
LEFT JOIN roadmap_workforce.agency_profile ap ON ap.agent_id = ar.id;

CREATE OR REPLACE VIEW roadmap_workforce.trust_ledger AS
SELECT at.id, at.agent_identity, at.trusted_agent, at.trust_level, at.granted_by,
       at.expires_at, at.reason, at.created_at, at.updated_at
FROM roadmap_workforce.agent_trust at;

CREATE TABLE IF NOT EXISTS roadmap_workforce.squad_dispatch (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    proposal_id bigint NOT NULL REFERENCES roadmap_proposal.proposal (id) ON DELETE CASCADE,
    agent_identity text NOT NULL REFERENCES roadmap_workforce.agent_registry (agent_identity) ON DELETE CASCADE,
    squad_name text NOT NULL,
    dispatch_role text NOT NULL,
    dispatch_status text DEFAULT 'assigned' NOT NULL,
    lease_id bigint REFERENCES roadmap_proposal.proposal_lease (id) ON DELETE SET NULL,
    assigned_by text REFERENCES roadmap_workforce.agent_registry (agent_identity) ON DELETE SET NULL,
    assigned_at timestamptz DEFAULT now() NOT NULL,
    completed_at timestamptz,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT squad_dispatch_pkey PRIMARY KEY (id),
    CONSTRAINT squad_dispatch_status_check CHECK (dispatch_status IN ('assigned', 'active', 'blocked', 'completed', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_squad_dispatch_proposal ON roadmap_workforce.squad_dispatch (proposal_id, dispatch_status);
CREATE INDEX IF NOT EXISTS idx_squad_dispatch_agent ON roadmap_workforce.squad_dispatch (agent_identity, dispatch_status);

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_claim_dispatch_lease() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_lease_id bigint;
BEGIN
    IF NEW.dispatch_status <> 'active' THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE'
       AND OLD.dispatch_status IS NOT DISTINCT FROM NEW.dispatch_status
       AND NEW.lease_id IS NOT NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.lease_id IS NOT NULL THEN
        RETURN NEW;
    END IF;

    SELECT pl.id
    INTO v_lease_id
    FROM roadmap_proposal.proposal_lease pl
    WHERE pl.proposal_id = NEW.proposal_id
      AND pl.agent_identity = NEW.agent_identity
      AND pl.released_at IS NULL
      AND (pl.expires_at IS NULL OR pl.expires_at > now())
    ORDER BY pl.claimed_at DESC
    LIMIT 1;

    IF v_lease_id IS NULL THEN
        INSERT INTO roadmap_proposal.proposal_lease (proposal_id, agent_identity)
        VALUES (NEW.proposal_id, NEW.agent_identity)
        RETURNING id INTO v_lease_id;
    END IF;

    NEW.lease_id := v_lease_id;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_squad_dispatch_claim_lease
    BEFORE INSERT OR UPDATE ON roadmap_workforce.squad_dispatch
    FOR EACH ROW
    EXECUTE FUNCTION roadmap_workforce.fn_claim_dispatch_lease();

CREATE TABLE IF NOT EXISTS roadmap_workforce.authority_chain (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    authority_agent text NOT NULL REFERENCES roadmap_workforce.agent_registry (agent_identity) ON DELETE CASCADE,
    scope_category text NOT NULL,
    scope_ref text,
    authority_level text DEFAULT 'authority' NOT NULL,
    can_override boolean DEFAULT false NOT NULL,
    granted_by text NOT NULL REFERENCES roadmap_workforce.agent_registry (agent_identity) ON DELETE RESTRICT,
    reason text,
    expires_at timestamptz,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT authority_chain_pkey PRIMARY KEY (id),
    CONSTRAINT authority_chain_unique UNIQUE (authority_agent, scope_category, scope_ref),
    CONSTRAINT authority_chain_level_check CHECK (authority_level IN ('authority', 'trusted', 'known'))
);
CREATE INDEX IF NOT EXISTS idx_authority_chain_scope ON roadmap_workforce.authority_chain (scope_category, scope_ref);
CREATE TRIGGER trg_authority_chain_updated_at BEFORE UPDATE ON roadmap_workforce.authority_chain FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();

CREATE OR REPLACE VIEW roadmap_efficiency.token_ledger AS
SELECT sl.id, sl.agent_identity, sl.proposal_id, sl.model_name, sl.cost_usd,
       sl.token_count, sl.run_id, sl.budget_id, sl.created_at
FROM roadmap_efficiency.spending_log sl;

CREATE OR REPLACE VIEW roadmap_efficiency.context_cache AS
SELECT sr.id, sr.query_hash AS cache_key, sr.query_text, sr.response, sr.agent_role,
       sr.model, sr.input_tokens, sr.output_tokens, sr.hit_count, sr.last_hit_at, sr.created_at
FROM token_cache.semantic_responses sr;

CREATE TABLE IF NOT EXISTS roadmap_efficiency.budget_circuit_breaker (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    circuit_name text NOT NULL UNIQUE,
    status text DEFAULT 'armed' NOT NULL CHECK (status IN ('armed', 'tripped', 'disabled')),
    tripped_by text REFERENCES roadmap_workforce.agent_registry (agent_identity) ON DELETE SET NULL,
    anomaly_reason text,
    threshold_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    tripped_at timestamptz,
    reset_at timestamptz,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL
);
CREATE TRIGGER trg_budget_circuit_breaker_updated_at BEFORE UPDATE ON roadmap_efficiency.budget_circuit_breaker FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();

CREATE TABLE IF NOT EXISTS roadmap_efficiency.api_buffer (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    request_key text NOT NULL,
    agent_identity text REFERENCES roadmap_workforce.agent_registry (agent_identity) ON DELETE SET NULL,
    proposal_id bigint REFERENCES roadmap_proposal.proposal (id) ON DELETE SET NULL,
    model_name text REFERENCES roadmap.model_metadata (model_name) ON DELETE SET NULL,
    request_payload jsonb NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    status text DEFAULT 'pending' NOT NULL,
    scheduled_for timestamptz DEFAULT now() NOT NULL,
    claimed_at timestamptz,
    completed_at timestamptz,
    error_message text,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT api_buffer_pkey PRIMARY KEY (id),
    CONSTRAINT api_buffer_request_key_unique UNIQUE (request_key),
    CONSTRAINT api_buffer_status_check CHECK (status IN ('pending', 'claimed', 'completed', 'failed', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_api_buffer_pending ON roadmap_efficiency.api_buffer (scheduled_for, priority) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_api_buffer_agent ON roadmap_efficiency.api_buffer (agent_identity, status);
CREATE TRIGGER trg_api_buffer_updated_at BEFORE UPDATE ON roadmap_efficiency.api_buffer FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();
