## AgentHive Overview (MCP)

This project uses the roadmap MCP surface to track AgentHive proposals, documents, and structured work.

### When to Use MCP-Tracked Proposals

**Create or update a proposal if the work requires planning or decision-making:**

Ask yourself: "Do I need to think about HOW to do this?"
- **YES** → Search for an existing proposal first, create one if needed
- **NO** → Just do it (the change is trivial/mechanical)

**Examples of work that needs proposals:**
- "Fix the authentication bug" → need to investigate, understand root cause, choose fix
- "Add error handling to the API" → need to decide what errors, how to handle them
- "Refactor UserService" → need to plan new structure, migration path

**Examples of work that doesn't need proposals:**
- "Fix typo in README" → obvious mechanical change
- "Update version number to 2.0" → straightforward edit
- "Add missing semicolon" → clear what to do

**Always skip proposal tracking for:**
- Questions and informational requests
- Reading/exploring/explaining code, issues, or concepts

### Typical Workflow

When the user requests non-trivial work:
1. **Search first:** Use `proposal_search` or `proposal_list` and check whether work is already tracked
2. **If found:** Work on the existing proposal and follow the relevant execution workflow
3. **If not found:** Create proposal(s) based on scope and proposal type
4. **Execute:** Follow state-execution guidelines

Searching first avoids duplicate proposals and helps you understand existing context.

### Detailed Guidance (Required)

Read these resources to get essential instructions when:

- **Creating tracked work** → `roadmap://workflow/state-creation` - Scope assessment, acceptance criteria, parent/substates structure
- **Planning & executing work** → `roadmap://workflow/state-execution` - Planning workflow, implementation discipline, scope changes
- **Finalizing work** → `roadmap://workflow/state-finalization` - Audit & certification workflow, PoA, next steps

These guides contain critical workflows you need to follow for proper proposal management.

### Core Principle

Roadmap tracks **commitments**. Use your judgment to distinguish between "help me understand X" (no tracking) vs "add feature Y" (track as a proposal).

**Execution Model:** Proposals are executed by independent AI agents in separate sessions. Each agent only sees its assigned proposal context, not prior conversation history, so the proposal must include enough information for a developer with no prior knowledge to start immediately.

### MCP Tools Quick Reference

**Authoritative Workflow:** For AgentHive RFC-style work, the canonical flow is `Draft -> Review -> Develop -> Merge -> Complete`, with universal maturity `New -> Active -> Mature -> Obsolete`. Proposal type determines which workflow template applies.

- `proposal_list` or `prop_list` — list tracked proposals depending on backend
- `proposal_search` — search filesystem-backed proposals
- `proposal_view` or `prop_get` — read proposal details
- `proposal_create` or `prop_create` — create proposals
- `proposal_edit` or `prop_update` — update proposal metadata and content
- `prop_transition` — change workflow stage
- `prop_set_maturity` — change maturity inside the current workflow stage
- `proposal_claim`, `proposal_release`, `proposal_renew`, `proposal_heartbeat`
- `agents_talk`, `agents_list`
### The Project Journey Paradigm

Roadmap.md projects follow a **dynamic journey paradigm** from a **Seed Inspiration** to a **Project Vision**.

- **Seed Inspiration**: Found in the initial directive or earliest proposal context.
- **Project Vision**: Found in the current top-level directive or vision proposal.
- **Your Role**: Use the existing DAG and proposal tree as a starting point, then refine intermediate proposals with technical plans and acceptance criteria.

**Always operate through MCP tools where supported. Never bypass the workflow record when relationships, metadata, or history need to stay consistent.**
