## State Execution Guide

### Planning Workflow

> **Non-negotiable:** Capture an implementation plan in the Roadmap state _before_ writing any code or running commands. The plan must live in the state record prior to implementation and remain up to date when you close the state.

1. **Mark state as Active** via `state_edit` with status "Active"
2. **Assign to yourself** via `state_edit` with assignee field
3. **Review state references and documentation** - Check any `references` (related code, issues) and `documentation` (design docs, API specs) attached to the state before planning
4. **Draft the implementation plan** - Think through the approach, review code, identify key files
5. **Present plan to user** - Show your proposed implementation approach
6. **Wait for explicit approval** - Do not start coding until user confirms or asks you to skip review
7. **Record approved plan** - Use `state_edit` with planSet or planAppend to capture the agreed approach in the state
8. **Document the agreed breakdown** - In the parent state's plan, capture the final list of substates, owners, and sequencing so a replacement agent can resume with the approved structure

**IMPORTANT:** Use states as permanent storage for everything related to the work. You may be interrupted or replaced at any point, so the state record must contain everything needed for a clean handoff.

### Planning Guidelines

- Keep the Roadmap state as the single plan of record: capture the agreed approach with `state_edit` (planSet field) before writing code
- Use `state_edit` (planAppend field) to refine the plan when you learn more during implementation
- Verify prerequisites before committing to a plan: confirm required tools, access, data, and environment support are in place
- Keep plans structured and actionable: list concrete steps, highlight key files, call out risks, and note any checkpoints or validations
- Ensure the plan reflects the agreed user outcome and acceptance criteria; if expectations are unclear, clarify them before proceeding
- When additional context is required, review relevant code, documentation, or external references so the plan incorporates the latest knowledge
- Treat the plan and acceptance criteria as living guides - update both when the approach or expectations change so future readers understand the rationale
- If you need to add or remove states or shift scope later, pause and run the "present → approval" loop again before editing the roadmap; never change the breakdown silently

### Working with Substates (Planning)

- If working on a parent state with substates, create a high-level plan for the parent that outlines the overall approach
- Each substate should have its own detailed implementation plan when you work on it
- Ensure substate plans are consistent with the parent state's overall strategy

### Execution Workflow

- **IMPORTANT**: Do not touch the codebase until the implementation plan is approved _and_ recorded in the state via `state_edit`
- The recorded plan must stay accurate; if the approach shifts, update it first and get confirmation before continuing
- If feedback requires changes, revise the plan first via `state_edit` (planSet or planAppend fields)
- Work in short loops: implement, run the relevant tests, and immediately check off acceptance criteria with `state_edit` (acceptanceCriteriaCheck field) when they are met
- Log progress with `state_edit` (notesAppend field) to document decisions, blockers, or learnings
- Keep state status aligned with reality via `state_edit`

### Handling Scope Changes

If new work appears during implementation that wasn't in the original acceptance criteria:

**STOP and ask the user**:
"I discovered [new work needed]. Should I:
1. Add acceptance criteria to the current state and continue, or
2. Create a follow-up state to handle this separately?"

**Never**:
- Silently expand the scope without user approval
- Create new states on your own initiative
- Add acceptance criteria without user confirmation

### Staying on Track

- Stay within the scope defined by the plan and acceptance criteria
- Update the plan first if direction changes, then get user approval for the revised approach
- If you need to deviate from the plan, explain why and wait for confirmation

### Working with Substates (Execution)

- When user assigns you a parent state "and all substates", work through each substate sequentially without asking for permission to move to the next one
- When completing a single substate (without explicit instruction to continue), present progress and ask: "Substate X is complete. Should I proceed with substate Y, or would you like to review first?"
- Each substate should be fully completed (all acceptance criteria met, tests passing) before moving to the next

### Finalizing the State

When implementation is finished, follow the **State Finalization Guide** (`roadmap://workflow/state-finalization`) to finalize your work. This ensures acceptance criteria are verified, implementation is documented, and the state is properly closed.
