# Configurable Workflow Engine

## Context

GQ77 directive (2026-04-04 19:45): "We don't want this product locked down to this one RFC workflow. We want to make it flexible so in the future, user maybe modify this workflow with 6 or 7 stage, different gating and pipeline. We may even ship different RFC workflow template for use to choice from."

This is a **Workflow Engine**, not a fixed RFC pipeline.

## Architecture

### Data Model

```
proposal → workflow_id → workflow_definition → stages + transitions + gating
```

### New Tables (on top of existing live schema)

#### 1. `workflow_templates` (Presets)
```sql
CREATE TABLE workflow_templates (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,           -- 'RFC-5', 'Quick-Fix', 'Enterprise'
    description TEXT,
    stage_count INT NOT NULL,                   -- number of stages
    is_system   BOOLEAN DEFAULT FALSE,          -- system presets cannot be deleted
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

#### 2. `workflows` (User-configurable instances)
```sql
CREATE TABLE workflows (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    template_id     BIGINT REFERENCES workflow_templates(id), -- NULL if custom from scratch
    name            TEXT NOT NULL,
    description     TEXT,
    is_active       BOOLEAN DEFAULT TRUE,
    created_by      TEXT,                           -- who created
    modified_at     TIMESTAMPTZ DEFAULT NOW(),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

#### 3. `workflow_stages` (Stage definitions per workflow)
```sql
CREATE TABLE workflow_stages (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workflow_id     BIGINT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    stage_name      TEXT NOT NULL,                  -- 'Draft', 'Review', 'Develop', 'Merge'
    stage_order     INT NOT NULL,                   -- 1, 2, 3... defines the pipeline
    maturity_gate   INT DEFAULT 2,                  -- maturity level to advance (default: Mature)
    description     TEXT,
    gating_config   JSONB,                          -- role requirements, AC requirements, quorum
    UNIQUE(workflow_id, stage_order),
    UNIQUE(workflow_id, stage_name)
);
```

#### 4. `workflow_transitions` (Rules per workflow)
```sql
CREATE TABLE workflow_transitions (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workflow_id     BIGINT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    from_stage      TEXT NOT NULL,
    to_stage        TEXT NOT NULL,
    label           TEXT NOT NULL,                  -- 'mature', 'decision', 'iteration', 'depend', 'reject', 'discard'
    allowed_roles   TEXT[],                         -- who can trigger: '{any}', '{PM,Architect}'
    requires_ac     BOOLEAN DEFAULT FALSE,           -- gates: must all AC be met?
    gating_rules    JSONB,                          -- custom rules: quorum, votes, approvals
    UNIQUE(workflow_id, from_stage, to_stage, label)
);
```

#### 5. `workflow_roles` (Role definitions per workflow)
```sql
CREATE TABLE workflow_roles (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workflow_id     BIGINT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    role_name       TEXT NOT NULL,                  -- 'PM', 'Architect', 'Dev Lead', 'Reviewer'
    description     TEXT,
    clearance_level INT DEFAULT 1,
    UNIQUE(workflow_id, role_name)
);
```

### Existing Table Changes

#### `proposal` table gets `workflow_id`:
```sql
ALTER TABLE proposal ADD COLUMN workflow_id BIGINT REFERENCES workflows(id) DEFAULT 1;
```

#### `proposal_valid_transitions` becomes multi-workflow aware:
Option A: Add `workflow_id` column to existing table.
Option B: Deprecate in favor of `workflow_transitions` (the engine layer).

**Recommendation: Option B.** `workflow_transitions` replaces `proposal_valid_transitions` entirely. Keep the old table as legacy seed data for workflow 1.

## Seed the Current RFC as Workflow ID = 1

```sql
-- Template
INSERT INTO workflow_templates (name, description, stage_count, is_system)
VALUES ('RFC-5', '5-stage RFC workflow: Proposal → Draft → Review → Develop → Merge → Complete', 6, true);

-- Workflow instance
INSERT INTO workflows (template_id, name, description, is_active)
VALUES (1, 'Default RFC', 'Standard RFC workflow', true);  -- id = 1

-- Stages
INSERT INTO workflow_stages (workflow_id, stage_name, stage_order, maturity_gate, gating_config)
VALUES
    (1, 'PROPOSAL',  1, 2, '{"roles": ["any"]}'),
    (1, 'DRAFT',     2, 2, '{"roles": ["any"]}'),
    (1, 'REVIEW',    3, 2, '{"roles": ["any"], "requires_ac": true}'),
    (1, 'DEVELOP',   4, 2, '{"roles": ["any"], "requires_ac": true}'),
    (1, 'MERGE',     5, 2, '{"roles": ["any"], "requires_ac": true}'),
    (1, 'COMPLETE',  6, 0, '{"roles": ["any"]}');

-- Transitions (18 rules for the RFC 5-stage workflow)
INSERT INTO workflow_transitions (workflow_id, from_stage, to_stage, label, allowed_roles, requires_ac)
VALUES
    -- Core advancement
    (1, 'PROPOSAL', 'DRAFT',   'mature',  '{any}', false),
    (1, 'DRAFT',    'REVIEW',  'mature',  '{any}', false),
    (1, 'REVIEW',   'DEVELOP', 'mature',  '{any}', true),
    (1, 'DEVELOP',  'MERGE',   'mature',  '{any}', true),
    (1, 'MERGE',    'COMPLETE','mature',  '{any}', true),
    -- Rejection paths
    (1, 'REVIEW',   'REJECTED','reject',  '{any}', false),
    (1, 'DEVELOP',  'REJECTED','reject',  '{any}', false),
    (1, 'MERGE',    'REJECTED','reject',  '{any}', false),
    -- Discard paths
    (1, 'DRAFT',    'DISCARDED','discard', '{any}', false),
    (1, 'REVIEW',   'DISCARDED','discard', '{any}', false),
    -- Iteration (go back one stage)
    (1, 'REVIEW',   'DRAFT',   'iterate', '{any}', false),
    (1, 'DEVELOP',  'REVIEW',  'iterate', '{any}', false),
    (1, 'MERGE',    'DEVELOP', 'iterate', '{any}', false),
    -- Division (split, same stage)
    (1, 'DRAFT',    'DRAFT',   'divide',  '{any}', false),
    (1, 'REVIEW',   'REVIEW',  'divide',  '{any}', false),
    (1, 'DEVELOP',  'DEVELOP', 'divide',  '{any}', false),
    (1, 'MERGE',    'MERGE',   'divide',  '{any}', false),
    -- Dependency wait (self-transition)
    (1, 'DRAFT',    'DRAFT',   'depend',  '{any}', false),
    (1, 'REVIEW',   'REVIEW',  'depend',  '{any}', false),
    (1, 'DEVELOP',  'DEVELOP', 'depend',  '{any}', false),
    (1, 'MERGE',    'MERGE',   'depend',  '{any}', false);

-- Roles
INSERT INTO workflow_roles (workflow_id, role_name, description)
VALUES (1, 'PM', 'Product Manager'),
       (1, 'Architect', 'Technical design authority'),
       (1, 'Dev Lead', 'Development lead'),
       (1, 'Skeptic', 'QA & adversarial review'),
       (1, 'any', 'Any agent');
```

## Example: Quick-Fix Workflow (3 stages)

```sql
INSERT INTO workflow_templates (name, description, stage_count, is_system)
VALUES ('Quick-Fix', '3-stage rapid fix: Triage → Fix → Deploy', 3, true);

-- User creates instance
-- Stages: TRIAGE (1) → FIX (2) → DEPLOY (3)
-- Transitions: fewer gates, no role requirements, optional AC
```

## MCP Tools (new)

| Tool | Purpose |
|---|---|
| `list_workflows` | Show all available workflows + templates |
| `get_workflow` | Get workflow definition (stages, transitions, roles) |
| `create_workflow` | Create custom workflow from scratch or template |
| `edit_stage` | Modify a stage in a custom workflow |
| `add_transition` | Add/edit/remove transition rule |
| `assign_workflow` | Set workflow_id on a proposal |
| `template_clone` | Clone a template into editable workflow |

## Handler Changes

The `transition_proposal` handler changes from:
```sql
SELECT * FROM proposal_valid_transitions WHERE from_state = $1 AND to_state = $2
```
to:
```sql
SELECT * FROM workflow_transitions 
WHERE workflow_id = (SELECT workflow_id FROM proposal WHERE id = $1)
  AND from_stage = $2 AND to_stage = $3
```

## Migration Path

1. Create the 5 new tables
2. Seed the current RFC as workflow_id = 1
3. Add `workflow_id` to `proposal` (default 1)
4. Update handlers to lookup `workflow_id` → `workflow_transitions`
5. Keep `proposal_valid_transitions` as legacy (backfill from workflow_transitions)
6. Ship `workflow_templates` + `workflow_stages` as "Workflow Templates" feature

## Benefits

- **No code changes for new workflows** — just insert rows
- **Users can pick presets** — RFC-5, Quick-Fix, Enterprise, etc.
- **Users can customize** — clone a template, modify stages/transitions, create their own
- **Multi-tenant ready** — different teams/domains can have different workflows
- **Backwards compatible** — existing proposals get default workflow 1
