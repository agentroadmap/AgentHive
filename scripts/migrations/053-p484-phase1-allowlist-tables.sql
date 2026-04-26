-- P484 Phase 1: Per-Project Allowlist Tables + Dispatch Audit
-- Creates four tables for per-project resource isolation:
-- 1. project_route_allowlist: allowed routes per project
-- 2. project_capability_scope: allowed capabilities per project
-- 3. project_budget_cap: spending caps per project (day/week/month)
-- 4. dispatch_route_audit: audit trail of dispatch decisions (allow/deny)
--
-- Fail-closed dispatch: missing allowlist row = deny (never allow).
-- Atomic budget checks via SELECT...FOR UPDATE.

CREATE TABLE IF NOT EXISTS roadmap.project_route_allowlist (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES roadmap.project(project_id) ON DELETE CASCADE,
  route_name TEXT NOT NULL,
  max_calls_per_day INT,
  max_tokens_per_day BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, route_name)
);

CREATE INDEX idx_project_route_allowlist_lookup
  ON roadmap.project_route_allowlist(project_id, route_name);

CREATE TABLE IF NOT EXISTS roadmap.project_capability_scope (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES roadmap.project(project_id) ON DELETE CASCADE,
  capability_name TEXT NOT NULL,
  max_concurrency INT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, capability_name)
);

CREATE INDEX idx_project_capability_scope_lookup
  ON roadmap.project_capability_scope(project_id, capability_name);

CREATE TABLE IF NOT EXISTS roadmap.project_budget_cap (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES roadmap.project(project_id) ON DELETE CASCADE,
  period TEXT NOT NULL CHECK (period IN ('day', 'week', 'month')),
  max_usd_cents BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, period)
);

CREATE INDEX idx_project_budget_cap_lookup
  ON roadmap.project_budget_cap(project_id, period);

CREATE TABLE IF NOT EXISTS roadmap.dispatch_route_audit (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT,
  route_name TEXT,
  capability_name TEXT,
  decision TEXT CHECK (decision IN ('allow', 'deny_route', 'deny_capability', 'deny_budget', 'deny_compliance')),
  reason TEXT,
  remaining_budget_cents BIGINT,
  decided_at TIMESTAMPTZ DEFAULT NOW(),
  agency_identity TEXT,
  agent_identity TEXT
);

CREATE INDEX idx_dispatch_route_audit_project_time
  ON roadmap.dispatch_route_audit(project_id, decided_at DESC);
