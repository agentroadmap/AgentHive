# Instructions for the usage of agentRoadmap.md CLI Tool

## agentRoadmap.md: Comprehensive Project Management Tool via CLI

### Assistant Objective

Efficiently manage all project states, status, and documentation using the agentRoadmap.md CLI, ensuring all project metadata
remains fully synchronized and up-to-date.

### Core Capabilities

- ✅ **State Management**: Create, edit, assign, prioritize, and track states with full metadata
- ✅ **Search**: Fuzzy search across states, documents, and decisions with `roadmap search`
- ✅ **Acceptance Criteria**: Granular control with add/remove/check/uncheck by index
- ✅ **Board Visualization**: Terminal-based Kanban board (`roadmap board`) and web UI (`roadmap browser`)
- ✅ **Git Integration**: Automatic tracking of state states across branches
- ✅ **Dependencies**: State relationships and substate hierarchies
- ✅ **Documentation & Decisions**: Structured docs and architectural decision records
- ✅ **Export & Reporting**: Generate markdown reports and board snapshots
- ✅ **AI-Optimized**: `--plain` flag provides clean text output for AI processing

### Why This Matters to You (AI Agent)

1. **Comprehensive system** - Full project management capabilities through CLI
2. **The CLI is the interface** - All operations go through `roadmap` commands
3. **Unified interaction model** - You can use CLI for both reading (`roadmap state 1 --plain`) and writing (
   `roadmap state edit 1`)
4. **Metadata stays synchronized** - The CLI handles all the complex relationships

### Key Understanding

- **States** live in `roadmap/states/` as `state-<id> - <title>.md` files
- **You interact via CLI only**: `roadmap state create`, `roadmap state edit`, etc.
- **Use `--plain` flag** for AI-friendly output when viewing/listing
- **Never bypass the CLI** - It handles Git, metadata, file naming, and relationships

---

## 🚀 The Project Journey: From Seed to Vision

This project follows a **dynamic journey paradigm**. The roadmap is not just a static list of tasks; it is a path from a **Seed Inspiration** to a **Final Ideal State (Vision)**.

### 1. The Vision-Driven Paradigm
- **Seed Inspiration**: Your starting point. Found in the **Initial State** (`state-0`). It represents what we know today (which may be very little).
- **Project Vision**: Your destination. Found in the **Vision State** (usually the highest ID). It represents the desirable product or goal.
- **The Gap**: Your job is to analyze the gap between the Seed and the Vision and build the roadmap to bridge it.

### 2. Bootstrapping & Refinement (For the First Agent)
If you are the first agent arriving in a newly initialized project:
1. **Research the Seed**: Read the `Seed Inspiration` in `state-0`. Use your research tools to explore the keywords, market, and technical landscape.
2. **Analyze the Vision**: Read the `Target Goal` in the Vision State. Understand what success looks like.
3. **Refine the DAG**: The blueprint provided a skeleton. You MUST refine it:
   - Use `state_edit` to add specific acceptance criteria to skeleton states.
   - Use `state_create` to add intermediate discovery states (e.g., "Market Survey", "Tech Prototype").
   - Identify **Obstacles**: If a path is blocked or risky, create an `obstacle` state and link it.
4. **Pivot Often**: As you gather feedback (social media polls, user tests), do not hesitate to redraw the DAG. The roadmap is alive.

### 3. Specialized Roles
You may be assigned specialized roles. Act according to their unique objectives:
- **@explorer**: Focus on research, market discovery, and ecosystem analysis.
- **@architect**: Focus on technical pathfinding, risk assessment, and alternative approaches.
- **@strategist**: Focus on positioning, user feedback loops, and social validation.
- **@promoter**: Focus on hype, marketing materials, and distribution.
- **@builder**: Focus on core engineering and implementation.

---

## 💬 Agent Communication: The Talk Protocol

You are part of a collaborative team. Use the following channels to coordinate, share findings, and ask for help.

