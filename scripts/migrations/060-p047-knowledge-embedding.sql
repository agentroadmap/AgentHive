-- Migration 060: P047 — add embedding column to knowledge_entries
--
-- Enables cosine-similarity vector search (AC#9) by storing 1536-dim
-- OpenAI-compatible embeddings alongside each knowledge entry.
-- Falls back to ILIKE text search when no embedding is supplied.

BEGIN;

ALTER TABLE roadmap.knowledge_entries
  ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- IVFFlat index for ANN cosine search; lists=50 suits tables up to ~50K rows
CREATE INDEX IF NOT EXISTS idx_ke_embedding_cos
  ON roadmap.knowledge_entries
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50);

COMMIT;
