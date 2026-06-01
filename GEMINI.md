# AgentHive Foundational Mandates

This file contains team-shared architectural patterns, workflows, and conventions. These mandates take absolute precedence over general agent defaults.

## Concurrency & Workspace Isolation

### 1. Root Directory Prohibition
- **Mandate**: No agent shall perform multi-step modifications or branch-switching in the shared root directory `/data/code/AgentHive`.
- **Reason**: The root directory is a single mutable cursor. Concurrent agents running `git checkout` or `git reset` will swap files underneath each other, leading to silent code loss and execution failures.
- **Workflow**: 
  - For any task involving more than 2 tool calls or any file edits, **MUST** create a dedicated worktree:
    ```bash
    git worktree add /data/code/worktree/your-agent-name-P### your-branch-name
    ```
  - Perform all work within that isolated worktree.

### 2. Branch Ownership
- **Mandate**: One branch = One owner = One proposal.
- **Constraint**: Only push to the branch associated with the proposal lease you currently hold. 
- **Main Integrity**: Never push directly to `main`. All changes must go through a reviewed Merge Request (MR).

## Engineering Standards

### 1. Robust Dynamic Imports (MCP)
- **Convention**: Always access dynamically imported handlers via the module object.
- **Bad (Races/Undefined)**:
  ```typescript
  const { handler } = await import("./tools/handlers.ts");
  server.addTool({ handler: (a) => handler(a) });
  ```
- **Good (Safe)**:
  ```typescript
  const handlers = await import("./tools/handlers.ts");
  server.addTool({ handler: (a) => handlers.handler(a) });
  ```
- **Reason**: Runtime loaders (like `jiti`) can occasionally resolve destructured properties as `undefined` if the import is not fully settled or in certain race conditions.

### 2. Agent Registration
- **Constraint**: The `agent_register` tool requires a valid `agent_type`. 
- **Default**: If `template` is missing, the system now defaults to `agency`. Always prefer providing an explicit `agent_type` when possible.

## Project Context
- **Private Project Memory**: `/home/gary/.gemini/tmp/agenthive/memory/MEMORY.md` (Personal/Machine-specific).
- **Team Memory**: `TEAM_MEMORY.md` (Legacy/Team-wide status).
- **Proposals**: Use `mcp_proposal` tools to manage work. AC verification is **MANDATORY** and must include structured evidence in the `details` field.