### 1. Communication Channels
- **Public Announcement**: For high-level updates that affect everyone.
  - \`roadmap agents talk "We have initialized the baseline" --public\`
- **Group Chat**: For project-specific or topic-specific coordination (e.g., #chart).
  - \`roadmap agents talk "Starting UI scaffolding" --group chart\`
- **Private DM**: For direct coordination with another agent.
  - \`roadmap agents talk "Bob, can you review my DB schema?" --to bob\`

### 2. When to Talk
- **Wake Up / Context Switch**: When you first start work on a project or return from other tasks, **always check in** by posting a brief greeting and status to the group channel.
  - `roadmap talk "Agent [Name] is online. Resuming research on STATE-0." chart`
- **At the start of your turn**: Read the relevant channels (`roadmap/messages/`) to see if there are updates from other agents.
- **Check for DMs**: Look for files named `private-[agent-a]-[your-name].md` in the messages directory. These are private communications meant only for you.
- **When starting a state**: Post a quick note to the group channel.
- **When hitting a blocker**: Ask for help in the group channel or DM a specific specialist.
- **When finishing a major directive**: Make a public announcement.

**Protocol**: Always check in when you arrive, then read the communication log and your private messages before making major changes to the roadmap.

---

## 🏠 Global Agent Hub: The Permanent Home

You may be operating from a **Permanent Agent Home** instead of a project-specific worktree.

### 1. Home vs. Allocation
- **Your Home**: \`~/.agent-roadmap/hub/[your-name]/\`. This is where your identity (\`openclaw.json\`) and long-term memory live.
- **Your Allocations**: Found in \`allocations/\`. These are symlinks to the projects you are assigned to.

### 2. Multi-Project Workflow
- **Context Switch**: \`cd allocations/[project-name]\`. Standard \`roadmap\` commands will now operate on that specific project.
- **Global Overview**: Run \`roadmap hub status\` from your home directory to see your workload across all allocated projects.
- **Coordination**: Use \`roadmap agents talk\` within each project to coordinate with other agents assigned to that specific journey.

---

# ⚠️ CRITICAL: NEVER EDIT STATE FILES DIRECTLY. Edit Only via CLI

**ALL state operations MUST use the agentRoadmap.md CLI commands**

- ✅ **DO**: Use `roadmap state edit` and other CLI commands
- ✅ **DO**: Use `roadmap state create` to create new states
- ✅ **DO**: Use `roadmap state edit <id> --check-ac <index>` to mark acceptance criteria
- ❌ **DON'T**: Edit markdown files directly
- ❌ **DON'T**: Manually change checkboxes in files
- ❌ **DON'T**: Add or modify text in state files without using CLI

**Why?** Direct file editing breaks metadata synchronization, Git tracking, and state relationships.

---

## 1. Source of Truth & File Structure

### 📖 **UNDERSTANDING** (What you'll see when reading)

- Markdown state files live under **`roadmap/states/`** (drafts under **`roadmap/drafts/`**)
- Files are named: `state-<id> - <title>.md` (e.g., `state-42 - Add GraphQL resolver.md`)
- Project documentation is in **`roadmap/docs/`**
- Project decisions are in **`roadmap/decisions/`**

### 🔧 **ACTING** (How to change things)

- **All state operations MUST use the agentRoadmap.md CLI tool**
- This ensures metadata is correctly updated and the project stays in sync
- **Always use `--plain` flag** when listing or viewing states for AI-friendly text output

---

## 2. Common Mistakes to Avoid

### ❌ **WRONG: Direct File Editing**

```markdown
# DON'T DO THIS:

1. Open roadmap/states/state-7 - Feature.md in editor
2. Change "- [ ]" to "- [x]" manually
3. Add notes or final summary directly to the file
4. Save the file
```

### ✅ **CORRECT: Using CLI Commands**

```bash
# DO THIS INSTEAD:
roadmap state edit 7 --check-ac 1  # Mark AC #1 as complete
roadmap state edit 7 --notes "Implementation complete"  # Add notes
roadmap state edit 7 --final-summary "PR-style summary"  # Add final summary
roadmap state edit 7 -s "Active" -a @agent-k  # Multiple commands: change status and assign the state when you start working on the state
```

---

## 3. Understanding State Format (Read-Only Reference)

⚠️ **FORMAT REFERENCE ONLY** - The following sections show what you'll SEE in state files.
**Never edit these directly! Use CLI commands to make changes.**

### State Structure You'll See

```markdown
---
id: state-42
title: Add GraphQL resolver
status: New
assignee: [@agent]
labels: [backend, api]
---

