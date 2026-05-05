-- Migration 060: Program phases table + proposal phase tagging (P471)
-- Creates roadmap.program_phases with Phase 0-3 exit criteria,
-- adds phase_id to roadmap.proposal, populates phase assignments,
-- and adds advisory gate enforcement function.

BEGIN;

-- ============================================================
-- 1. program_phases table (AC#1)
-- ============================================================
CREATE TABLE IF NOT EXISTS roadmap.program_phases (
  id              INTEGER PRIMARY KEY,               -- 0,1,2,3
  name            TEXT NOT NULL UNIQUE,              -- 'phase-0', 'phase-1', ...
  title           TEXT NOT NULL,                     -- human-readable short title
  description     TEXT NOT NULL,
  proposals       TEXT[] NOT NULL DEFAULT '{}',      -- display_ids in this phase
  exit_summary    TEXT NOT NULL,                     -- plain-english exit gate
  exit_criteria   JSONB NOT NULL DEFAULT '[]',       -- machine-readable testable criteria
  is_open         BOOLEAN NOT NULL DEFAULT false,    -- phase window open for work
  opened_at       TIMESTAMPTZ,
  closed_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE roadmap.program_phases IS
  'Phased build-order plan for the AgentHive multi-tenancy program (P471). '
  'Each phase has machine-readable exit_criteria used by gate agents to enforce '
  'DRAFT→REVIEW ordering.';

-- ============================================================
-- 2. Insert Phase 0-3 (AC#1)
-- ============================================================

-- Phase 0 is retroactively open (all proposals shipped)
INSERT INTO roadmap.program_phases
  (id, name, title, description, proposals, exit_summary, exit_criteria, is_open, opened_at)
VALUES (
  0,
  'phase-0',
  'MCP Integrity',
  'Fix the bugs that make every other proposal hard to verify. Nothing else is gated here; '
  'it ships first because every subsequent proposal depends on the MCP surface being trustworthy.',
  ARRAY['P456','P457','P458','P459','P460','P461','P462','P470'],
  'Every MCP tool call documented, validated, and persistent. '
  'Scanner finds < 5 hardcoded endpoint + workflow-state violations in src/.',
  '[
    {
      "id": "phase0-scanner-endpoints",
      "description": "Hardcoded MCP endpoint findings in src/ below threshold",
      "type": "scanner",
      "rule_tag": "endpoints",
      "scope": "src/",
      "operator": "<",
      "threshold": 5
    },
    {
      "id": "phase0-scanner-workflow-states",
      "description": "Hardcoded workflow-state literal findings in src/ below threshold",
      "type": "scanner",
      "rule_tag": "workflow-states",
      "scope": "src/",
      "operator": "<",
      "threshold": 5
    },
    {
      "id": "phase0-all-proposals-complete",
      "description": "All Phase 0 proposals reach status=COMPLETE",
      "type": "proposal_status",
      "proposals": ["P456","P457","P458","P459","P460","P461","P462","P470"],
      "required_status": "COMPLETE"
    }
  ]'::jsonb,
  true,
  now()
)
ON CONFLICT (id) DO UPDATE SET
  title          = EXCLUDED.title,
  description    = EXCLUDED.description,
  proposals      = EXCLUDED.proposals,
  exit_summary   = EXCLUDED.exit_summary,
  exit_criteria  = EXCLUDED.exit_criteria,
  is_open        = EXCLUDED.is_open,
  opened_at      = COALESCE(roadmap.program_phases.opened_at, EXCLUDED.opened_at),
  modified_at    = now();

INSERT INTO roadmap.program_phases
  (id, name, title, description, proposals, exit_summary, exit_criteria, is_open)
VALUES (
  1,
  'phase-1',
  'Foundation Modules',
  'The shared TypeScript modules every other proposal builds against. '
  'These cannot ship in parallel with proposals that depend on them.',
  ARRAY['P416','P448','P449','P453'],
  'Every other src/ file imports from foundation modules. '
  'Hardcode-scanner rules for paths, identity, endpoints, and state-names drop to 0 findings.',
  '[
    {
      "id": "phase1-scanner-paths",
      "description": "Hardcoded path findings in src/ = 0",
      "type": "scanner",
      "rule_tag": "paths",
      "scope": "src/",
      "operator": "=",
      "threshold": 0
    },
    {
      "id": "phase1-scanner-identity",
      "description": "Hardcoded identity/host findings in src/ = 0",
      "type": "scanner",
      "rule_tag": "identity",
      "scope": "src/",
      "operator": "=",
      "threshold": 0
    },
    {
      "id": "phase1-scanner-endpoints",
      "description": "Hardcoded endpoint findings in src/ = 0",
      "type": "scanner",
      "rule_tag": "endpoints",
      "scope": "src/",
      "operator": "=",
      "threshold": 0
    },
    {
      "id": "phase1-scanner-workflow-states",
      "description": "Hardcoded workflow-state literal findings in src/ = 0",
      "type": "scanner",
      "rule_tag": "workflow-states",
      "scope": "src/",
      "operator": "=",
      "threshold": 0
    },
    {
      "id": "phase1-all-proposals-complete",
      "description": "All Phase 1 proposals reach status=COMPLETE",
      "type": "proposal_status",
      "proposals": ["P416","P448","P449","P453"],
      "required_status": "COMPLETE"
    }
  ]'::jsonb,
  true
)
ON CONFLICT (id) DO UPDATE SET
  title         = EXCLUDED.title,
  description   = EXCLUDED.description,
  proposals     = EXCLUDED.proposals,
  exit_summary  = EXCLUDED.exit_summary,
  exit_criteria = EXCLUDED.exit_criteria,
  is_open       = EXCLUDED.is_open,
  modified_at   = now();

INSERT INTO roadmap.program_phases
  (id, name, title, description, proposals, exit_summary, exit_criteria, is_open)
VALUES (
  2,
  'phase-2',
  'Control Plane & Dispatch Hardening',
  'Core platform structural changes: control DB online, dispatch hardened, scanner clean.',
  ARRAY[
    'P429',
    'P430','P431','P432','P433','P434','P435','P436','P437','P438','P439','P440',
    'P441','P442','P443','P444','P445','P446','P447','P450','P451','P452',
    'P495','P496','P497','P498','P499','P500','P501','P502','P503',
    'P504','P505','P506','P507','P508','P509','P518','P520',
    'P471'
  ],
  'Control DB online, all dispatch race-tested, hardcode scanner total findings across src/ < 50.',
  '[
    {
      "id": "phase2-scanner-total",
      "description": "Total hardcode scanner findings across all rules in src/ < 50",
      "type": "scanner",
      "rule_tag": null,
      "scope": "src/",
      "operator": "<",
      "threshold": 50
    },
    {
      "id": "phase2-race-tests-green",
      "description": "P445 dispatch race integration test suite passes",
      "type": "test_suite",
      "suite": "tests/integration/dispatch-race",
      "required_result": "green"
    },
    {
      "id": "phase2-control-db-online",
      "description": "hiveControl database reachable and schema applied",
      "type": "db_health",
      "db": "hiveControl",
      "check": "schema_applied"
    }
  ]'::jsonb,
  true
)
ON CONFLICT (id) DO UPDATE SET
  title         = EXCLUDED.title,
  description   = EXCLUDED.description,
  proposals     = EXCLUDED.proposals,
  exit_summary  = EXCLUDED.exit_summary,
  exit_criteria = EXCLUDED.exit_criteria,
  is_open       = EXCLUDED.is_open,
  modified_at   = now();

