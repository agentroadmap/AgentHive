# State Machine Definition Language (SMDL)

## Context

GQ77 directive (2026-04-04 19:48): "Define a state machine standard definition language that can be used to define different state machines."

This is a **domain-specific language (DSL)** for defining configurable workflows. Works for RFC pipelines, incident response, code review, hiring flows — any multi-stage process.

---

## Design Goals

1. **Readable** — YAML format, human-editable by non-engineers
2. **Expressive** — supports guards, actions, roles, timeouts, sub-states
3. **Portable** — stored in DB or YAML file, loaded at runtime
4. **Validated** — schema validation on load, rejects invalid definitions
5. **Composable** — templates + overrides, inheritance, presets

---

## SMDL Specification (v1)

### Root Structure

```yaml
workflow:
  id: string                    # unique identifier (e.g., 'rfc-5')
  name: string                  # display name
  description: string           # human-readable purpose
  version: string               # semver (e.g., '1.0.0')
  
  # Lifecycle config
  start_stage: string           # entry point
  terminal_stages: string[]     # stages that end the workflow
  default_maturity_gate: int    # maturity level to advance (default: 2)
  
  # Roles available in this workflow
  roles: RoleDefinition[]
  
  # Stage definitions
  stages: StageDefinition[]
  
  # Transition rules
  transitions: TransitionRule[]
  
  # Optional: gating configuration
  gating: GatingConfig
```

### Role Definition

```yaml
roles:
  - name: string                # e.g., 'PM', 'Architect', 'any'
    description: string
    clearance: int              # 1-10, higher = more authority
    is_default: boolean         # fallback for unassigned roles
```

### Stage Definition

```yaml
stages:
  - name: string                # unique within workflow
    order: int                  # pipeline position (1, 2, 3...)
    description: string
    maturity_gate: int          # override default_maturity_gate
    requires_ac: boolean        # must all AC be met before advancing?
    quorum: QuorumRule          # optional: require N approvals
    timeout: string             # optional: auto-advance after '24h'
    auto_transitions:           # optional: automatic transitions
      on_mature: string         # advance to this stage when mature
      on_timeout: string        # advance to this stage when timeout hits
```

### Quorum Rule

```yaml
quorum:
  required_count: int           # e.g., 2 (needs 2 approvals)
  required_roles: string[]      # e.g., ['PM', 'Architect']
  veto_power: boolean           # if true, one veto blocks advancement
```

### Transition Rule

```yaml
transitions:
  - from: string                # source stage name
    to: string                  # target stage name
    labels: string[]            # reason codes: ['mature', 'decision', 'iterate']
    allowed_roles: string[]     # who can trigger: ['any'] or ['PM', 'Architect']
    requires_ac: boolean        # gates on acceptance criteria
    gating: GatingRule          # additional conditions
    
gating:
  type: string                  # 'none', 'quorum', 'timeout', 'custom'
  quorum_count: int             # for 'quorum' type
  min_approvals: int
  required_verdict: string      # 'approve', 'no_vetos'
```

---

## Examples

### Example 1: RFC-5 (Current Pipeline)