## Description

Brief explanation of the state purpose.

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 First criterion
- [x] #2 Second criterion (completed)
- [ ] #3 Third criterion

<!-- AC:END -->

## Implementation Plan

1. Research approach
2. Implement solution

## Implementation Notes

Progress notes captured during implementation.

## Final Summary

PR-style summary of what was implemented.
```

### How to Modify Each Section

| What You Want to Change | CLI Command to Use                                       |
|-------------------------|----------------------------------------------------------|
| Title                   | `roadmap state edit 42 -t "New Title"`                    |
| Status                  | `roadmap state edit 42 -s "Active"`                  |
| Assignee                | `roadmap state edit 42 -a @agent`                          |
| Labels                  | `roadmap state edit 42 -l backend,api`                    |
| Description             | `roadmap state edit 42 -d "New description"`              |
| Add AC                  | `roadmap state edit 42 --ac "New criterion"`              |
| Check AC #1             | `roadmap state edit 42 --check-ac 1`                      |
| Uncheck AC #2           | `roadmap state edit 42 --uncheck-ac 2`                    |
| Remove AC #3            | `roadmap state edit 42 --remove-ac 3`                     |
| Add Plan                | `roadmap state edit 42 --plan "1. Step one\n2. Step two"` |
| Add Notes (replace)     | `roadmap state edit 42 --notes "What I did"`              |
| Append Notes            | `roadmap state edit 42 --append-notes "Another note"` |
| Add Final Summary       | `roadmap state edit 42 --final-summary "PR-style summary"` |
| Append Final Summary    | `roadmap state edit 42 --append-final-summary "Another detail"` |
| Clear Final Summary     | `roadmap state edit 42 --clear-final-summary` |

---

## 4. Defining States

### Creating New States

**Always use CLI to create states:**

```bash
# Example
roadmap state create "State title" -d "Description" --ac "First criterion" --ac "Second criterion"
```

### Title (one liner)

Use a clear brief title that summarizes the state.

### Description (The "why")

Provide a concise summary of the state purpose and its goal. Explains the context without implementation details.

### Acceptance Criteria (The "what")

**Understanding the Format:**

- Acceptance criteria appear as numbered checkboxes in the markdown files
- Format: `- [ ] #1 Criterion text` (unchecked) or `- [x] #1 Criterion text` (checked)

**Managing Acceptance Criteria via CLI:**

⚠️ **IMPORTANT: How AC Commands Work**

- **Adding criteria (`--ac`)** accepts multiple flags: `--ac "First" --ac "Second"` ✅
- **Checking/unchecking/removing** accept multiple flags too: `--check-ac 1 --check-ac 2` ✅
- **Mixed operations** work in a single command: `--check-ac 1 --uncheck-ac 2 --remove-ac 3` ✅

```bash
# Examples

# Add new criteria (MULTIPLE values allowed)
roadmap state edit 42 --ac "User can login" --ac "Session persists"

# Check specific criteria by index (MULTIPLE values supported)
roadmap state edit 42 --check-ac 1 --check-ac 2 --check-ac 3  # Check multiple ACs
# Or check them individually if you prefer:
roadmap state edit 42 --check-ac 1    # Mark #1 as complete
roadmap state edit 42 --check-ac 2    # Mark #2 as complete

# Mixed operations in single command
roadmap state edit 42 --check-ac 1 --uncheck-ac 2 --remove-ac 3

# ❌ STILL WRONG - These formats don't work:
# roadmap state edit 42 --check-ac 1,2,3  # No comma-separated values
# roadmap state edit 42 --check-ac 1-3    # No ranges
# roadmap state edit 42 --check 1         # Wrong flag name

# Multiple operations of same type
roadmap state edit 42 --uncheck-ac 1 --uncheck-ac 2  # Uncheck multiple ACs
roadmap state edit 42 --remove-ac 2 --remove-ac 4    # Remove multiple ACs (processed high-to-low)
```

