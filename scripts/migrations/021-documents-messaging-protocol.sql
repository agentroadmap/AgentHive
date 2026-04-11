-- =============================================================================
-- MIGRATION 021: Documents, Messaging Enhancements & Protocol (P067)
-- Generated: 2026-04-11
--
-- Adds:
--   1. roadmap.documents — versioned, full-text searchable store with GIN tsvector
--   2. roadmap.document_versions — version history for each document
--   3. roadmap.channel_subscription — agent channel subscriptions for pg_notify
--   4. roadmap.protocol_threads — threaded discussions backed by Postgres
--   5. roadmap.mentions — @-mention records linking agents to proposals/threads
--   6. message_ledger.read_at — read tracking for messages
--   7. message_ledger.to_agent FK — referential integrity for recipients
-- =============================================================================

BEGIN;

-- ─── 1. Documents table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roadmap.documents (
    id              int8          GENERATED ALWAYS AS IDENTITY NOT NULL,
    proposal_id     int8          NULL,
    title           text          NOT NULL,
    content         text          NOT NULL,
    doc_type        text          DEFAULT 'spec' NOT NULL,
    author          text          NOT NULL,
    version         int4          DEFAULT 1 NOT NULL,
    created_at      timestamptz   DEFAULT now() NOT NULL,
    updated_at      timestamptz   DEFAULT now() NOT NULL,
    deleted_at      timestamptz   NULL,
    tsvector_col    tsvector      NULL,
    CONSTRAINT documents_pkey           PRIMARY KEY (id),
    CONSTRAINT documents_proposal_fkey  FOREIGN KEY (proposal_id)
        REFERENCES roadmap.proposal (id) ON DELETE SET NULL,
    CONSTRAINT documents_author_fkey    FOREIGN KEY (author)
        REFERENCES roadmap.agent_registry (agent_identity) ON DELETE RESTRICT,
    CONSTRAINT documents_doc_type_check CHECK (doc_type IN (
        'spec', 'decision', 'runbook', 'adr', 'design', 'other'
    )),
    CONSTRAINT documents_version_check  CHECK (version > 0)
);
COMMENT ON TABLE  roadmap.documents IS 'P067: Versioned, full-text searchable documents linked to proposals';
COMMENT ON COLUMN roadmap.documents.tsvector_col IS 'GIN-indexed tsvector for full-text search; maintained by trigger';

-- GIN index for full-text search
CREATE INDEX idx_documents_tsvector ON roadmap.documents
    USING gin (tsvector_col);

-- Index for proposal-linked docs
CREATE INDEX idx_documents_proposal ON roadmap.documents (proposal_id)
    WHERE proposal_id IS NOT NULL;

-- Index for soft-delete queries
CREATE INDEX idx_documents_active ON roadmap.documents (id)
    WHERE deleted_at IS NULL;

-- Trigger: auto-maintain tsvector on INSERT/UPDATE
CREATE OR REPLACE FUNCTION roadmap.fn_documents_tsvector_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.tsvector_col := to_tsvector('english', coalesce(NEW.title, '') || ' ' || coalesce(NEW.content, ''));
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_documents_tsvector
    BEFORE INSERT OR UPDATE OF title, content ON roadmap.documents
    FOR EACH ROW EXECUTE FUNCTION roadmap.fn_documents_tsvector_update();

-- Trigger: auto-maintain updated_at
CREATE TRIGGER trg_documents_updated_at
    BEFORE UPDATE ON roadmap.documents
    FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();