```yaml
workflow:
  id: 'rfc-5'
  name: 'Standard RFC'
  description: '5-stage RFC pipeline for product development'
  version: '1.0.0'
  
  start_stage: 'DRAFT'
  terminal_stages: ['COMPLETE']
  default_maturity_gate: 2
  
  roles:
    - name: 'any'
      description: 'Any agent'
      clearance: 1
      is_default: true
    - name: 'PM'
      description: 'Product Manager'
      clearance: 3
    - name: 'Architect'
      description: 'Technical design authority'
      clearance: 4
    - name: 'Skeptic'
      description: 'QA & adversarial review'
      clearance: 2

  stages:
    - name: 'DRAFT'
      order: 1
      description: 'AI research and enhancement'
      auto_transitions:
        on_mature: 'REVIEW'
    
    - name: 'REVIEW'
      order: 2
      description: 'Formal review, define acceptance criteria'
      requires_ac: true
      quorum:
        required_count: 2
        required_roles: ['PM', 'Architect']
        veto_power: true
      auto_transitions:
        on_mature: 'DEVELOP'
    
    - name: 'DEVELOP'
      order: 3
      description: 'Design, build, test'
      requires_ac: true
      auto_transitions:
        on_mature: 'MERGE'
    
    - name: 'MERGE'
      order: 4
      description: 'Code review, regression, E2E testing'
      requires_ac: true
      auto_transitions:
        on_mature: 'COMPLETE'
    
    - name: 'COMPLETE'
      order: 5
      description: 'Released and dependencies resolved'

  transitions:
    # Core advancement (mature = advance to next stage)
    - from: 'DRAFT'
      to: 'REVIEW'
      labels: ['mature', 'submit']
      allowed_roles: ['any']
      
    - from: 'REVIEW'
      to: 'DEVELOP'
      labels: ['mature', 'decision']
      allowed_roles: ['PM', 'Architect']
      requires_ac: true
      
    - from: 'DEVELOP'
      to: 'MERGE'
      labels: ['mature', 'decision']
      allowed_roles: ['PM', 'Architect']
      requires_ac: true
      
    - from: 'MERGE'
      to: 'COMPLETE'
      labels: ['mature', 'decision']
      allowed_roles: ['PM', 'Architect']
      requires_ac: true
      
    # Iteration (go back one stage)
    - from: 'REVIEW'
      to: 'DRAFT'
      labels: ['iterate', 'revision']
      allowed_roles: ['PM', 'Architect']
      
    - from: 'DEVELOP'
      to: 'REVIEW'
      labels: ['iterate', 'revision']
      allowed_roles: ['Architect']
      
    - from: 'MERGE'
      to: 'DEVELOP'
      labels: ['iterate', 'revision']
      allowed_roles: ['Architect']
      
    # Division (split into children, stay in same stage)
    - from: 'DRAFT'
      to: 'DRAFT'
      labels: ['divide', 'division']
      allowed_roles: ['any']
      
    - from: 'REVIEW'
      to: 'REVIEW'
      labels: ['divide', 'division']
      allowed_roles: ['PM']
      
    - from: 'DEVELOP'
      to: 'DEVELOP'
      labels: ['divide', 'division']
      allowed_roles: ['PM']
      
    - from: 'MERGE'
      to: 'MERGE'
      labels: ['divide', 'division']
      allowed_roles: ['PM']
      
    # Dependency wait (self-transition, pauses the workflow)
    - from: 'DRAFT'
      to: 'DRAFT'
      labels: ['depend', 'waiting']
      allowed_roles: ['any']
      
    - from: 'REVIEW'
      to: 'REVIEW'
      labels: ['depend', 'waiting']
      allowed_roles: ['any']
      
    - from: 'DEVELOP'
      to: 'DEVELOP'
      labels: ['depend', 'waiting']
      allowed_roles: ['any']
      
    - from: 'MERGE'
      to: 'MERGE'
      labels: ['depend', 'waiting']
      allowed_roles: ['any']
```

### Example 2: Quick-Fix (3 stages)

```yaml
workflow:
  id: 'quick-fix'
  name: 'Quick Fix'
  description: '3-stage rapid fix pipeline for bugs and hotfixes'
  version: '1.0.0'
  
  start_stage: 'TRIAGE'
  terminal_stages: ['DEPLOYED', 'WONT_FIX']
  default_maturity_gate: 1    # Lower gate — move faster
  
  roles:
    - name: 'any'
      description: 'Any developer'
      clearance: 1
      is_default: true
    - name: 'Lead'
      description: 'Team lead approval'
      clearance: 3

  stages:
    - name: 'TRIAGE'
      order: 1
      description: 'Assess and prioritize the fix'
      auto_transitions:
        on_mature: 'FIX'
    
    - name: 'FIX'
      order: 2
      description: 'Implement and test the fix'
      timeout: '4h'            # auto-escalate if not done in 4h
      auto_transitions:
        on_mature: 'DEPLOYED'
        on_timeout: 'ESCALATE'
    
    - name: 'DEPLOYED'
      order: 3
      description: 'Fix deployed and verified'
    
    - name: 'ESCALATE'
      order: 90
      description: 'Escalated — needs human attention'
    
    - name: 'WONT_FIX'
      order: 97
      description: 'Declined as not worth fixing'

  transitions:
    - from: 'TRIAGE'
      to: 'FIX'
      labels: ['mature', 'accepted']
      allowed_roles: ['any']
      
    - from: 'TRIAGE'
      to: 'WONT_FIX'
      labels: ['reject', 'discard']
      allowed_roles: ['Lead']
      
    - from: 'FIX'
      to: 'DEPLOYED'
      labels: ['mature', 'deploy']
      allowed_roles: ['any']
      requires_ac: true
      
    - from: 'FIX'
      to: 'TRIAGE'
      labels: ['iterate', 'revision']
      allowed_roles: ['Lead']
      
    - from: 'FIX'
      to: 'ESCALATE'
      labels: ['timeout', 'escalate']
      allowed_roles: ['any']
```