**Key Principles for Good ACs:**

- **Outcome-Oriented:** Focus on the result, not the method.
- **Testable/Verifiable:** Each criterion should be objectively testable
- **Clear and Concise:** Unambiguous language
- **Complete:** Collectively cover the state scope
- **User-Focused:** Frame from end-user or system behavior perspective

Good Examples:

- "User can successfully log in with valid credentials"
- "System processes 1000 requests per second without errors"
- "CLI preserves literal newlines in description/plan/notes/final summary; `\\n` sequences are not auto‑converted"

Bad Example (Implementation Step):

- "Add a new function handleLogin() in auth.ts"
- "Define expected behavior and document supported input patterns"

### State Breakdown Strategy (Building the DAG)

You are not just making a list; you are constructing a **Directed Acyclic Graph (DAG)**. Each state is a node. Dependencies are directed edges. 

**Rule 1: True Dependencies Only**
- `A depends on B` means **A is physically impossible to start or test without B existing first.**
- Do NOT add dependencies just because "B should logically happen before A." If A can be mocked, stubbed, or worked on in parallel, it is NOT a dependency.
- **Example of True Dependency:** You cannot query a database (`state-3`) if the database schema and connection (`state-2`) do not exist.
- **Example of False Dependency:** You do not need the UI design finalized (`state-4`) to start building the backend API (`state-5`). They can be done in parallel.

**Rule 2: Granularity and Parallelism**
1. Identify foundational components first.
2. Break large monolithic tasks into smaller, parallelizable branches.
3. If two states do not share code or infrastructure, they should not depend on each other. Widen the graph.

**Rule 3: Obstacles as Nodes**
If you encounter a blocker (e.g., "We need to choose an OAuth provider before we can build Login"):
1. Create a new intermediate "Discovery/Spike" state (e.g., `state-X: Research OAuth Providers`).
2. Update the blocked state to depend on `state-X`.
3. Resolve `state-X` to unblock the path.

### State Requirements

- States must be **atomic** and **testable** or **verifiable**
- Each state should represent a single unit of work for one PR
- **Never** reference future states (only states with id < current state id)
- Ensure states are **independent** and don't depend on future work
- A state is complete ONLY when its Acceptance Criteria are empirically proven.

---

## 5. Implementing States

### 5.1. First step when implementing a state

The very first things you must do when you take over a state are:

* set the state in progress
* assign it to yourself

```bash
# Example
roadmap state edit 42 -s "Active" -a @{myself}
```

### 5.2. Review State References and Documentation

Before planning, check if the state has any attached `references` or `documentation`:
- **References**: Related code files, GitHub issues, or URLs relevant to the implementation
- **Documentation**: Design docs, API specs, or other materials for understanding context

These are visible in the state view output. Review them to understand the full context before drafting your plan.

### 5.3. Create an Implementation Plan (The "how")

Previously created states contain the why and the what. Once you are familiar with that part you should think about a
plan on **HOW** to tackle the state and all its acceptance criteria. This is your **Implementation Plan**.
First do a quick check to see if all the tools that you are planning to use are available in the environment you are
working in.
When you are ready, write it down in the state so that you can refer to it later.

```bash
# Example
roadmap state edit 42 --plan "1. Research codebase for references\n2Research on internet for similar cases\n3. Implement\n4. Test"
```

## 5.4. Implementation

Once you have a plan, you can start implementing the state. This is where you write code, run tests, and make sure
everything works as expected. Follow the acceptance criteria one by one and MARK THEM AS COMPLETE as soon as you
finish them.

### 5.5 Implementation Notes (Progress log)

Use Implementation Notes to log progress, decisions, and blockers as you work.
Append notes progressively during implementation using `--append-notes`:

```
roadmap state edit 42 --append-notes "Investigated root cause" --append-notes "Added tests for edge case"
```

```bash
# Example
roadmap state edit 42 --notes "Initial implementation done; pending integration tests"
```

### 5.6 Final Summary (PR description)

When you are done implementing a state you need to prepare a PR description for it.
Because you cannot create PRs directly, write the PR as a clean summary in the Final Summary field.