-- ─── 2. Document versions table ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roadmap.document_versions (
    id              int8          GENERATED ALWAYS AS IDENTITY NOT NULL,
    document_id     int8          NOT NULL,
    version         int4          NOT NULL,
    title           text          NOT NULL,
    content         text          NOT NULL,
    author          text          NOT NULL,
    created_at      timestamptz   DEFAULT now() NOT NULL,
    CONSTRAINT document_versions_pkey        PRIMARY KEY (id),
    CONSTRAINT document_versions_doc_fkey    FOREIGN KEY (document_id)
        REFERENCES roadmap.documents (id) ON DELETE CASCADE,
    CONSTRAINT document_versions_author_fkey FOREIGN KEY (author)
        REFERENCES roadmap.agent_registry (agent_identity) ON DELETE RESTRICT,
    CONSTRAINT document_versions_unique      UNIQUE (document_id, version)
);
COMMENT ON TABLE roadmap.document_versions IS 'P067: Version history for documents; each update appends a row';

CREATE INDEX idx_doc_versions_document ON roadmap.document_versions (document_id);

-- ─── 3. Channel subscriptions ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roadmap.channel_subscription (
    id              int8          GENERATED ALWAYS AS IDENTITY NOT NULL,
    agent_identity  text          NOT NULL,
    channel         text          NOT NULL,
    subscribed_at   timestamptz   DEFAULT now() NOT NULL,
    CONSTRAINT channel_subscription_pkey       PRIMARY KEY (id),
    CONSTRAINT channel_subscription_unique     UNIQUE (agent_identity, channel),
    CONSTRAINT channel_subscription_agent_fkey FOREIGN KEY (agent_identity)
        REFERENCES roadmap.agent_registry (agent_identity) ON DELETE CASCADE,
    CONSTRAINT channel_subscription_channel_check CHECK (
        channel ~ '^(direct|team:.+|broadcast|system)$'
    )
);
COMMENT ON TABLE roadmap.channel_subscription IS 'P067/P149: Agent channel subscriptions for push notification delivery';

CREATE INDEX idx_channel_sub_agent ON roadmap.channel_subscription (agent_identity);

-- ─── 4. Protocol threads ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roadmap.protocol_threads (
    id              int8          GENERATED ALWAYS AS IDENTITY NOT NULL,
    thread_id       text          NOT NULL,
    channel         text          NOT NULL,
    proposal_id     int8          NULL,
    root_message    text          NOT NULL,
    root_author     text          NOT NULL,
    reply_count     int4          DEFAULT 0 NOT NULL,
    created_at      timestamptz   DEFAULT now() NOT NULL,
    last_activity   timestamptz   DEFAULT now() NOT NULL,
    CONSTRAINT protocol_threads_pkey         PRIMARY KEY (id),
    CONSTRAINT protocol_threads_unique       UNIQUE (thread_id),
    CONSTRAINT protocol_threads_proposal_fkey FOREIGN KEY (proposal_id)
        REFERENCES roadmap.proposal (id) ON DELETE SET NULL,
    CONSTRAINT protocol_threads_author_fkey  FOREIGN KEY (root_author)
        REFERENCES roadmap.agent_registry (agent_identity) ON DELETE RESTRICT
);
COMMENT ON TABLE roadmap.protocol_threads IS 'P067: Threaded discussions with paginated replies';

CREATE INDEX idx_protocol_threads_channel   ON roadmap.protocol_threads (channel);
CREATE INDEX idx_protocol_threads_proposal  ON roadmap.protocol_threads (proposal_id)
    WHERE proposal_id IS NOT NULL;
CREATE INDEX idx_protocol_threads_activity  ON roadmap.protocol_threads (last_activity DESC);

-- ─── 5. Protocol thread replies ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roadmap.protocol_replies (
    id              int8          GENERATED ALWAYS AS IDENTITY NOT NULL,
    thread_id       text          NOT NULL,
    seq             int4          NOT NULL,
    author          text          NOT NULL,
    content         text          NOT NULL,
    created_at      timestamptz   DEFAULT now() NOT NULL,
    CONSTRAINT protocol_replies_pkey        PRIMARY KEY (id),
    CONSTRAINT protocol_replies_thread_fkey FOREIGN KEY (thread_id)
        REFERENCES roadmap.protocol_threads (thread_id) ON DELETE CASCADE,
    CONSTRAINT protocol_replies_author_fkey FOREIGN KEY (author)
        REFERENCES roadmap.agent_registry (agent_identity) ON DELETE RESTRICT,
    CONSTRAINT protocol_replies_seq_unique  UNIQUE (thread_id, seq)
);
COMMENT ON TABLE roadmap.protocol_replies IS 'P067: Thread replies with insertion-order sequence';

