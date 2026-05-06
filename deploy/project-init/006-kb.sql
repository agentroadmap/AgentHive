-- ============================================================
-- project-init/006-kb.sql
-- Knowledge base: kb_document, kb_embedding, kb_tag.
-- Run with: psql -v schema_name=agentHive -f 006-kb.sql
-- Requires: pgvector extension for kb_embedding.vector column.
-- ============================================================

\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- kb_document — knowledge base documents
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.kb_document (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug             TEXT         NOT NULL UNIQUE,
  title            TEXT         NOT NULL,
  source_type      TEXT         NOT NULL DEFAULT 'manual'
                               CHECK (source_type IN ('manual','proposal','commit','url','import')),
  source_ref       TEXT,                                  -- proposal display_id, git sha, URL, etc.
  content_text     TEXT         NOT NULL,
  chunk_index      INT          NOT NULL DEFAULT 0,       -- for multi-chunk documents
  metadata_jsonb   JSONB        NOT NULL DEFAULT '{}',
  lifecycle_status TEXT         NOT NULL DEFAULT 'active'
                               CHECK (lifecycle_status IN ('active','deprecated','retired','blocked')),
  deprecated_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kbdoc_source ON :schema_name.kb_document (source_type, source_ref);
CREATE INDEX IF NOT EXISTS kbdoc_active ON :schema_name.kb_document (slug)
  WHERE lifecycle_status = 'active';

CREATE OR REPLACE TRIGGER set_updated_at_kbdocument
  BEFORE UPDATE ON :schema_name.kb_document
  FOR EACH ROW EXECUTE FUNCTION :schema_name.set_updated_at();

COMMENT ON TABLE :schema_name.kb_document IS
  'Knowledge base documents. One row per chunk for large documents (chunk_index tracks order).';

-- ============================================================
-- kb_embedding — vector embeddings for semantic search
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.kb_embedding (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id      BIGINT       NOT NULL REFERENCES :schema_name.kb_document (id) ON DELETE CASCADE,
  model_id         TEXT         NOT NULL,                 -- embedding model used, e.g. 'text-embedding-3-small'
  vector           vector(1536),                          -- default OpenAI dimension; adjust for other models
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (document_id, model_id)
);

-- IVFFlat index for approximate nearest-neighbor search (create after data load for efficiency)
-- CREATE INDEX kbembedding_ivfflat ON :schema_name.kb_embedding USING ivfflat (vector vector_cosine_ops) WITH (lists = 100);

COMMENT ON TABLE :schema_name.kb_embedding IS
  'Vector embeddings for semantic search over kb_document. One row per (document, model) pair. '
  'IVFFlat index commented out — create it after initial data load for best build time.';

-- ============================================================
-- kb_tag — document tag index
-- ============================================================
CREATE TABLE IF NOT EXISTS :schema_name.kb_tag (
  document_id      BIGINT       NOT NULL REFERENCES :schema_name.kb_document (id) ON DELETE CASCADE,
  tag              TEXT         NOT NULL,
  PRIMARY KEY (document_id, tag)
);

CREATE INDEX IF NOT EXISTS kbtag_tag ON :schema_name.kb_tag (tag);

COMMENT ON TABLE :schema_name.kb_tag IS
  'Knowledge base document tag index for category-based filtering.';
