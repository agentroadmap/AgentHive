# SMDL Multi-Agent Coordination — Extension Spec (P374 AC-6)

**Author:** P374 architect pass  
**Date:** 2026-05-26  
**Status:** Ready for implementation  
**Integration:** P055 (squad assembly)

---

## Motivation

SMDL v1 dispatches one agent per stage via the orchestrator. Incident response,
large-scale code review, and parallel research tasks require multiple agents working
simultaneously within a single stage. This extension adds an `agent_dispatch` block to
SMDL stage definitions, enabling the orchestrator to assemble a squad rather than a
single worker.

---

## Design

### 1. New SMDL `agent_dispatch` block per stage

```yaml
stages:
  - name: INVESTIGATING
    order: 3
    description: "Active incident investigation"
    agent_dispatch:
      mode: parallel              # parallel | sequential | quorum-first
      min_agents: 2               # stage stalls until at least 2 agents claim it
      max_agents: 4               # hard cap; orchestrator refuses > 4 leases
      roles_required:
        - role: on-call
          count: 1
          required: true          # stage cannot start without this role
        - role: tech-lead
          count: 1
          required: false         # best-effort; proceeds if unavailable
      completion_policy: any_mature     # any_mature | all_mature | quorum_mature
      quorum_count: 2             # only meaningful when completion_policy = quorum_mature
      handoff_timeout: 30m        # if an agent goes silent, reassign after 30m
```

### 2. `mode` values

| mode | semantics |
|---|---|
| `parallel` | All dispatched agents work simultaneously; results merged by orchestrator |
| `sequential` | Agents work one at a time in FIFO order; next starts when current releases |
| `quorum-first` | A quorum subset must complete before remaining agents are dispatched |

### 3. `completion_policy` values

| policy | advance condition |
|---|---|
| `any_mature` | Stage advances when the FIRST agent marks mature |
| `all_mature` | Stage advances only when ALL active agents mark mature |
| `quorum_mature` | Stage advances when `quorum_count` agents have marked mature |

### 4. DB changes

#### New table: `roadmap.stage_dispatch`

Tracks which agents are leasing a stage simultaneously. Extends the existing single-agent
lease model without breaking it (single-agent = `stage_dispatch` row with `max_agents=1`).

```sql
CREATE TABLE roadmap.stage_dispatch (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    proposal_id     BIGINT NOT NULL REFERENCES roadmap.proposal(id) ON DELETE CASCADE,
    stage           TEXT NOT NULL,
    agent_id        TEXT NOT NULL,
    role            TEXT,                        -- SMDL role this agent fills
    leased_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    released_at     TIMESTAMPTZ,
    maturity_signal BOOLEAN NOT NULL DEFAULT FALSE,  -- true = agent marked mature
    handoff_timeout INTERVAL,
    timed_out       BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (proposal_id, stage, agent_id)
);

CREATE INDEX sd_proposal_stage ON roadmap.stage_dispatch (proposal_id, stage)
    WHERE released_at IS NULL;
```

#### New view: `roadmap.stage_dispatch_summary`

```sql
CREATE VIEW roadmap.stage_dispatch_summary AS
SELECT
    proposal_id,
    stage,
    COUNT(*)                                            AS active_agents,
    COUNT(*) FILTER (WHERE maturity_signal)             AS matured_agents,
    COUNT(*) FILTER (WHERE timed_out)                   AS timed_out_agents,
    ARRAY_AGG(agent_id ORDER BY leased_at) FILTER (WHERE released_at IS NULL) AS agent_ids,
    ARRAY_AGG(role ORDER BY leased_at) FILTER (WHERE released_at IS NULL)     AS roles_filled,
    MIN(leased_at)                                      AS first_leased_at
FROM roadmap.stage_dispatch
WHERE released_at IS NULL
GROUP BY proposal_id, stage;
```

### 5. SMDL schema extension

Add to `smdl-loader.ts`:

```typescript
export interface SMDLAgentRoleRequirement {
  role: string;       // matches a name in workflow roles[]
  count: number;      // default 1
  required: boolean;  // if true, stage cannot start without this role filled
}

export interface SMDLAgentDispatch {
  mode: "parallel" | "sequential" | "quorum-first";
  min_agents?: number;            // default 1
  max_agents?: number;            // default same as min_agents
  roles_required?: SMDLAgentRoleRequirement[];
  completion_policy?: "any_mature" | "all_mature" | "quorum_mature";  // default "any_mature"
  quorum_count?: number;          // only used with quorum_mature
  handoff_timeout?: string;       // duration string, e.g. "30m", "2h"
}

// Extend existing SMDLStage:
export interface SMDLStage {
  // ... existing fields ...
  agent_dispatch?: SMDLAgentDispatch;  // ← add this field
}
```

### 6. Orchestrator integration

#### Lease acquisition

When the orchestrator's scanner picks up a `stage_dispatch`-enabled stage:

```
1. Load SMDL agent_dispatch config for the stage
2. Count active rows in stage_dispatch for (proposal_id, stage)
3. If count >= max_agents → skip (stage is full)
4. Check roles_required: for each required=true role, is it already filled?
   - If no → reserve this slot for that role's dispatch_role_filter
5. Dispatch offer to matching agent via existing offer mechanism
6. On claim: INSERT into stage_dispatch (proposal_id, stage, agent_id, role)
7. On release: UPDATE stage_dispatch SET released_at = NOW(), maturity_signal = $mature
```

#### Stage completion check (replaces current single-agent mature check)

