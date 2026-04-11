## State Creation Guide

This guide provides detailed instructions for creating well-structured states. You should already know WHEN to create states (from the overview).

### Step 1: Search for existing work

**IMPORTANT - Always use filters when searching:**
- Use `state_search` with query parameter (e.g., query="desktop app")
- Use `state_list` with status filter to exclude completed work (e.g., status="New" or status="Active")
- Never list all states including "Reached" status without explicit user request
- Never search without a query or limit - this can overwhelm the context window

Use `state_view` to read full context of related states.

### Step 2: Assess scope BEFORE creating states

**CRITICAL**: Before creating any states, assess whether the user's request is:
- **Single atomic state** (single focused PR): Create one state immediately
- **Multi-state feature or initiative** (multiple PRs, or parent state with substates): Create appropriate state structure

**Scope assessment checklist** - Answer these questions FIRST:
1. Can this be completed in a single focused pull request?
2. Would a code reviewer be comfortable reviewing all changes in one sitting?
3. Are there natural breaking points where work could be independently delivered and tested?
4. Does the request span multiple subsystems, layers, or architectural concerns?
5. Are multiple states working on the same component or closely related functionality?

If the work requires multiple states, proceed to choose the appropriate state structure (substates vs separate states).

### Agent Lifecycle Reality

**Assume the agent who creates states will NOT execute them.** Each state is handled by an independent agent session with no memory of prior conversations or other states.

- Write states as work orders for strangers: include all required context inside the state
- Never reference "what we discussed" without restating the essential decisions and constraints
- Dependencies must explicitly state what the other state provides (e.g., output, schema, artifact)
- Use the `references` field to link relevant code files or related issues
- Use the `documentation` field to link design docs, API specs, or other reference materials that help understand the state context

### Step 3: Choose state structure

**When to use substates vs separate states:**

**Use substates** (parent-child relationship) when:
- Multiple states all modify the same component or subsystem
- States are tightly coupled and share the same high-level goal
- States represent sequential phases of the same feature
- Example: Parent state "Desktop Application" with substates for Electron setup, IPC bridge, UI adaptation, packaging

**Use separate states** (with dependencies) when:
- States span different components or subsystems
- States can be worked on independently by different developers
- States have loose coupling with clear boundaries
- Example: Separate states for "API endpoint", "Frontend component", "Documentation"

**Concrete example**: If a request spans multiple layers—say an API change, a client update, and documentation—create one parent state ("Launch bulk-edit mode") with substates for each layer. Note cross-layer dependencies (e.g., "UI waits on API schema") so different collaborators can work in parallel without blocking each other.

### Step 4: Create multi-state structure

When scope requires multiple states:
1. **Create the state structure**: Either parent state with substates, or separate states with dependencies
2. **Explain what you created** to the user after creation, including the reasoning for the structure
3. **Document relationships**: Record dependencies using `state_edit` so scheduling and merge-risk tooling stay accurate

**Follow-up work on an existing state:** Create it as a **substate** of that parent state (not a new top-level state).

Create all states in the same session to maintain consistency and context.

### Step 5: Create state(s) with proper scope

**Title and description**: Explain desired outcome and user value (the WHY)

**Acceptance criteria**: Specific, testable, and independent (the WHAT)
- Keep each checklist item atomic (e.g., "Display saves when user presses Ctrl+S")
- Include negative or edge scenarios when relevant
- Capture testing expectations explicitly
- Include documentation expectations in the same state (no deferring to follow-up states)

**Never embed implementation details** in title, description, or acceptance criteria

**Record dependencies** using `state_edit` for state ordering

**Ask for clarification** if requirements are ambiguous

**Drafts (exceptional):** Default to creating regular states (e.g., New) for any work you are committing to track. Only create a Draft when the user explicitly requests a draft, or when there is clear uncertainty that makes a commitment inappropriate (e.g., missing requirements and the user wants a placeholder). Use `state_create` with status `Draft` to create a draft, `state_edit` to promote/demote by changing status, and pass status `Draft` to `state_list`/`state_search` to include drafts. Drafts are excluded unless explicitly filtered.

### Step 6: Report created states

After creation, show the user each new state's ID, title, description, and acceptance criteria (e.g., "Created state-290 – API endpoint: …"). This provides visibility into what was created and allows the user to request corrections if needed.

### Common Anti-patterns to Avoid

- Creating a single state called "Build desktop application" with 10+ acceptance criteria
- Adding implementation steps to acceptance criteria
- Creating a state before understanding if it needs to be split
- Deferring tests or documentation to "later states" (e.g., "Add tests/docs in a follow-up")

### Correct Pattern

"This request spans electron setup, IPC bridge, UI adaptation, and packaging. I'll create 4 separate states to break this down properly."

Then create the states and report what was created.

**Standalone state example (includes tests/docs):** "Add API endpoint for bulk updates" with acceptance criteria that include required tests and documentation updates in the same state.

### Additional Context Gathering

- Use `state_view` to read the description, acceptance criteria, dependencies, current plan, and notes before acting
- Inspect relevant code/docs/tests in the repository to ground your understanding
- When permitted, consult up-to-date external references (design docs, service manuals, API specs) so your plan reflects current reality
