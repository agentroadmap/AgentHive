# State Machine DSL Specification

A YAML-based language for defining workflow state machines. Parseable, versioned, and directly translatable into `proposal_valid_transitions` and `proposal_acceptance_criteria` tables.

## Overview

```
State Machine Definition
  ├── metadata (name, version, description)
  ├── states[]         -- available states
  ├── transitions[]    -- valid state transitions with guards
  ├── acceptance[]     -- acceptance criteria templates
  └── lifecycle_rules  -- maturity, obsolescence, queue behavior
```

## Schema

### Metadata
```yaml
metadata:
  name: rfc-v1                    # unique identifier
  version: 1.0.0                  # semantic version
  description: "Standard RFC workflow"
  entity_type: RFC                # which proposal_type this applies to
  created_by: Andy
  created_at: 2026-04-04
```

### States
```yaml
states:
  - key: DRAFT
    label: "Draft"
    emoji: "📝"
    description: "Initial work in progress"
    maturity_override: 0          # optional: forces maturity_level on entry
    color: gray                   # UI hint

  - key: REVIEW
    label: "In Review"
    emoji: "🔍"
    description: "Under peer review"
    maturity_override: 1
    color: yellow

  - key: DEVELOP
    label: "Developing"
    emoji: "🔨"
    description: "Implementation phase"
    maturity_override: 1
    color: blue

  - key: MERGE
    label: "Merged"
    emoji: "🔀"
    description: "Merged to main"
    maturity_override: 2
    color: green

  - key: COMPLETE
    label: "Complete"
    emoji: "✅"
    description: "Fully delivered"
    maturity_override: 2
    color: green
```

### Transitions
```yaml
transitions:
  - from: DRAFT
    to: REVIEW
    label: "Submit for review"
    emoji: "📤"
    allowed_roles: [author, lead]           # who can trigger
    requires_ac: true                       # all AC must pass
    requires_min_reviews: 0                 # optional: minimum reviews
    guard: "not blocked_by_dependencies"    # optional: condition check

  - from: REVIEW
    to: DEVELOP
    label: "Approved for development"
    emoji: "⚖️"
    allowed_roles: [lead, admin]
    requires_ac: true
    requires_min_reviews: 2
    guard: "all_reviews_approved"

  - from: REVIEW
    to: DRAFT
    label: "Request changes"
    emoji: "🔄"
    allowed_roles: [reviewer, lead, admin]
    reason_required: true                   # must provide reason

  - from: DEVELOP
    to: MERGE
    label: "Ready to merge"
    emoji: "🔀"
    allowed_roles: [author, lead]
    requires_ac: true

  - from: MERGE
    to: COMPLETE
    label: "Mark complete"
    emoji: "✅"
    allowed_roles: [lead, admin]

  - from: "*"
    to: COMPLETE
    label: "Fast-track complete"
    emoji: "⚡"
    allowed_roles: [admin]
    reason_required: true
```

**Special `from: "*"`** — wildcard transition available from any state (admin override, discard, etc.)

### Acceptance Criteria Templates
```yaml
acceptance:
  - key: technical_review
    label: "Technical Review"
    description: "Technical feasibility assessed"
    applies_to_states: [REVIEW, DEVELOP]     # when this AC is relevant

  - key: security_review
    label: "Security Review"
    description: "Security implications reviewed"
    applies_to_states: [REVIEW, MERGE]

  - key: tests_pass
    label: "Tests Pass"
    description: "All automated tests pass"
    applies_to_states: [DEVELOP, MERGE]

  - key: docs_updated
    label: "Documentation Updated"
    description: "Related docs updated"
    applies_to_states: [MERGE, COMPLETE]
```

### Lifecycle Rules
```yaml
lifecycle:
  maturity_on_complete: 2           # maturity_level when reaching COMPLETE
  maturity_on_iteration: 1          # maturity when sent back (DRAFT → REVIEW → DRAFT resets to 1)
  queue_sort: "maturity_level DESC, priority ASC, maturity_queue_position ASC"
  obsolete_states: []               # states that imply maturity=3 (obsolete)
  auto_escalate_mature_days: 7      # auto-bump maturity if no changes in N days
```