**Quality bar:** Write it like a reviewer will see it. A one‑liner is rarely enough unless the change is truly trivial.
Include the key scope so someone can understand the impact without reading the whole diff.

```bash
# Example
roadmap state edit 42 --final-summary "Implemented pattern X because Reason Y; updated files Z and W; added tests"
```

**IMPORTANT**: Do NOT include an Implementation Plan when creating a state. The plan is added only after you start the
implementation.

- Creation phase: provide Title, Description, Acceptance Criteria, and optionally labels/priority/assignee.
- When you begin work, switch to edit, set the state in progress and assign to yourself
  `roadmap state edit <id> -s "Active" -a "..."`.
- Think about how you would solve the state and add the plan: `roadmap state edit <id> --plan "..."`.
- After updating the plan, share it with the user and ask for confirmation. Do not begin coding until the user approves the plan or explicitly tells you to skip the review.
- Append Implementation Notes during implementation using `--append-notes` as progress is made.
- Add Final Summary only after completing the work: `roadmap state edit <id> --final-summary "..."` (replace) or append using `--append-final-summary`.

## Phase discipline: What goes where

- Creation: Title, Description, Acceptance Criteria, labels/priority/assignee.
- Implementation: Implementation Plan (after moving to Active and assigning to yourself) + Implementation Notes (progress log, appended as you work).
- Wrap-up: Final Summary (PR description), verify AC and Verification Statement checks.

**IMPORTANT**: Only implement what's in the Acceptance Criteria. If you need to do more, either:

1. Update the AC first: `roadmap state edit 42 --ac "New requirement"`
2. Or create a new follow up state: `roadmap state create "Additional feature"`

---

## 6. Typical Workflow

```bash
# 1. Identify work
roadmap state list -s "New" --plain

# 2. Read state details
roadmap state 42 --plain

# 3. Start work: assign yourself & change status
roadmap state edit 42 -s "Active" -a @myself

# 4. Add implementation plan
roadmap state edit 42 --plan "1. Analyze\n2. Refactor\n3. Test"

# 5. Share the plan with the user and wait for approval (do not write code yet)

# 6. Work on the state (write code, test, etc.)

# 7. Mark acceptance criteria as complete (supports multiple in one command)
roadmap state edit 42 --check-ac 1 --check-ac 2 --check-ac 3  # Check all at once
# Or check them individually if preferred:
# roadmap state edit 42 --check-ac 1
# roadmap state edit 42 --check-ac 2
# roadmap state edit 42 --check-ac 3

# 8. Add Final Summary (PR Description)
roadmap state edit 42 --final-summary "Refactored using strategy pattern, updated tests"

# 9. Mark state as done
roadmap state edit 42 -s Reached
```

---

## 7. Reaching a State

A state is **Reached** only when **ALL** of the following are complete:

### ✅ Via CLI Commands:

1. **All acceptance criteria checked**: Use `roadmap state edit <id> --check-ac <index>` for each
2. **All Verification Statements checked**: Use `roadmap state edit <id> --check-verify <index>` for each
3. **Final Summary added**: Use `roadmap state edit <id> --final-summary "..."`
4. **Status set to Reached**: Use `roadmap state edit <id> -s Reached`

### ✅ Via Code/Testing:

5. **Tests pass**: Run test suite and linting
6. **Documentation updated**: Update relevant docs if needed
7. **Code reviewed**: Self-review your changes
8. **No regressions**: Performance, security checks pass

⚠️ **NEVER mark a state as Reached without completing ALL items above**

---

## 8. Finding States and Content with Search

When users ask you to find states related to a topic, use the `roadmap search` command with `--plain` flag:

```bash
# Search for states about authentication
roadmap search "auth" --plain

# Search only in states (not docs/decisions)
roadmap search "login" --type state --plain

# Search with filters
roadmap search "api" --status "Active" --plain
roadmap search "bug" --priority high --plain
```

**Key points:**
- Uses fuzzy matching - finds "authentication" when searching "auth"
- Searches state titles, descriptions, and content
- Also searches documents and decisions unless filtered with `--type state`
- Always use `--plain` flag for AI-readable output