### Example 3: Code Review (4 stages)

```yaml
workflow:
  id: 'code-review'
  name: 'Code Review Pipeline'
  description: '4-stage code review with mandatory quorum'
  version: '1.0.0'
  
  start_stage: 'OPEN'
  terminal_stages: ['MERGED', 'CLOSED']
  default_maturity_gate: 2
  
  roles:
    - name: 'Author'
      description: 'PR author'
      clearance: 1
    - name: 'Reviewer'
      description: 'Assigned reviewer'
      clearance: 2
    - name: 'Maintainer'
      description: 'Repo maintainer with merge authority'
      clearance: 4

  stages:
    - name: 'OPEN'
      order: 1
      description: 'PR opened, awaiting review assignment'
      auto_transitions:
        on_mature: 'REVIEWING'
    
    - name: 'REVIEWING'
      order: 2
      description: 'Under active review'
      quorum:
        required_count: 2
        required_roles: ['Reviewer']
        veto_power: true
      auto_transitions:
        on_mature: 'APPROVED'
    
    - name: 'APPROVED'
      order: 3
      description: 'Approved, awaiting merge'
      timeout: '48h'
  
    - name: 'MERGED'
      order: 4
      description: 'Merged to main branch'
    
    - name: 'CLOSED'
      order: 97
      description: 'Closed without merging'

  transitions:
    - from: 'OPEN'
      to: 'REVIEWING'
      labels: ['mature', 'assigned']
      allowed_roles: ['Maintainer']
      
    - from: 'REVIEWING'
      to: 'APPROVED'
      labels: ['approve', 'quorum_met']
      allowed_roles: ['Reviewer']
      gating:
        type: 'quorum'
        quorum_count: 2
        min_approvals: 2
        required_verdict: 'approve'
      
    - from: 'REVIEWING'
      to: 'OPEN'
      labels: ['changes_requested', 'iterate']
      allowed_roles: ['Reviewer']
      
    - from: 'REVIEWING'
      to: 'CLOSED'
      labels: ['close', 'discard']
      allowed_roles: ['Author', 'Maintainer']
      
    - from: 'APPROVED'
      to: 'MERGED'
      labels: ['merge', 'mature']
      allowed_roles: ['Maintainer']
      
    - from: 'APPROVED'
      to: 'CLOSED'
      labels: ['close', 'stale']
      allowed_roles: ['Maintainer']
```

---

## How SMDL Maps to Database

### Loading Flow

```
YAML/SMDL file 
  → Validate against JSON Schema
  → Insert into workflow_templates
  → User instantiates → INSERT workflows
  → INSERT workflow_stages (from stages[])
  → INSERT workflow_transitions (from transitions[])
  → INSERT workflow_roles (from roles[])
  → proposal.workflow_id = workflow.id
```

### Database Tables

