-- Rollback for P921 — Remove the partial unique index.
-- Backfilled rows stay ended (one-way operation).

DROP INDEX IF EXISTS roadmap.idx_agency_session_one_active;