## Full Example: RFC v1
```yaml
# workflows/rfc-v1.yaml
metadata:
  name: rfc-v1
  version: 1.0.0
  description: "Standard RFC workflow"
  entity_type: RFC
  created_by: Andy
  created_at: 2026-04-04

states:
  - key: DRAFT
    label: "Draft"
    emoji: "📝"
    maturity_override: 0
    color: gray
  - key: REVIEW
    label: "In Review"
    emoji: "🔍"
    maturity_override: 1
    color: yellow
  - key: DEVELOP
    label: "Developing"
    emoji: "🔨"
    maturity_override: 1
    color: blue
  - key: MERGE
    label: "Merged"
    emoji: "🔀"
    maturity_override: 2
    color: green
  - key: COMPLETE
    label: "Complete"
    emoji: "✅"
    maturity_override: 2
    color: green

transitions:
  - from: DRAFT
    to: REVIEW
    label: "Submit for review"
    emoji: "📤"
    allowed_roles: [author, lead]
    requires_ac: true

  - from: REVIEW
    to: DEVELOP
    label: "Approved"
    emoji: "⚖️"
    allowed_roles: [lead, admin]
    requires_ac: true
    requires_min_reviews: 2

  - from: REVIEW
    to: DRAFT
    label: "Request changes"
    emoji: "🔄"
    allowed_roles: [reviewer, lead, admin]
    reason_required: true

  - from: DEVELOP
    to: MERGE
    label: "Ready to merge"
    emoji: "🔀"
    allowed_roles: [author, lead]
    requires_ac: true

  - from: MERGE
    to: COMPLETE
    label: "Mark complete"
    emoji: "✅"
    allowed_roles: [lead, admin]

acceptance:
  - key: technical_review
    label: "Technical Review"
    applies_to_states: [REVIEW, DEVELOP]
  - key: tests_pass
    label: "Tests Pass"
    applies_to_states: [DEVELOP, MERGE]
  - key: docs_updated
    label: "Documentation Updated"
    applies_to_states: [MERGE]

lifecycle:
  maturity_on_complete: 2
  maturity_on_iteration: 1
  queue_sort: "maturity_level DESC, priority ASC, maturity_queue_position ASC"
```

## Alternate Example: Lightweight (3 states)
```yaml
# workflows/lightweight.yaml
metadata:
  name: lightweight
  version: 1.0.0
  description: "Simple proposal workflow"
  entity_type: DIRECTIVE

states:
  - key: DRAFT
    label: "Draft"
    emoji: "📝"
    maturity_override: 0
  - key: APPROVED
    label: "Approved"
    emoji: "✅"
    maturity_override: 2
  - key: DONE
    label: "Done"
    emoji: "🏁"
    maturity_override: 2

transitions:
  - from: DRAFT
    to: APPROVED
    label: "Approve"
    emoji: "✅"
    allowed_roles: [lead, admin]

  - from: APPROVED
    to: DONE
    label: "Mark done"
    emoji: "🏁"
    allowed_roles: [author, lead, admin]

  - from: APPROVED
    to: DRAFT
    label: "Reopen"
    emoji: "🔄"
    allowed_roles: [lead, admin]

acceptance: []

lifecycle:
  maturity_on_complete: 2
  maturity_on_iteration: 0
```

## DB Translation

Loading a DSL file generates these DB rows:

**`proposal_valid_transitions`:**
| from_state | to_state | allowed_roles | requires_ac | reason_required |
|------------|----------|---------------|-------------|-----------------|
| DRAFT      | REVIEW   | [author,lead] | true        | false           |
| REVIEW     | DEVELOP  | [lead,admin]  | true        | false           |

**`proposal_acceptance_criteria`:**
| key               | label            | status  |
|-------------------|------------------|---------|
| technical_review  | Technical Review | pending |

**`proposal` (on workflow assignment):**
| workflow_template_id | rfc_state | maturity_level |
|---------------------|-----------|----------------|
| rfc-v1              | DRAFT     | 0              |

## Versioning

- Changing a state machine requires a new `version`
- Existing proposals stay on their original workflow version
- Migration between versions handled by `state-machine-migrate.ts` handler
- Breaking changes (removing states) require manual resolution

## File Structure

```
workflows/
  rfc-v1.yaml
  rfc-v2.yaml          # future iteration
  lightweight.yaml
  enterprise.yaml      # future: compliance-heavy workflow
```

```