```sql
-- 1. Templates (stored SMDL definitions)
CREATE TABLE workflow_templates (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    smdl_id         TEXT NOT NULL UNIQUE,          -- e.g., 'rfc-5'
    name            TEXT NOT NULL,
    description     TEXT,
    smdl_definition JSONB NOT NULL,                -- full YAML as JSON
    version         TEXT NOT NULL DEFAULT '1.0.0',
    is_system       BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Workflows (user instances)
CREATE TABLE workflows (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    template_id     BIGINT REFERENCES workflow_templates(id),
    name            TEXT NOT NULL,
    smdl_definition JSONB NOT NULL,                -- possibly modified
    is_active       BOOLEAN DEFAULT TRUE,
    created_by      TEXT,
    modified_at     TIMESTAMPTZ DEFAULT NOW(),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Stages (materialized from SMDL stages[])
CREATE TABLE workflow_stages (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workflow_id     BIGINT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    stage_name      TEXT NOT NULL,
    stage_order     INT NOT NULL,
    maturity_gate   INT DEFAULT 2,
    requires_ac     BOOLEAN DEFAULT FALSE,
    gating_config   JSONB,                         -- quorum, timeout
    UNIQUE(workflow_id, stage_name),
    UNIQUE(workflow_id, stage_order)
);

-- 4. Transitions (materialized from SMDL transitions[])
CREATE TABLE workflow_transitions (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workflow_id     BIGINT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    from_stage      TEXT NOT NULL,
    to_stage        TEXT NOT NULL,
    labels          TEXT[],                        -- reason codes
    allowed_roles   TEXT[],
    requires_ac     BOOLEAN DEFAULT FALSE,
    gating_rules    JSONB,                         -- additional conditions
    UNIQUE(workflow_id, from_stage, to_stage)
);

-- 5. Roles (materialized from SMDL roles[])
CREATE TABLE workflow_roles (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workflow_id     BIGINT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    role_name       TEXT NOT NULL,
    description     TEXT,
    clearance       INT DEFAULT 1,
    is_default      BOOLEAN DEFAULT FALSE,
    UNIQUE(workflow_id, role_name)
);

-- Proposals reference their workflow
ALTER TABLE proposal ADD COLUMN workflow_id BIGINT REFERENCES workflows(id);
```

### Handler: Load SMDL → Register Workflow

```typescript
async function loadStateMachine(smdl: StateMachineDefinition): Promise<void> {
  // 1. Validate
  validateSMDL(smdl);
  
  // 2. Upsert template
  const templateId = await upsertTemplate(smdl);
  
  // 3. Materialize stages
  for (const stage of smdl.workflow.stages) {
    await query(`
      INSERT INTO workflow_stages (workflow_id, stage_name, stage_order, maturity_gate, requires_ac, gating_config)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (workflow_id, stage_name) DO UPDATE SET 
        stage_order = EXCLUDED.stage_order,
        maturity_gate = EXCLUDED.maturity_gate,
        requires_ac = EXCLUDED.requires_ac,
        gating_config = EXCLUDED.gating_config
    `, [templateId, stage.name, stage.order, stage.maturity_gate || smdl.workflow.default_maturity_gate, stage.requires_ac, stage.quorum]);
  }
  
  // 4. Materialize transitions
  for (const t of smdl.workflow.transitions) {
    await query(`
      INSERT INTO workflow_transitions (workflow_id, from_stage, to_stage, labels, allowed_roles, requires_ac, gating_rules)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (workflow_id, from_stage, to_stage) DO UPDATE SET
        labels = EXCLUDED.labels,
        allowed_roles = EXCLUDED.allowed_roles,
        requires_ac = EXCLUDED.requires_ac
    `, [templateId, t.from, t.to, t.labels, t.allowed_roles, t.requires_ac, t.gating]);
  }
  
  // 5. Materialize roles
  for (const role of smdl.workflow.roles) {
    await query(`
      INSERT INTO workflow_roles (workflow_id, role_name, description, clearance, is_default)
      VALUES ($1, $2, $3, $4, $5)
    `, [templateId, role.name, role.description, role.clearance, role.is_default]);
  }
}
```

### Handler: Transition Proposal (uses SMDL-defined workflow)