CREATE INDEX idx_protocol_replies_thread ON roadmap.protocol_replies (thread_id);

-- Function: increment reply_count and update last_activity on thread
CREATE OR REPLACE FUNCTION roadmap.fn_thread_reply_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE roadmap.protocol_threads
    SET reply_count = reply_count + 1,
        last_activity = now()
    WHERE thread_id = NEW.thread_id;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_protocol_replies_count
    AFTER INSERT ON roadmap.protocol_replies
    FOR EACH ROW EXECUTE FUNCTION roadmap.fn_thread_reply_update();

-- ─── 6. Mentions ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roadmap.mentions (
    id              int8          GENERATED ALWAYS AS IDENTITY NOT NULL,
    mentioned_agent text          NOT NULL,
    mentioned_by    text          NOT NULL,
    proposal_id     int8          NULL,
    thread_id       text          NULL,
    context         text          NULL,
    created_at      timestamptz   DEFAULT now() NOT NULL,
    read_at         timestamptz   NULL,
    CONSTRAINT mentions_pkey              PRIMARY KEY (id),
    CONSTRAINT mentions_agent_fkey        FOREIGN KEY (mentioned_agent)
        REFERENCES roadmap.agent_registry (agent_identity) ON DELETE CASCADE,
    CONSTRAINT mentions_by_fkey           FOREIGN KEY (mentioned_by)
        REFERENCES roadmap.agent_registry (agent_identity) ON DELETE RESTRICT,
    CONSTRAINT mentions_proposal_fkey     FOREIGN KEY (proposal_id)
        REFERENCES roadmap.proposal (id) ON DELETE SET NULL
);
COMMENT ON TABLE roadmap.mentions IS 'P067: @-mention records linking agents to proposals/threads';

CREATE INDEX idx_mentions_agent    ON roadmap.mentions (mentioned_agent);
CREATE INDEX idx_mentions_proposal ON roadmap.mentions (proposal_id)
    WHERE proposal_id IS NOT NULL;
CREATE INDEX idx_mentions_unread   ON roadmap.mentions (mentioned_agent)
    WHERE read_at IS NULL;

-- ─── 7. Add read_at to message_ledger ────────────────────────────────────────
ALTER TABLE roadmap.message_ledger
    ADD COLUMN IF NOT EXISTS read_at timestamptz NULL;

COMMENT ON COLUMN roadmap.message_ledger.read_at IS 'P067 AC-7: Timestamp when the recipient read the message';

-- Add FK for to_agent if not present (it references agent_registry)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'message_ledger_to_agent_fkey'
    ) THEN
        ALTER TABLE roadmap.message_ledger
            ADD CONSTRAINT message_ledger_to_agent_fkey
            FOREIGN KEY (to_agent) REFERENCES roadmap.agent_registry (agent_identity)
            ON DELETE RESTRICT;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_message_unread ON roadmap.message_ledger (to_agent)
    WHERE read_at IS NULL AND to_agent IS NOT NULL;

-- ─── 8. Grants for agent roles ──────────────────────────────────────────────
DO $$
BEGIN
    -- Grant to agent_write role if it exists
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_write') THEN
        GRANT INSERT, UPDATE ON TABLE
            roadmap.documents,
            roadmap.document_versions,
            roadmap.channel_subscription,
            roadmap.protocol_threads,
            roadmap.protocol_replies,
            roadmap.mentions
        TO agent_write;

        GRANT SELECT ON TABLE
            roadmap.documents,
            roadmap.document_versions,
            roadmap.channel_subscription,
            roadmap.protocol_threads,
            roadmap.protocol_replies,
            roadmap.mentions
        TO agent_write;
    END IF;
END $$;

COMMIT;
