-- Merge Gate State Audit Script (AC-9)
-- P1094: Re-run this monthly to detect silent D4 gate regression.
-- Deviation > 20% in d4_advances_30d vs prior baseline triggers a logged issue.
--
-- Baseline (2026-05-16): merge_count=0, develop_new=77, d4_advances_30d=38,
--   d3_holds_30d=48, d4_role_bindings=1, active_gate_reviewers=1

-- 1. Current gate baseline snapshot
SELECT
  (SELECT COUNT(*) FROM roadmap_proposal.proposal WHERE status = 'MERGE') AS merge_count,
  (SELECT COUNT(*) FROM roadmap_proposal.proposal WHERE status = 'DEVELOP' AND maturity = 'new') AS develop_new_count,
  (SELECT COUNT(*) FROM roadmap_proposal.gate_decision_log
     WHERE decision = 'advance' AND from_state = 'MERGE' AND to_state = 'COMPLETE'
     AND created_at > NOW() - INTERVAL '30 days') AS d4_advances_30d,
  (SELECT COUNT(*) FROM roadmap_proposal.gate_decision_log
     WHERE decision = 'hold'
     AND (gate = 'D3' OR gate_level = 'D3' OR (from_state = 'DEVELOP' AND to_state = 'MERGE'))
     AND created_at > NOW() - INTERVAL '30 days') AS d3_holds_30d,
  (SELECT COUNT(*) FROM roadmap.agent_role_profile
     WHERE workflow_template_id = 14 AND stage = 'MERGE' AND maturity = 'mature'
     AND role = 'gate-reviewer') AS d4_role_binding_count,
  (SELECT COUNT(*) FROM roadmap_workforce.agent_registry
     WHERE status = 'active' AND role = 'gate-reviewer') AS active_gate_reviewers,
  NOW() AS snapshot_at;

-- 2. D3 hold reason distribution (top 10)
SELECT
  SUBSTRING(gdl.rationale, 1, 100) AS rationale_prefix,
  COUNT(*) AS occurrences
FROM roadmap_proposal.gate_decision_log gdl
WHERE gdl.decision = 'hold'
  AND (gdl.gate = 'D3' OR gdl.gate_level = 'D3'
       OR (gdl.from_state = 'DEVELOP' AND gdl.to_state = 'MERGE'))
  AND gdl.created_at > NOW() - INTERVAL '30 days'
GROUP BY SUBSTRING(gdl.rationale, 1, 100)
ORDER BY occurrences DESC
LIMIT 10;

-- 3. D4 role profile verification
SELECT id, scope, workflow_template_id, stage, maturity, role, priority
FROM roadmap.agent_role_profile
WHERE workflow_template_id = 14 AND stage = 'MERGE'
ORDER BY priority;

-- 4. Active gate-reviewer agents
SELECT agent_identity, role, status, skills
FROM roadmap_workforce.agent_registry
WHERE status = 'active' AND role = 'gate-reviewer';

-- 5. D4 advances by week (last 8 weeks)
SELECT
  DATE_TRUNC('week', transitioned_at) AS week,
  COUNT(*) AS d4_advances
FROM roadmap_proposal.proposal_state_transitions
WHERE from_state = 'MERGE' AND to_state = 'COMPLETE'
  AND transitioned_at > NOW() - INTERVAL '56 days'
GROUP BY DATE_TRUNC('week', transitioned_at)
ORDER BY week DESC;

-- 6. Proposals stuck in MERGE (should be near zero between runs)
SELECT id, title, status, maturity, type, updated_at::date AS last_updated,
  EXTRACT(EPOCH FROM (NOW() - updated_at)) / 86400 AS days_stale
FROM roadmap_proposal.proposal
WHERE status = 'MERGE'
ORDER BY updated_at ASC
LIMIT 20;
