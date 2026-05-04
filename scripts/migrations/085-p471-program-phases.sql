-- P471: Create program_phases table and tag in-flight proposals with phase_id
-- Establishes 4-phase build order for multi-tenancy program

BEGIN;

-- Create program_phases table
CREATE TABLE IF NOT EXISTS roadmap.program_phases (
  phase_id SERIAL PRIMARY KEY,
  phase_number INT NOT NULL UNIQUE CHECK (phase_number >= 0 AND phase_number <= 3),
  name TEXT NOT NULL,
  description TEXT,
  exit_criteria TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'pending')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Grant privileges
GRANT SELECT, INSERT, UPDATE ON roadmap.program_phases TO roadmap_agent;
GRANT USAGE ON SEQUENCE roadmap.program_phases_phase_id_seq TO roadmap_agent;

-- Seed the 4 phases
INSERT INTO roadmap.program_phases (phase_number, name, description, exit_criteria, status)
VALUES
  (
    0,
    'MCP integrity',
    'Fix MCP bugs that block every other proposal. fn_spawn_workflow reliability, prop_update silent ignore, add_dependency in-memory store, context_prefix CHECK, handler argument-naming, cubic_list pagination, cubic_create slot allocation, identifier sanitization.',
    'All MCP tool calls documented, validated, persistent; scanner endpoints+workflow-states findings on src/ < threshold',
    'open'
  ),
  (
    1,
    'Foundation modules',
    'Shared TypeScript modules every other proposal builds against. paths.ts, identity.ts (multi-tenant root), endpoints.ts (MCP/daemon URLs), state-names.ts (typed workflow accessor), config resolution-order spec.',
    'All src/ files import from shared modules; hardcode-scanner rules → 0 findings for paths/endpoints/state-names',
    'open'
  ),
  (
    2,
    'Control plane and dispatch hardening',
    'Core platform structural changes. Control DB boundary, bootstrap, schema reconciliation, dispatch hardening, idempotency, fail-closed claim, concurrency ceilings, retry/terminal, provider/budget governance, host/provider/route separation, service topology, causal IDs, stop/cancel, observability, race tests, cubic worktree paths, workflow state literals, scratch folder cleanup.',
    'Control DB online, all dispatch race-tested, total hardcode scanner findings < 50',
    'open'
  ),
  (
    3,
    'Agency liaison and orchestrator readiness',
    'Layer that lets multiple agencies coexist safely. Unified auth, compatibility/migration plan, liaison spec with dormancy, subscription-aware claim policy, spawn briefing protocol, subagent stuck-detection, two-way orchestrator-liaison protocol, liaison observability surface, scan-hardcoding extraction.',
    'Orchestrator can safely dispatch to multiple agencies (Hermes + Claude + Codex) on the same host with subscription-window awareness; dispatch race-test green',
    'open'
  )
ON CONFLICT (phase_number) DO NOTHING;

-- Add phase_id column to proposal if it does not exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'roadmap_proposal'
      AND table_name = 'proposal'
      AND column_name = 'phase_id'
  ) THEN
    ALTER TABLE roadmap_proposal.proposal
    ADD COLUMN phase_id INT NULL REFERENCES roadmap.program_phases(phase_id);
  END IF;
END $$;

-- Tag Phase 0 proposals (MCP integrity): 460, 461, 470, 457, 456, 458, 459, 462
UPDATE roadmap_proposal.proposal
SET phase_id = (SELECT phase_id FROM roadmap.program_phases WHERE phase_number = 0)
WHERE id = ANY(ARRAY[460, 461, 470, 457, 456, 458, 459, 462]);

-- Tag Phase 1 proposals (Foundation modules): 448, 449, 453, 474
UPDATE roadmap_proposal.proposal
SET phase_id = (SELECT phase_id FROM roadmap.program_phases WHERE phase_number = 1)
WHERE id = ANY(ARRAY[448, 449, 453, 474]);

-- Tag Phase 2 proposals (Control plane): 430, 431, 436, 446, 432, 433, 437, 438, 439, 440, 434, 444, 441, 443, 442, 435, 445, 447, 450, 451, 452
UPDATE roadmap_proposal.proposal
SET phase_id = (SELECT phase_id FROM roadmap.program_phases WHERE phase_number = 2)
WHERE id = ANY(ARRAY[430, 431, 436, 446, 432, 433, 437, 438, 439, 440, 434, 444, 441, 443, 442, 435, 445, 447, 450, 451, 452]);

-- Tag Phase 3 proposals (Agency liaison): 464, 465, 466, 467, 468, 469, 454
UPDATE roadmap_proposal.proposal
SET phase_id = (SELECT phase_id FROM roadmap.program_phases WHERE phase_number = 3)
WHERE id = ANY(ARRAY[464, 465, 466, 467, 468, 469, 454]);

COMMIT;
