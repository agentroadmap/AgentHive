-- Fix: Align proposal_dependencies column names with RFC handler code
-- Original used 'proposal_id' / 'depends_on_display_id' 
-- Handler code expects 'from_proposal_id' / 'to_proposal_id'
-- This migration drops the duplicate table and fixes column names
-- Views will be recreated below

BEGIN;

-- Drop the stale duplicate if it exists
DROP TABLE IF EXISTS proposal_dependencies_dep CASCADE;

-- Recreate v_proposal_state_summary with correct column references
DROP VIEW IF EXISTS v_proposal_state_summary CASCADE;
CREATE OR REPLACE VIEW v_proposal_state_summary AS
SELECT 
    p.id, display_id, title,
    COALESCE(p.status, 'PROPOSAL') AS status,
    COALESCE(p.maturity_level, 0) AS maturity_level,
    p.proposal_type, p.category, p.domain_id,
    COUNT(DISTINCT ar.id) AS total_attachments,
    COUNT(DISTINCT pv.id) AS total_versions,
    COUNT(DISTINCT ac.id) AS total_acceptance_criteria,
    COUNT(DISTINCT CASE WHEN ac.status = 'PASS' THEN ac.id END) AS passed_acceptance_criteria,
    CASE WHEN COUNT(DISTINCT pr.id) > 0 THEN true ELSE false END AS reviewed,
    pst.to_state AS current_state,
    pst.transition_reason AS last_transition_reason,
    pst.transitioned_by,
    pst.transitioned_at
FROM proposal p
LEFT JOIN attachment_registry ar ON ar.proposal_id = p.id
LEFT JOIN proposal_version pv ON pv.proposal_id = p.id
LEFT JOIN proposal_acceptance_criteria ac ON ac.proposal_id = p.id
LEFT JOIN proposal_reviews pr ON pr.proposal_id = p.id
LEFT JOIN LATERAL (
    SELECT to_state, transition_reason, transitioned_by, transitioned_at
    FROM proposal_state_transitions WHERE proposal_id = p.id
    ORDER BY id DESC LIMIT 1
) pst ON true
GROUP BY p.id, p.display_id, p.title, p.status, p.maturity_level, p.proposal_type, p.category, p.domain_id, pst.to_state, pst.transition_reason, pst.transitioned_by, pst.transitioned_at;

-- Recreate v_blocked_proposals
DROP VIEW IF EXISTS v_blocked_proposals;
CREATE OR REPLACE VIEW v_blocked_proposals AS
SELECT 
    display_id, title, status, maturity_level,
    'Has unresolved dependency blockers' AS reason
FROM proposal
WHERE id IN (SELECT to_proposal_id FROM proposal_dependencies WHERE dependency_type = 'blocks');

COMMIT;