INSERT INTO roadmap.program_phases
  (id, name, title, description, proposals, exit_summary, exit_criteria, is_open)
VALUES (
  3,
  'phase-3',
  'Agency Liaison & Orchestrator Readiness',
  'The layer that lets multiple agencies coexist safely on the same host.',
  ARRAY['P454','P463','P464','P465','P466','P467','P468','P469','P472','P473','P474','P475','P476'],
  'Orchestrator can safely dispatch to multiple agencies (Hermes + Claude + Codex) '
  'with subscription-window awareness. All liaison race-test scenarios green.',
  '[
    {
      "id": "phase3-liaison-race-tests",
      "description": "Orchestrator multi-agency dispatch race-test green (P445/P468)",
      "type": "test_suite",
      "suite": "tests/integration/liaison-dispatch",
      "required_result": "green"
    },
    {
      "id": "phase3-multi-agency-dispatch",
      "description": "Orchestrator dispatches successfully to >= 2 agency providers in CI",
      "type": "integration_check",
      "check": "multi_agency_dispatch",
      "min_agencies": 2
    }
  ]'::jsonb,
  false
)
ON CONFLICT (id) DO UPDATE SET
  title         = EXCLUDED.title,
  description   = EXCLUDED.description,
  proposals     = EXCLUDED.proposals,
  exit_summary  = EXCLUDED.exit_summary,
  exit_criteria = EXCLUDED.exit_criteria,
  modified_at   = now();

