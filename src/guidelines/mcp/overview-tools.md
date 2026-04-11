## agentRoadmap.md Overview (Tools)

Your client is using agentRoadmap.md via tools. Use the following MCP tools to retrieve guidance and manage states.

### When to Use Roadmap

**Create a state if the work requires planning or decision-making.** Ask yourself: "Do I need to think about HOW to do this?"

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

**Always skip states for:** questions, exploratory requests, or knowledge transfer only.

### Core Workflow Tools

Use these tools to retrieve the required agentRoadmap.md guidance in markdown form:

- `get_workflow_overview` — Overview of when and how to use Roadmap
- `get_state_creation_guide` — Detailed instructions for creating states (scope, acceptance criteria, structure)
- `get_state_execution_guide` — Planning and executing states (implementation plans, approvals, scope changes)
- `get_state_finalization_guide` — Audit & certification workflow, PoA, next steps

Each tool returns the same content that resource-capable clients read via `roadmap://workflow/...` URIs.

### Typical Workflow (Tools)

1. **Search first:** call `state_search` or `state_list` with filters to find existing work
2. **If found:** read details via `state_view`; follow execution/plan guidance from the retrieved markdown
3. **If not found:** consult `get_state_creation_guide`, then create states with `state_create`
4. **Execute & finalize:** use the execution/finalization guides to manage status, plans, notes, acceptance criteria and verification statements via `state_edit`

**Note:** "Reached" states stay in Reached until periodic cleanup. Moving to the completed folder (`state_complete`) is a batch operation run occasionally, not part of finishing each state. Do not use `state_archive` for completed work—archive is only for duplicate, canceled, or invalid states.

### Core Principle

Roadmap tracks **commitments** (what will be built). Use your judgment to distinguish between "help me understand X" (no state) vs "add feature Y" (create states).

### MCP Tools Quick Reference

- `get_workflow_overview`, `get_state_creation_guide`, `get_state_execution_guide`, `get_state_finalization_guide`
- `state_list`, `state_search`, `state_view`, `state_create`, `state_edit`, `state_complete`, `state_archive`, `state_heartbeat`, `state_claim`, `state_release`, `state_renew`
- `document_list`, `document_view`, `document_create`, `document_update`, `document_search`
- `agents_talk`, `agents_list`

**Always operate through the MCP tools above. Never edit markdown files directly; use the tools so relationships, metadata, and history stay consistent.**
