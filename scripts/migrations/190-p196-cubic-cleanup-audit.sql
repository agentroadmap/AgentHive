-- P196: Cubic Cleanup Audit Trail
-- Applies DDL from database/ddl/024-cubic-cleanup-audit.sql
-- Required by CubicCleanupService.writeAudit() which writes to this table.

CREATE TABLE IF NOT EXISTS roadmap.cubic_cleanup_audit (
  id bigserial PRIMARY KEY,
  cubic_id text NOT NULL,
  action text NOT NULL,
  orphan_rule integer,
  reason text,
  recovery_path text,
  worktree_path text,
  actor text,
  proposal_id bigint REFERENCES roadmap_proposal.proposal(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cubic_cleanup_audit_action_check
    CHECK (action IN ('PRESERVED', 'DELETED', 'LEASE_RELEASED', 'FORCE_REAP', 'ORPHANED')),
  CONSTRAINT cubic_cleanup_audit_orphan_rule_check
    CHECK (orphan_rule IS NULL OR orphan_rule BETWEEN 1 AND 4)
);

CREATE INDEX IF NOT EXISTS idx_cubic_cleanup_audit_cubic
  ON roadmap.cubic_cleanup_audit(cubic_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cubic_cleanup_audit_action
  ON roadmap.cubic_cleanup_audit(action, created_at DESC);