-- ============================================================
-- 3. Add phase_id to the base table roadmap_proposal.proposal (AC#2)
--    roadmap.proposal is a view over it; we alter the base table and
--    rebuild the view to expose phase_id.
-- ============================================================
ALTER TABLE roadmap_proposal.proposal
  ADD COLUMN IF NOT EXISTS phase_id INTEGER REFERENCES roadmap.program_phases(id);

COMMENT ON COLUMN roadmap_proposal.proposal.phase_id IS
  'Which program phase owns this proposal (0-3). NULL = outside the multi-tenancy program. '
  'Set by migration 060-program-phases-p471.sql; maintained by agents going forward.';

CREATE INDEX IF NOT EXISTS idx_proposal_phase_id
  ON roadmap_proposal.proposal(phase_id);

-- Rebuild the roadmap.proposal view to expose phase_id
CREATE OR REPLACE VIEW roadmap.proposal AS
  SELECT
    id,
    display_id,
    parent_id,
    type,
    status,
    title,
    summary,
    motivation,
    design,
    drawbacks,
    alternatives,
    dependency_note AS dependency,
    priority,
    maturity,
    workflow_name,
    status_term_category,
    maturity_term_category,
    body_vector,
    tags,
    audit,
    created_at,
    modified_at,
    phase_id
  FROM roadmap_proposal.proposal;

-- ============================================================
-- 4. Tag proposals with their phase (AC#2)
-- ============================================================

-- Phase 0: MCP integrity
UPDATE roadmap_proposal.proposal SET phase_id = 0
WHERE display_id = ANY(ARRAY['P456','P457','P458','P459','P460','P461','P462','P470'])
  AND phase_id IS DISTINCT FROM 0;

-- Phase 1: Foundation modules
UPDATE roadmap_proposal.proposal SET phase_id = 1
WHERE display_id = ANY(ARRAY['P416','P448','P449','P453'])
  AND phase_id IS DISTINCT FROM 1;

-- Phase 2: Control plane + dispatch hardening + P429 family
UPDATE roadmap_proposal.proposal SET phase_id = 2
WHERE display_id = ANY(ARRAY[
  'P429',
  'P430','P431','P432','P433','P434','P435','P436','P437','P438','P439','P440',
  'P441','P442','P443','P444','P445','P446','P447','P450','P451','P452',
  'P495','P496','P497','P498','P499','P500','P501','P502','P503',
  'P504','P505','P506','P507','P508','P509','P518','P520',
  'P471'
])
  AND phase_id IS DISTINCT FROM 2;

-- Phase 3: Agency liaison + orchestrator readiness
UPDATE roadmap_proposal.proposal SET phase_id = 3
WHERE display_id = ANY(ARRAY[
  'P454','P463','P464','P465','P466','P467','P468','P469',
  'P472','P473','P474','P475','P476'
])
  AND phase_id IS DISTINCT FROM 3;

-- ============================================================
-- 5. Advisory gate-check function (AC#3, AC#4)
-- Returns TRUE if safe to advance, FALSE + NOTICE if blocked.
-- ============================================================
CREATE OR REPLACE FUNCTION roadmap.fn_check_phase_gate(
  p_proposal_id  BIGINT,
  p_target_status TEXT DEFAULT 'REVIEW'
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_phase_id       INTEGER;
  v_phase_name     TEXT;
  v_prev_phase_id  INTEGER;
  v_prev_open      BOOLEAN;
  v_prev_name      TEXT;
  v_incomplete_ct  BIGINT;
BEGIN
  -- Only advisory for DRAFT→REVIEW transitions
  IF p_target_status <> 'REVIEW' THEN
    RETURN TRUE;
  END IF;

  -- Get the proposal's assigned phase (read from base table for accuracy)
  SELECT phase_id INTO v_phase_id
  FROM roadmap_proposal.proposal
  WHERE id = p_proposal_id;

  -- No phase assigned → no gate applies
  IF v_phase_id IS NULL OR v_phase_id = 0 THEN
    RETURN TRUE;
  END IF;

  v_prev_phase_id := v_phase_id - 1;

  -- Check that the predecessor phase is open (i.e. in progress or complete)
  SELECT name, is_open
  INTO v_prev_name, v_prev_open
  FROM roadmap.program_phases
  WHERE id = v_prev_phase_id;

  IF NOT FOUND OR NOT v_prev_open THEN
    RAISE NOTICE
      '[ADVISORY] Phase % (%) is not yet open. '
      'Proposal % cannot advance to REVIEW until its predecessor phase is open. '
      'Override is allowed but must be recorded in proposal audit column.',
      v_prev_phase_id, v_prev_name, p_proposal_id;
    RETURN FALSE;
  END IF;

  -- Check that all Phase N-1 proposals are COMPLETE
  SELECT count(*) INTO v_incomplete_ct
  FROM roadmap_proposal.proposal p
  JOIN roadmap.program_phases ph ON p.phase_id = ph.id
  WHERE ph.id = v_prev_phase_id
    AND p.status NOT IN ('COMPLETE','DEPLOYED');

  IF v_incomplete_ct > 0 THEN
    RAISE NOTICE
      '[ADVISORY] Phase % has % incomplete proposal(s). '
      'Proposal % should wait for Phase % to exit before advancing to REVIEW.',
      v_prev_phase_id, v_incomplete_ct, p_proposal_id, v_prev_phase_id;
    RETURN FALSE;
  END IF;

  RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION roadmap.fn_check_phase_gate IS
  'Advisory gate for DRAFT→REVIEW transitions. Returns FALSE (with NOTICE) when '
  'the predecessor program phase is not open or has incomplete proposals. '
  'Non-blocking until Phase 2 lands; operators may override with audit record.';

-- ============================================================
-- 6. View: phase progress operator dashboard (AC#3)
-- ============================================================
CREATE OR REPLACE VIEW roadmap.v_phase_progress AS
SELECT
  ph.id                                         AS phase_id,
  ph.name,
  ph.title,
  ph.is_open,
  count(p.id)                                   AS total_proposals,
  count(p.id) FILTER (WHERE p.status = 'COMPLETE' OR p.status = 'DEPLOYED')
                                                AS complete_proposals,
  round(
    100.0 * count(p.id) FILTER (WHERE p.status = 'COMPLETE' OR p.status = 'DEPLOYED')
    / NULLIF(count(p.id), 0),
    1
  )                                             AS pct_complete,
  count(p.id) FILTER (WHERE p.status NOT IN ('COMPLETE','DEPLOYED'))
                                                AS blocking_proposals,
  array_agg(p.display_id ORDER BY p.display_id)
    FILTER (WHERE p.status NOT IN ('COMPLETE','DEPLOYED'))
                                                AS blocking_display_ids,
  ph.exit_summary
FROM roadmap.program_phases ph
LEFT JOIN roadmap_proposal.proposal p ON p.phase_id = ph.id
GROUP BY ph.id, ph.name, ph.title, ph.is_open, ph.exit_summary
ORDER BY ph.id;

COMMENT ON VIEW roadmap.v_phase_progress IS
  'Operator dashboard: phase completion % and blocking proposals per phase.';

-- ============================================================
-- 7. Record migration
-- ============================================================
INSERT INTO roadmap.migration_history
  (filename, checksum_sha256, applied_by, environment, status)
VALUES (
  '060-program-phases-p471.sql',
  'p471-phased-build-order-program-phases',
  'P471-developer',
  'development',
  'applied'
)
ON CONFLICT (filename) DO NOTHING;

COMMIT;
