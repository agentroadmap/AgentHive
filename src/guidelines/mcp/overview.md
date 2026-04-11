## agentRoadmap.md Overview (MCP)

This project uses agentRoadmap.md to track features, bugs, and structured work as states.

### When to Use Roadmap

**Create a state if the work requires planning or decision-making:**

Ask yourself: "Do I need to think about HOW to do this?"
- **YES** → Search for existing state first, create if needed
- **NO** → Just do it (the change is trivial/mechanical)

**Examples of work that needs states:**
- "Fix the authentication bug" → need to investigate, understand root cause, choose fix
- "Add error handling to the API" → need to decide what errors, how to handle them
- "Refactor UserService" → need to plan new structure, migration path

**Examples of work that doesn't need states:**
- "Fix typo in README" → obvious mechanical change
- "Update version number to 2.0" → straightforward edit
- "Add missing semicolon" → clear what to do

**Always skip states for:**
- Questions and informational requests
- Reading/exploring/explaining code, issues, or concepts

### Typical Workflow

When the user requests non-trivial work:
1. **Search first:** Use `state_search` or `state_list` (with status filters) - work might already be tracked
2. **If found:** Work on the existing state. Check state-execution workflow to know how to proceed
3. **If not found:** Create state(s) based on scope (single state or present breakdown for approval). Check state-creation workflow for details
4. **Execute:** Follow state-execution guidelines

Searching first avoids duplicate states and helps you understand existing context.

### Detailed Guidance (Required)

Read these resources to get essential instructions when:

- **Creating states** → `roadmap://workflow/state-creation` - Scope assessment, acceptance criteria, parent/substates structure
- **Planning & executing work** → `roadmap://workflow/state-execution` - Planning workflow, implementation discipline, scope changes
- **Finalizing states** → `roadmap://workflow/state-finalization` - Audit & certification workflow, PoA, next steps

These guides contain critical workflows you need to follow for proper state management.

### Core Principle

Roadmap tracks **commitments** (what will be built). Use your judgment to distinguish between "help me understand X" (no tracking) vs "add feature Y" (track in Roadmap).

**Execution Model:** States are executed by independent AI agents in separate sessions. Each agent only sees its assigned state, not prior conversation history, so states must include enough context for a developer with no prior knowledge to start immediately.

### MCP Tools Quick Reference

**Note:** "Reached" states stay in the Reached column until periodic cleanup moves them to the completed folder. Don't use `state_complete` immediately after finishing—it's for batch cleanup, not per-state workflow.

- `state_list` — list states with optional filtering by status, assignee, or labels
- `state_search` — search states by title and description
- `state_view` — read full state context (description, plan, notes, final summary, acceptance criteria, verification statements)
- `state_create` — create new states with description and acceptance criteria
- `state_edit` — update state metadata, status, plan, notes, final summary, acceptance criteria, and dependencies
- `state_complete` — move a Reached state to the completed folder (periodic cleanup, not immediate)
- `state_archive` — archive a state that should not be completed
- `state_heartbeat`, `state_claim`, `state_release`, `state_renew`
- `agents_talk`, `agents_list`
### The Project Journey Paradigm

Roadmap.md projects follow a **dynamic journey paradigm** from a **Seed Inspiration** to a **Project Vision**.

- **Seed Inspiration**: Found in the **Initial State** (`state-0`). Research this first.
- **Project Vision**: Found in the **Vision State** (highest ID). This is your destination.
- **Your Role**: Use the skeleton DAG provided by the blueprint as a starting point. Your first task is to research the Seed, analyze the Vision, and **refine the intermediate states** with specific technical plans and acceptance criteria.

**Always operate through MCP tools. Never edit markdown files directly so relationships, metadata, and history stay consistent.**
