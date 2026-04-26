-- P457: Reconcile proposal_discussions.context_prefix CHECK constraint with CONVENTIONS §4a
-- Bug: CHECK constraint only allows {arch:, team:, critical:, security:, general:, feedback:, concern:, poc:}
--      but CONVENTIONS.md §4a requires ship-verification:, gate-decision:, handoff: for MCP-tracked discussions
-- Fix: DROP old constraint, ADD new constraint with union of all canonical prefixes
-- Compatibility: Backward compatible; only allows more prefix values, does not remove any

ALTER TABLE roadmap_proposal.proposal_discussions
  DROP CONSTRAINT IF EXISTS proposal_discussions_context_check;

ALTER TABLE roadmap_proposal.proposal_discussions
  ADD CONSTRAINT proposal_discussions_context_check
    CHECK (context_prefix = ANY (ARRAY[
      'arch:'::text,
      'team:'::text,
      'critical:'::text,
      'security:'::text,
      'general:'::text,
      'feedback:'::text,
      'concern:'::text,
      'poc:'::text,
      'ship-verification:'::text,
      'gate-decision:'::text,
      'handoff:'::text
    ]));
