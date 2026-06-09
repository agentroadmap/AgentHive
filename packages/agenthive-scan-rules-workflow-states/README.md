# @agenthive/scan-rules-workflow-states

Hardcoding scanner rule pack for workflow-state literals.

## Rules

| Rule ID | Severity | Description |
|---------|----------|-------------|
| workflow-states.bare-rfc-stage | high | Bare RFC stage string (DRAFT, REVIEW, DEVELOP, MERGE, COMPLETE) |
| workflow-states.bare-hotfix-stage | high | Bare hotfix stage string (TRIAGE, FIX, DEPLOYED) |
| workflow-states.bare-maturity | medium | Bare maturity field (new, active, mature, obsolete) |
| workflow-states.legacy-issue-status | high | Old issue status strings (open, in-progress, closed) |

## Philosophy

Workflow state enums should never be hardcoded as string literals. Instead:

- Use enum constants: `States.rfc.draft` instead of `"DRAFT"`
- Leverage type safety for state transitions
- Simplify refactoring when state names change
- Improve code readability and maintainability

These rules apply to **any project with a state machine** (RFC, workflow, issue tracking, etc.), not just AgentHive.

## Example

### ❌ Bad

```typescript
if (status === "DRAFT") {
  console.log("Proposal is a draft");
}
```

### ✅ Good

```typescript
import { States } from "@agenthive/states";

if (status === States.rfc.draft) {
  console.log("Proposal is a draft");
}
```

## Usage

```bash
npm install @agenthive/scan-core @agenthive/scan-rules-workflow-states
scan-hardcoding --format jsonl
```

## Integration

Useful for:
- Projects with RFC-based proposal workflows
- CI/CD pipelines with deployment stages
- Project management tools with custom workflows

## License

MIT