```
1. Load stage_dispatch_summary for (proposal_id, stage)
2. Apply completion_policy:
   - any_mature:    matured_agents >= 1 → advance
   - all_mature:    matured_agents == active_agents AND active_agents >= min_agents → advance
   - quorum_mature: matured_agents >= quorum_count → advance
3. If advance: release all remaining active leases (released_at = NOW()), pg_notify
4. If handoff_timeout set: scan for agents where NOW() - leased_at > handoff_timeout AND
   NOT maturity_signal AND NOT timed_out → SET timed_out=TRUE, re-offer slot
```

### 7. MCP action changes

Extend `mcp_proposal claim` and `mcp_proposal release`:

| action | change |
|---|---|
| `claim` | Inserts into `stage_dispatch` in addition to `proposal_lease`; returns `squad_size` in response |
| `release` | Sets `stage_dispatch.released_at`; triggers completion check if `maturity_signal=true` |

New action:

| action | params | description |
|---|---|---|
| `get_squad` | proposal_id, stage | Returns `stage_dispatch_summary` for a stage |

### 8. Squad assembly integration (P055)

P055 (squad assembly) resolves which specific agents fill `roles_required`. The integration
point is the offer-creation step:

```
orchestrator scanner
  └─ identifies stage with agent_dispatch
  └─ calls P055 squad_assemble(workflow_id, stage, roles_required)
  └─ P055 returns [(agent_id, role)] pairs
  └─ orchestrator creates targeted offers per pair
  └─ agents claim offers → stage_dispatch rows inserted
```

P055 can be bypassed when `roles_required` is empty or all roles are `required: false`;
the orchestrator falls back to capability-matching (existing path).

---

## Example: Incident Response with multi-agent coordination

```yaml
workflow:
  id: incident-response
  name: Incident Response
  version: 1.0.0
  start_stage: DETECTED
  terminal_stages: [CLOSED]

  roles:
    - name: on-call
      clearance: 2
      is_default: true
    - name: incident-commander
      clearance: 5
    - name: tech-lead
      clearance: 4
    - name: comms
      clearance: 2
    - name: reviewer
      clearance: 3

  stages:
    - name: DETECTED
      order: 1
      auto_transitions:
        on_mature: TRIAGED
    - name: TRIAGED
      order: 2
      timeout: 15m
      auto_transitions:
        on_timeout: ESCALATED
        on_mature: INVESTIGATING
    - name: INVESTIGATING
      order: 3
      agent_dispatch:
        mode: parallel
        min_agents: 2
        max_agents: 4
        roles_required:
          - role: on-call
            count: 1
            required: true
          - role: tech-lead
            count: 1
            required: false
        completion_policy: quorum_mature
        quorum_count: 2
        handoff_timeout: 30m
      auto_transitions:
        on_mature: MITIGATING
    - name: MITIGATING
      order: 4
      agent_dispatch:
        mode: sequential
        min_agents: 1
        max_agents: 2
        completion_policy: any_mature
      auto_transitions:
        on_mature: RESOLVED
    - name: RESOLVED
      order: 5
      quorum:
        required_count: 2
        required_roles: [tech-lead, comms]
        veto_power: false
      auto_transitions:
        on_mature: POSTMORTEM
    - name: POSTMORTEM
      order: 6
      agent_dispatch:
        mode: sequential
        min_agents: 1
        completion_policy: all_mature
    - name: ESCALATED
      order: 90
      description: Escalated — needs human attention
    - name: CLOSED
      order: 97
      description: Incident closed

  transitions:
    - from: DETECTED
      to: TRIAGED
      labels: [detected, submit]
      allowed_roles: [any]
    - from: TRIAGED
      to: INVESTIGATING
      labels: [mature, assigned]
      allowed_roles: [incident-commander, on-call]
    - from: TRIAGED
      to: ESCALATED
      labels: [timeout, escalate]
      allowed_roles: [any]
    - from: INVESTIGATING
      to: MITIGATING
      labels: [mature, quorum_met]
      allowed_roles: [any]
    - from: MITIGATING
      to: RESOLVED
      labels: [mature, resolved]
      allowed_roles: [tech-lead, incident-commander]
    - from: RESOLVED
      to: POSTMORTEM
      labels: [mature, quorum_met]
      allowed_roles: [tech-lead, comms]
    - from: POSTMORTEM
      to: CLOSED
      labels: [mature, completed]
      allowed_roles: [incident-commander]
    - from: ESCALATED
      to: INVESTIGATING
      labels: [assigned, escalation_handled]
      allowed_roles: [incident-commander]
```

---

## Acceptance criteria for implementation

- [ ] `SMDLAgentDispatch` and `SMDLAgentRoleRequirement` types added to `smdl-loader.ts`
- [ ] `SMDLStage.agent_dispatch` field added to JSON schema
- [ ] `stage_dispatch` table and `stage_dispatch_summary` view created via migration
- [ ] `mcp_proposal claim` inserts `stage_dispatch` row when stage has `agent_dispatch` config
- [ ] `mcp_proposal release` triggers completion-policy check
- [ ] `mcp_proposal get_squad` action returns current squad state
- [ ] Orchestrator scanner respects `max_agents` cap (does not over-offer)
- [ ] Handoff timeout scanner marks timed-out rows and re-offers
- [ ] P055 squad_assemble integration point documented and stubbed
- [ ] `workflow_visualize` renders `agent_dispatch` mode and completion_policy in Mermaid note
- [ ] Full incident-response YAML example loads and materializes without errors

---

## Non-goals

- Agent-to-agent direct messaging within a stage (use A2A bus, not SMDL)
- Splitting a single AC across multiple agents (AC ownership is per-proposal, not per-agent)
- Real-time presence / heartbeat within a stage (existing heartbeat mechanism sufficient)
