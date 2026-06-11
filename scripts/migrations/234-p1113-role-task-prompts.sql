/**
 * P1113 Migration: Seed agent_role_profile rows with task_prompt templates
 *
 * AC-14: Seed agent_role_profile rows for 5 non-gate roles with task_prompt fields:
 *   - enrichment_agent (DRAFT, REVIEW, DEVELOP stages)
 *   - developer (DEVELOP)
 *   - architect (DRAFT, REVIEW)
 *   - researcher (DRAFT)
 *   - skeptic (REVIEW, DEVELOP)
 *
 * Each prompt_template includes:
 *   - In-scope checklist
 *   - Explicit out-of-scope section
 *   - Template variables: {display_id}, {proposal_id}, {status}, {stage}
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING for idempotency.
 * AC-16: No DDL ALTER TABLE statements (data-only migration).
 */

-- Standard RFC workflow (id 14) and Hotfix workflow (id 37) are used
-- Get the workflow_template_id for Standard RFC
-- We'll use workflow_template_id=14 (Standard RFC) as the primary

INSERT INTO roadmap.agent_role_profile (
  scope,
  workflow_template_id,
  stage,
  maturity,
  role,
  required_capabilities,
  prompt_template,
  priority,
  created_at,
  updated_at
) VALUES
-- Enrichment agent (DRAFT stage)
(
  'global',
  14,  -- Standard RFC
  'DRAFT',
  'new',
  'enrichment_agent',
  ARRAY[]::text[],
  jsonb_build_object(
    'task_prompt',
    E'# {display_id} Enrichment Task\n\n' ||
    E'## In-Scope (Must Complete)\n' ||
    E'- Research and validate proposal assumptions\n' ||
    E'- Identify missing context or evidence\n' ||
    E'- Add citations to authoritative sources\n' ||
    E'- Fill gaps in design or acceptance criteria\n' ||
    E'- Ensure coherence with existing architecture\n\n' ||
    E'## Out-of-Scope (Do Not Do)\n' ||
    E'- Do not reject the proposal\n' ||
    E'- Do not implement code changes\n' ||
    E'- Do not gate-review the design\n' ||
    E'- Do not change the proposal status\n\n' ||
    E'**Proposal:** {display_id} (ID {proposal_id})\n' ||
    E'**Current Status:** {status}\n' ||
    E'**Stage:** {stage}',
    'mode', 'enrich',
    'system', 'You enrich RFC drafts with supporting context and references.'
  ),
  10,
  NOW(),
  NOW()
),
-- Enrichment agent (REVIEW stage)
(
  'global',
  14,
  'REVIEW',
  'new',
  'enrichment_agent',
  ARRAY[]::text[],
  jsonb_build_object(
    'task_prompt',
    E'# {display_id} REVIEW Enrichment\n\n' ||
    E'## In-Scope (Must Complete)\n' ||
    E'- Address reviewer comments and blockers\n' ||
    E'- Add evidence for disputed claims\n' ||
    E'- Clarify acceptance criteria\n' ||
    E'- Document architectural constraints\n\n' ||
    E'## Out-of-Scope (Do Not Do)\n' ||
    E'- Do not reject feedback from skeptics\n' ||
    E'- Do not advance to next stage\n' ||
    E'- Do not implement code\n\n' ||
    E'**Proposal:** {display_id} (ID {proposal_id})\n' ||
    E'**Current Status:** {status}\n' ||
    E'**Stage:** {stage}',
    'mode', 'enrich_review',
    'system', 'You enrich RFC proposals in REVIEW stage with evidence and clarification.'
  ),
  10,
  NOW(),
  NOW()
),
-- Enrichment agent (DEVELOP stage)
(
  'global',
  14,
  'DEVELOP',
  'new',
  'enrichment_agent',
  ARRAY[]::text[],
  jsonb_build_object(
    'task_prompt',
    E'# {display_id} DEVELOP Enrichment\n\n' ||
    E'## In-Scope (Must Complete)\n' ||
    E'- Document implementation decisions\n' ||
    E'- Track progress on acceptance criteria\n' ||
    E'- Identify blockers and dependencies\n' ||
    E'- Add post-implementation notes\n\n' ||
    E'## Out-of-Scope (Do Not Do)\n' ||
    E'- Do not implement code directly\n' ||
    E'- Do not gate the proposal\n' ||
    E'- Do not change proposal structure\n\n' ||
    E'**Proposal:** {display_id} (ID {proposal_id})\n' ||
    E'**Current Status:** {status}\n' ||
    E'**Stage:** {stage}',
    'mode', 'enrich_develop',
    'system', 'You enrich DEVELOP proposals with implementation notes and status updates.'
  ),
  10,
  NOW(),
  NOW()
),
-- Developer (DEVELOP stage)
(
  'global',
  14,
  'DEVELOP',
  'new',
  'developer',
  ARRAY[]::text[],
  jsonb_build_object(
    'task_prompt',
    E'# {display_id} Development Task\n\n' ||
    E'## In-Scope (Must Complete)\n' ||
    E'- Implement code against acceptance criteria\n' ||
    E'- Write tests for new functionality\n' ||
    E'- Ensure backward compatibility\n' ||
    E'- Document any new APIs or interfaces\n' ||
    E'- Verify acceptance criteria pass\n\n' ||
    E'## Out-of-Scope (Do Not Do)\n' ||
    E'- Do not change proposal design\n' ||
    E'- Do not gate or review the implementation\n' ||
    E'- Do not merge to main without approval\n\n' ||
    E'**Proposal:** {display_id} (ID {proposal_id})\n' ||
    E'**Current Status:** {status}\n' ||
    E'**Stage:** {stage}',
    'mode', 'develop',
    'system', 'You implement new RFC proposals as working code.'
  ),
  10,
  NOW(),
  NOW()
),
-- Architect (DRAFT stage)
(
  'global',
  14,
  'DRAFT',
  'new',
  'architect',
  ARRAY[]::text[],
  jsonb_build_object(
    'task_prompt',
    E'# {display_id} Architecture Design\n\n' ||
    E'## In-Scope (Must Complete)\n' ||
    E'- Design the system architecture\n' ||
    E'- Document design decisions\n' ||
    E'- Identify dependencies and constraints\n' ||
    E'- Create acceptance criteria\n' ||
    E'- Consider edge cases and scalability\n\n' ||
    E'## Out-of-Scope (Do Not Do)\n' ||
    E'- Do not implement code\n' ||
    E'- Do not reject the proposal concept\n' ||
    E'- Do not gate-review without all criteria\n\n' ||
    E'**Proposal:** {display_id} (ID {proposal_id})\n' ||
    E'**Current Status:** {status}\n' ||
    E'**Stage:** {stage}',
    'mode', 'architect_draft',
    'system', 'You architect RFC designs with comprehensive technical planning.'
  ),
  10,
  NOW(),
  NOW()
),
-- Architect (REVIEW stage)
(
  'global',
  14,
  'REVIEW',
  'new',
  'architect',
  ARRAY[]::text[],
  jsonb_build_object(
    'task_prompt',
    E'# {display_id} Architecture Review\n\n' ||
    E'## In-Scope (Must Complete)\n' ||
    E'- Review design coherence\n' ||
    E'- Verify acceptance criteria are testable\n' ||
    E'- Check for architectural conflicts\n' ||
    E'- Ensure scalability and maintainability\n' ||
    E'- Recommend improvements if needed\n\n' ||
    E'## Out-of-Scope (Do Not Do)\n' ||
    E'- Do not implement the design\n' ||
    E'- Do not make gate decisions\n' ||
    E'- Do not rewrite existing requirements\n\n' ||
    E'**Proposal:** {display_id} (ID {proposal_id})\n' ||
    E'**Current Status:** {status}\n' ||
    E'**Stage:** {stage}',
    'mode', 'architect_review',
    'system', 'You review and validate architectural proposals.'
  ),
  10,
  NOW(),
  NOW()
),
-- Researcher (DRAFT stage)
(
  'global',
  14,
  'DRAFT',
  'new',
  'researcher',
  ARRAY[]::text[],
  jsonb_build_object(
    'task_prompt',
    E'# {display_id} Research Task\n\n' ||
    E'## In-Scope (Must Complete)\n' ||
    E'- Research existing solutions and precedents\n' ||
    E'- Gather competitive analysis\n' ||
    E'- Document risks and mitigations\n' ||
    E'- Identify technical debt or dependencies\n' ||
    E'- Provide evidence-based recommendations\n\n' ||
    E'## Out-of-Scope (Do Not Do)\n' ||
    E'- Do not make architectural decisions\n' ||
    E'- Do not implement solutions\n' ||
    E'- Do not gate the proposal\n\n' ||
    E'**Proposal:** {display_id} (ID {proposal_id})\n' ||
    E'**Current Status:** {status}\n' ||
    E'**Stage:** {stage}',
    'mode', 'research',
    'system', 'You conduct thorough research to inform RFC proposals.'
  ),
  10,
  NOW(),
  NOW()
),
-- Skeptic (REVIEW stage)
(
  'global',
  14,
  'REVIEW',
  'new',
  'skeptic',
  ARRAY[]::text[],
  jsonb_build_object(
    'task_prompt',
    E'# {display_id} Skeptic Review (REVIEW Stage)\n\n' ||
    E'## In-Scope (Must Complete)\n' ||
    E'- Challenge assumptions and design flaws\n' ||
    E'- Identify missing edge cases\n' ||
    E'- Verify acceptance criteria are realistic\n' ||
    E'- Assess risk and dependencies\n' ||
    E'- Raise blockers if design is unsound\n\n' ||
    E'## Out-of-Scope (Do Not Do)\n' ||
    E'- Do not implement solutions\n' ||
    E'- Do not make gate decisions unilaterally\n' ||
    E'- Do not reject without evidence\n\n' ||
    E'**Proposal:** {display_id} (ID {proposal_id})\n' ||
    E'**Current Status:** {status}\n' ||
    E'**Stage:** {stage}',
    'mode', 'skeptic_review',
    'system', 'You skeptically challenge RFC proposals to identify flaws and risks.'
  ),
  10,
  NOW(),
  NOW()
),
-- Skeptic (DEVELOP stage)
(
  'global',
  14,
  'DEVELOP',
  'new',
  'skeptic',
  ARRAY[]::text[],
  jsonb_build_object(
    'task_prompt',
    E'# {display_id} Skeptic Review (DEVELOP Stage)\n\n' ||
    E'## In-Scope (Must Complete)\n' ||
    E'- Review implementation against design\n' ||
    E'- Verify all acceptance criteria are met\n' ||
    E'- Identify gaps or deviations from plan\n' ||
    E'- Assess test coverage and quality\n' ||
    E'- Flag any new risks introduced\n\n' ||
    E'## Out-of-Scope (Do Not Do)\n' ||
    E'- Do not implement code changes\n' ||
    E'- Do not make gate decisions\n' ||
    E'- Do not demand design changes\n\n' ||
    E'**Proposal:** {display_id} (ID {proposal_id})\n' ||
    E'**Current Status:** {status}\n' ||
    E'**Stage:** {stage}',
    'mode', 'skeptic_develop',
    'system', 'You skeptically review implementations for completeness and quality.'
  ),
  10,
  NOW(),
  NOW()
)
-- Conflict target = uq_agent_role_profile_global (partial unique index).
-- Existing rows keep their curated prompt_template; only NULL prompts are
-- filled from the seed. New (stage, maturity, role) combos insert fresh.
ON CONFLICT (workflow_template_id, stage, maturity, role)
  WHERE scope = 'global' AND project_id IS NULL
  DO UPDATE SET
    prompt_template = COALESCE(roadmap.agent_role_profile.prompt_template, EXCLUDED.prompt_template),
    updated_at = now();