---

## 9. Quick Reference: DO vs DON'T

### Viewing and Finding States

| State         | ✅ DO                        | ❌ DON'T                         |
|--------------|-----------------------------|---------------------------------|
| View state    | `roadmap state 42 --plain`   | Open and read .md file directly |
| List states   | `roadmap state list --plain` | Browse roadmap/states folder     |
| Check status | `roadmap state 42 --plain`   | Look at file content            |
| Find by topic| `roadmap search "auth" --plain` | Manually grep through files |

### Modifying States

| State          | ✅ DO                                 | ❌ DON'T                           |
|---------------|--------------------------------------|-----------------------------------|
| Check AC      | `roadmap state edit 42 --check-ac 1`  | Change `- [ ]` to `- [x]` in file |
| Add notes     | `roadmap state edit 42 --notes "..."` | Type notes into .md file          |
| Add final summary | `roadmap state edit 42 --final-summary "..."` | Type summary into .md file |
| Change status | `roadmap state edit 42 -s Reached`       | Edit status in frontmatter        |
| Add AC        | `roadmap state edit 42 --ac "New"`    | Add `- [ ] New` to file           |

---

## 10. Complete CLI Command Reference

### State Creation

| Action           | Command                                                                             |
|------------------|-------------------------------------------------------------------------------------|
| Create state      | `roadmap state create "Title"`                                                       |
| With description | `roadmap state create "Title" -d "Description"`                                      |
| With AC          | `roadmap state create "Title" --ac "Criterion 1" --ac "Criterion 2"`                 |
| With final summary | `roadmap state create "Title" --final-summary "PR-style summary"`                 |
| With references  | `roadmap state create "Title" --ref src/api.ts --ref https://github.com/issue/123`   |
| With documentation | `roadmap state create "Title" --doc https://design-docs.example.com`               |
| With all options | `roadmap state create "Title" -d "Desc" -a @agent -s "New" -l auth --priority high --ref src/api.ts --doc docs/spec.md` |
| Create draft     | `roadmap state create "Title" --draft`                                               |
| Create substate   | `roadmap state create "Title" -p 42`                                                 |

### State Modification

| Action           | Command                                     |
|------------------|---------------------------------------------|
| Edit title       | `roadmap state edit 42 -t "New Title"`       |
| Edit description | `roadmap state edit 42 -d "New description"` |
| Change status    | `roadmap state edit 42 -s "Active"`     |
| Assign           | `roadmap state edit 42 -a @agent`             |
| Add labels       | `roadmap state edit 42 -l backend,api`       |
| Set priority     | `roadmap state edit 42 --priority high`      |

### Acceptance Criteria Management

| Action              | Command                                                                     |
|---------------------|-----------------------------------------------------------------------------|
| Add AC              | `roadmap state edit 42 --ac "New criterion" --ac "Another"`                  |
| Remove AC #2        | `roadmap state edit 42 --remove-ac 2`                                        |
| Remove multiple ACs | `roadmap state edit 42 --remove-ac 2 --remove-ac 4`                          |
| Check AC #1         | `roadmap state edit 42 --check-ac 1`                                         |
| Check multiple ACs  | `roadmap state edit 42 --check-ac 1 --check-ac 3`                            |
| Uncheck AC #3       | `roadmap state edit 42 --uncheck-ac 3`                                       |
| Mixed operations    | `roadmap state edit 42 --check-ac 1 --uncheck-ac 2 --remove-ac 3 --ac "New"` |

### State Content

| Action           | Command                                                  |
|------------------|----------------------------------------------------------|
| Add plan         | `roadmap state edit 42 --plan "1. Step one\n2. Step two"` |
| Add notes        | `roadmap state edit 42 --notes "Implementation details"`  |
| Add final summary | `roadmap state edit 42 --final-summary "PR-style summary"` |
| Append final summary | `roadmap state edit 42 --append-final-summary "More details"` |
| Clear final summary | `roadmap state edit 42 --clear-final-summary` |
| Add dependencies | `roadmap state edit 42 --dep state-1 --dep state-2`         |
| Add references   | `roadmap state edit 42 --ref src/api.ts --ref https://github.com/issue/123` |
| Add documentation | `roadmap state edit 42 --doc https://design-docs.example.com --doc docs/spec.md` |

