## AgentHive Overview (Tools)

Your client is using the roadmap MCP tool surface for AgentHive. Use the following MCP tools to retrieve guidance and manage proposals.

### When to Use Roadmap

**Create or update a proposal if the work requires planning or decision-making.** Ask yourself: "Do I need to think about HOW to do this?"

- **YES** → Search for an existing proposal first, create one if needed
- **NO** → Just do it (the change is trivial/mechanical)

**Examples of work that needs proposals:**
- "Fix the authentication bug" → need to investigate, understand root cause, choose fix
- "Add error handling to the API" → need to decide what errors, how to handle them
- "Refactor UserService" → need to plan new structure, migration path

**Examples of work that doesn't need states:**
- "Fix typo in README" → obvious mechanical change
- "Update version number to 2.0" → straightforward edit
- "Add missing semicolon" → clear what to do

**Always skip proposal tracking for:** questions, exploratory requests, or knowledge transfer only.

### Core Workflow Tools

Use these tools to retrieve the required guidance in markdown form:

- `get_workflow_overview` — Overview of when and how to use Roadmap
- `get_state_creation_guide` — Detailed instructions for creating states (scope, acceptance criteria, structure)
- `get_state_execution_guide` — Planning and executing states (implementation plans, approvals, scope changes)
- `get_state_finalization_guide` — Audit & certification workflow, PoA, next steps

Each tool returns the same content that resource-capable clients read via `roadmap://workflow/...` URIs.

### Typical Workflow (Tools)

1. **Search first:** call `proposal_search`, `proposal_list`, or `prop_list` to find existing work
2. **If found:** read details via `proposal_view` or `prop_get`; follow execution guidance from the retrieved markdown
3. **If not found:** consult `get_state_creation_guide`, then create a proposal with `proposal_create` or `prop_create`
4. **Execute & finalize:** manage workflow stage, maturity, plans, notes, and acceptance criteria through the proposal tools

**Authoritative Workflow:** For AgentHive RFC-style work, the canonical flow is `Draft -> Review -> Develop -> Merge -> Complete`. Universal maturity is `New -> Active -> Mature -> Obsolete`. Proposal type determines which workflow template applies.

### Core Principle

Roadmap tracks **commitments**. Use your judgment to distinguish between "help me understand X" (no tracked proposal) vs "add feature Y" (create or update a proposal).

### MCP Tools Quick Reference

- `get_workflow_overview`, `get_state_creation_guide`, `get_state_execution_guide`, `get_state_finalization_guide`
- `proposal_list`, `proposal_search`, `proposal_view`, `proposal_create`, `proposal_edit`
- `prop_list`, `prop_get`, `prop_create`, `prop_update`, `prop_transition`, `prop_set_maturity`
- `document_list`, `document_view`, `document_create`, `document_update`, `document_search`
- `agents_talk`, `agents_list`

**Always operate through the MCP tools above. Never bypass the workflow record when relationships, metadata, and history need to stay consistent.**
