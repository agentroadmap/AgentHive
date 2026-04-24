# P201: roadmap.cubics table -- SHIP REPORT

Proposal: P201
Title: roadmap.cubics table does not exist -- all cubic MCP tools fail
Status: COMPLETE
Ship Date: 2026-04-21
Verified By: hermes/agency-xiaomi/worker-8838 (documenter)

## Problem (RESOLVED)

Previously, all cubic MCP tools failed with: relation "roadmap.cubics" does not exist

This blocked:
- Orchestrator agent dispatch (needs cubics)
- Agent workspace isolation
- Multi-agent concurrent work

## Implementation

Table: roadmap.cubics (roadmap schema)

Columns:
  cubic_id       text          Primary key (gen_random_uuid)
  status         text          idle, active, expired, complete
  phase          text          Workflow phase
  agent_identity text          Currently executing agent
  worktree_path  text          Git worktree directory path
  budget_usd     numeric(10,2) Resource allocation
  lock_holder    text          Agent holding execution lock
  lock_phase     text          Phase where lock was acquired
  locked_at      timestamptz   When lock was acquired
  created_at     timestamptz   Creation time
  activated_at   timestamptz   When work began
  completed_at   timestamptz   When work finished
  metadata       jsonb         Task context and phase metadata

Indexes:
  cubics_pkey          PRIMARY KEY on cubic_id
  idx_cubics_status    btree on status
  idx_cubics_agent_active  btree on (agent_identity, status) WHERE not expired/complete
  idx_cubics_lock      btree on lock_holder WHERE IS NOT NULL

Referential Integrity:
  agent_health.current_cubic -> cubics(cubic_id) ON DELETE SET NULL
  cubic_state.cubic_id -> cubics(cubic_id) ON DELETE CASCADE

Trigger: trg_cubic_state_init (auto-creates cubic_state row on insert)

## Code Artifacts

  MCP tools:        src/apps/mcp-server/tools/cubic/ (index.ts, pg-handlers.ts)
  Cubic manager:    src/core/orchestration/cubic-manager.ts
  Architecture:     src/core/orchestration/cubic-architecture.ts
  Cleanup:          src/core/orchestration/cubic-cleanup.ts
  Idle detector:    src/core/orchestration/cubic-idle-detector.ts
  Cleaner agent:    src/core/tool-agents/cubic-cleaner.ts
  CLI:              src/commands/cubic-cli.ts
  Tests:            src/test/mcp-cubic.test.ts, src/test/proposal-090-cubic-architecture.test.ts

## AC Verification (all 7 PASS)

AC-1: Table schema with all required columns            PASS
AC-2: PK + indexes on status, agent_identity             PASS
AC-3: cubic_list returns results without error           PASS
AC-4: cubic_create inserts valid UUID row                PASS
AC-5: cubic_focus acquires lock                          PASS
AC-6: cubic_transition releases lock, transitions phase  PASS
AC-7: Orchestrator dispatch without SQL errors           PASS

## Production Metrics (2026-04-21)

  Total cubics:  6,916
  Active:        14
  Expired:       6,902
  Foreign keys:  2 (agent_health, cubic_state)
  Triggers:      1 (auto state init)

## Conclusion

P201 is SHIP-READY. Cubic orchestration infrastructure is stable, well-indexed,
and battle-tested with 6,900+ production records.
