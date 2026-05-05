-- P188: Directive Proposal Type
-- Adds 'directive' as a first-class proposal type using RFC workflow.
-- Directives are human-issued commands with elevated dispatch priority.

-- AC-1: seed directive into reference_terms (the baseline reference catalog)
INSERT INTO roadmap.reference_terms (term_category, term_value, display_name, sort_order, description)
VALUES ('proposal_type', 'directive', 'Directive', 50, 'Human-issued command with elevated priority')
ON CONFLICT (term_category, term_value) DO NOTHING;

-- AC-2: bind directive to Standard RFC workflow (same transitions as feature)
-- proposal_type_config is the authoritative type→workflow binding;
-- proposal_valid_transitions are keyed by workflow_name, so directive inherits
-- all RFC transitions automatically through the join in transitionProposal().
INSERT INTO roadmap_proposal.proposal_type_config (type, workflow_name, description)
VALUES ('directive', 'Standard RFC', 'Human-issued command with elevated dispatch priority (1.5x) and automatic conflict detection')
ON CONFLICT (type) DO UPDATE SET
  workflow_name = EXCLUDED.workflow_name,
  description   = EXCLUDED.description;