```typescript
async function transitionProposal(args: {
  proposal_id: string;
  to_stage: string;
  triggered_by: string;
  rationale?: string;
}): Promise<CallToolResult> {
  // 1. Load proposal + its workflow
  const { rows: props } = await query(
    `SELECT id, status, maturity_level, workflow_id FROM proposal WHERE display_id = $1`,
    [args.proposal_id]
  );
  if (!props.length) return errorResult('Proposal not found');
  
  const prop = props[0];
  const workflowId = prop.workflow_id || 1; // default to RFC-5
  const fromStage = prop.status;
  
  // 2. Load matching transition rule from workflow
  const { rows: rules } = await query(
    `SELECT * FROM workflow_transitions 
     WHERE workflow_id = $1 AND from_stage = $2 AND to_stage = $3`,
    [workflowId, fromStage, args.to_stage]
  );
  if (!rules.length) return errorResult(`Invalid transition: ${fromStage} → ${args.to_stage}`);
  
  const rule = rules[0];
  
  // 3. Check role permission
  const canTrigger = rule.allowed_roles.includes('any') || 
                     rule.allowed_roles.includes(args.triggered_by);
  if (!canTrigger) return errorResult(`Role not allowed for this transition`);
  
  // 4. Check AC requirement
  if (rule.requires_ac) {
    const { rows: ac } = await query(
      `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE is_met) as met 
       FROM proposal_acceptance_criteria WHERE proposal_id = $1`,
      [prop.id]
    );
    if (ac[0].total !== ac[0].met) return errorResult('Not all acceptance criteria met');
  }
  
  // 5. Execute transition
  await query(`
    UPDATE proposal SET status = $1, maturity_level = $2
    WHERE id = $3
  `, [args.to_stage, classifyMaturity(fromStage, args.to_stage), prop.id]);
  
  // 6. Log audit trail
  await query(`
    INSERT INTO proposal_state_transitions 
    (proposal_id, from_stage, to_stage, triggered_by, labels, rationale)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [prop.id, fromStage, args.to_stage, args.triggered_by, rule.labels[0], args.rationale]);
}
```

---

## Extending SMDL (Future)

| Feature | v1 | v2 | v3 |
|---|---|---|---|
| Basic stages/transitions | ✅ | ✅ | ✅ |
| Role-based gates | ✅ | ✅ | ✅ |
| Quorum rules | ✅ | ✅ | ✅ |
| Timeouts | - | ✅ | ✅ |
| Sub-workflows | - | - | ✅ |
| Parallel stages | - | - | ✅ |
| Custom validators (JS/WASM) | - | - | ✅ |
| Visual editor export | - | ✅ | ✅ |

---

## Validation Schema (JSON Schema)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["workflow"],
  "properties": {
    "workflow": {
      "type": "object",
      "required": ["id", "name", "stages", "transitions"],
      "properties": {
        "id": { "type": "string", "pattern": "^[a-z0-9-]+$" },
        "name": { "type": "string", "minLength": 1 },
        "start_stage": { "type": "string" },
        "terminal_stages": { "type": "array", "items": { "type": "string" } },
        "default_maturity_gate": { "type": "integer", "minimum": 0, "maximum": 3 },
        "roles": { "type": "array", "items": { "$ref": "#/definitions/role" } },
        "stages": { "type": "array", "items": { "$ref": "#/definitions/stage" } },
        "transitions": { "type": "array", "items": { "$ref": "#/definitions/transition" } }
      }
    }
  },
  "definitions": {
    "role": {
      "type": "object",
      "required": ["name"],
      "properties": {
        "name": { "type": "string" },
        "clearance": { "type": "integer", "minimum": 1, "maximum": 10 }
      }
    },
    "stage": {
      "type": "object",
      "required": ["name", "order"],
      "properties": {
        "name": { "type": "string" },
        "order": { "type": "integer", "minimum": 1 },
        "requires_ac": { "type": "boolean" },
        "maturity_gate": { "type": "integer" }
      }
    },
    "transition": {
      "type": "object",
      "required": ["from", "to", "labels", "allowed_roles"],
      "properties": {
        "from": { "type": "string" },
        "to": { "type": "string" },
        "labels": { "type": "array", "items": { "type": "string" } },
        "allowed_roles": { "type": "array", "items": { "type": "string" } },
        "requires_ac": { "type": "boolean" }
      }
    }
  }
}
```

---

## Usage

```bash
# Load a workflow template from YAML
smdl load ./workflows/rfc-5.yaml
smdl load ./workflows/quick-fix.yaml
smdl load ./workflows/code-review.yaml

# List available workflows
smdl list

# Assign workflow to a proposal
smdl assign --proposal RFC-015 --workflow quick-fix

# Validate a custom workflow
smdl validate ./workflows/my-custom.yaml
```

---

## Why This Matters

1. **No code changes for new workflows** — just write a YAML file
2. **Product extensibility** — ship 3 presets, let users create 100 more
3. **Domain-specific pipelines** — FINOPS uses one, AI Engine uses another, Ops uses a third
4. **Versioning** — SMDL files are tracked in Git, diffable, reviewable
5. **Agent-native** — agents can propose new workflows, users approve, no engineering needed

This turns AgentHive from a fixed RFC tracker into a **workflow platform**.