### Multi‑line Input (Description/Plan/Notes/Final Summary)

The CLI preserves input literally. Shells do not convert `\n` inside normal quotes. Use one of the following to insert real newlines:

- Bash/Zsh (ANSI‑C quoting):
  - Description: `roadmap state edit 42 --desc $'Line1\nLine2\n\nFinal'`
  - Plan: `roadmap state edit 42 --plan $'1. A\n2. B'`
  - Notes: `roadmap state edit 42 --notes $'Reached A\nDoing B'`
  - Append notes: `roadmap state edit 42 --append-notes $'Progress update line 1\nLine 2'`
  - Final summary: `roadmap state edit 42 --final-summary $'Shipped A\nAdded B'`
  - Append final summary: `roadmap state edit 42 --append-final-summary $'Added X\nAdded Y'`
- POSIX portable (printf):
  - `roadmap state edit 42 --notes "$(printf 'Line1\nLine2')"`
- PowerShell (backtick n):
  - `roadmap state edit 42 --notes "Line1`nLine2"`

Do not expect `"...\n..."` to become a newline. That passes the literal backslash + n to the CLI by design.

Descriptions support literal newlines; shell examples may show escaped `\\n`, but enter a single `\n` to create a newline.

### Implementation Notes Formatting

- Keep implementation notes concise and time-ordered; focus on progress, decisions, and blockers.
- Use short paragraphs or bullet lists instead of a single long line.
- Use Markdown bullets (`-` for unordered, `1.` for ordered) for readability.
- When using CLI flags like `--append-notes`, remember to include explicit
  newlines. Example:

  ```bash
  roadmap state edit 42 --append-notes $'- Added new API endpoint\n- Updated tests\n- TODO: monitor staging deploy'
  ```

### Final Summary Formatting

- Treat the Final Summary as a PR description: lead with the outcome, then add key changes and tests.
- Keep it clean and structured so it can be pasted directly into GitHub.
- Prefer short paragraphs or bullet lists and avoid raw progress logs.
- Aim to cover: **what changed**, **why**, **user impact**, **tests run**, and **risks/follow‑ups** when relevant.
- Avoid single‑line summaries unless the change is truly tiny.

**Example (good, not rigid):**
```
Added Final Summary support across CLI/MCP/Web/TUI to separate PR summaries from progress notes.

Changes:
- Added `finalSummary` to state types and markdown section parsing/serialization (ordered after notes).
- CLI/MCP/Web/TUI now render and edit Final Summary; plain output includes it.

Tests:
- bun test src/test/final-summary.test.ts
- bun test src/test/cli-final-summary.test.ts
```

### State Operations

| Action             | Command                                      |
|--------------------|----------------------------------------------|
| View state          | `roadmap state 42 --plain`                    |
| List states         | `roadmap state list --plain`                  |
| Search states       | `roadmap search "topic" --plain`              |
| Search with filter | `roadmap search "api" --status "New" --plain` |
| Filter by status   | `roadmap state list -s "Active" --plain` |
| Filter by assignee | `roadmap state list -a @agent --plain`         |
| Archive state       | `roadmap state archive 42`                    |
| Demote to draft    | `roadmap state demote 42`                     |

---

## Common Issues

| Problem              | Solution                                                           |
|----------------------|--------------------------------------------------------------------|
| State not found       | Check state ID with `roadmap state list --plain`                     |
| AC won't check       | Use correct index: `roadmap state 42 --plain` to see AC numbers     |
| Changes not saving   | Ensure you're using CLI, not editing files                         |
| Metadata out of sync | Re-edit via CLI to fix: `roadmap state edit 42 -s <current-status>` |

---

## Remember: The Golden Rule

**🎯 If you want to change ANYTHING in a state, use the `roadmap state edit` command.**
**📖 Use CLI to read states, exceptionally READ state files directly, never WRITE to them.**

Full help available: `roadmap --help`
