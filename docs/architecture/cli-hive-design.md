> **Type:** architecture  
> **MCP-tracked:** P456 (CLI redesign — `hive` replaces `roadmap`)  
> **Source-of-truth:** This file

# AgentHive `hive` CLI Architecture & Design

## Status

**Final design** for the `hive` CLI (successor to legacy `roadmap` CLI). This document is **authoritative** for implementation. Implementation is proposal-driven; see P456.

## 1. Command Tree (Definitive)

### Structure & Principles

- **Two levels**: domain (noun) + action (verb): `hive proposal create`, `hive workflow show`.
- **Top-level verbs**: only for universal entry points (`init`, `status`, `help`, `version`, `completion`).
- **Format contract**: all commands support `--format text|json|jsonl|yaml|sarif` (default `text`); `--quiet` suppresses output.
- **Context resolution**: explicit flag → `HIVE_*` env → CWD-derived → control-plane default.
- **No streamy/conversational verbs**: `talk`, `chat`, `listen`, `orchestrate` are moved to TUI (`hive board`) or web UI, not CLI.

### Full Command Tree

#### Universal (root level)

```
hive                          Print context + domain map (6-10 lines, helps discovery)
hive --help                   Full command tree, grouped by domain
hive --version                Show CLI version + API version
hive init                     Register project in control plane, seed proposals, set governance
hive status [--project P]     Project-scoped operational status (proposals by state, leases, active dispatches)
hive help <topic>             Longer-form help (topics: workflows, recipes, context, credentials)
hive completion <shell>       bash | zsh | fish | powershell script generation
```

#### Project Lifecycle

```
hive project info [--project P]
  Show project metadata, repo roots, database DSN summary, active workforce

hive project register [--name N] [--repo PATH] [--db-host H] [--db-port P]
  Register a new project in agenthive_control (requires control-plane access)

hive project archive [--project P] [--yes]
  Soft-delete a project (mark archived, do not delete DB). Requires --yes.

hive project list [--status active|archived|all]
  List all projects (control-plane admin only, or filter to user subscriptions)
```

#### Proposal CRUD + Lifecycle

```
hive proposal create [--type product|component|feature|issue|hotfix] [--title T] [--body B|--stdin]
  Create a proposal in current project. Opens editor if no --title/--body.
  Types: product (design), component (design), feature (impl), issue (impl), hotfix (ops).
  Exit code: 0=ok, 1=usage, 2=type-unknown.

hive proposal get P### [--include leases|dispatches|events|reviews|ac] [--raw]
  Fetch proposal full state. --include builds detailed sections. --raw prints raw MCP response.

hive proposal list [--state DRAFT|REVIEW|DEVELOP|MERGE|COMPLETE] [--type T] [--owner AGENCY] [--limit 20] [--cursor C]
  List proposals. Filters stack with AND. --limit and --cursor for pagination. Default: 20 items.
  JSON includes next_cursor for pagination. Exit code 2 if not-found, 1 if state/type invalid.

hive proposal search <QUERY> [--limit 20] [--offset O]
  Full-text search (title + body). Uses control-plane pgvector search.
  Returns proposals + knowledge-base matches in one list.

hive proposal edit P### [--title T] [--body B|--stdin] [--type NEW_TYPE]
  Update proposal title, body, or type. Requires lease or ownership.

hive proposal claim P### [--duration-minutes 120]
  Acquire a work lease (lock). Default 120 min. Lease must be active to transition state.
  Requires project access. Exit code 3=permission, 4=conflict (already leased).

hive proposal release P### [--with-message "Done with review phase"]
  Release a lease early. Discards draft edits. --with-message goes into discussion.

hive proposal transition P### <NEW_STATE> [--with-message M|--stdin]
  Move proposal between workflow states (DRAFT→REVIEW→DEVELOP→MERGE→COMPLETE per RFC).
  State names come from control plane (P453). Must have active lease.
  --with-message adds a discussion entry explaining the transition.

hive proposal maturity P### <new|active|mature|obsolete> [--with-message M]
  Set maturity within the current state. Mature = ready for gate decision.
  Obsolete = longer relevant (marked for cleanup, not terminal).

hive proposal depend P### --on P### [--type blocks|blocked-by|relates-to] [--with-message M]
  Add a DAG dependency edge. Validates no cycles. Emits MCP edge.

hive proposal ac add P### <AC-ID> [--body B|--stdin] [--verification-type manual|test|script]
  Add acceptance criterion. AC-ID is a human-readable slug (e.g. "ac-001-schema-compat").
  --verification-type: how AC gets verified (one proposal may mix types).

hive proposal ac list P### [--status pending|satisfied|failed]
  List ACs for a proposal. --status filters by verification state.

hive proposal ac verify P### <AC-ID> [--status satisfied|failed] [--log|--evidence-url URL] [--with-message M]
  Mark AC as satisfied/failed. Requires leadership role or reviewer permission.
  --log adds attached evidence. --evidence-url links to external (PR, test run, etc.).

hive proposal review P### [--ready-for-merge|--recommend-draft] [--focus DOMAIN] [--with-message M|--stdin]
  Submit a gating review. Leadership or reviewer role required.
  Options: ready-for-merge, recommend-draft, recommend-enhanced, etc.
  --focus allows domain-specific review (e.g., --focus security, --focus performance).

hive proposal discuss P### <CONTEXT_PREFIX> [--body B|--stdin]
  Add a discussion entry. CONTEXT_PREFIX: e.g., "ship-verification:", "gate-decision:", "handoff:", "research:".
  Body goes into the durable discussion thread; survives proposal handoff.

hive proposal show P### [--include full|leases|dispatches|runs|events|versions]
  Alias for `get`. Human-friendly default format (text). --include builds sections.
```

#### Workflow & State Inspection

```
hive workflow list [--project P]
  List all workflow templates in control plane. Shows RFC, hotfix, custom.

hive workflow show <TEMPLATE> [--project P]
  Show the state machine for a template (states, valid transitions, maturity rules, gate criteria).
  Examples: hive workflow show rfc, hive workflow show hotfix.
  Used to discover valid state names (P453).

hive workflow gates [--project P] [--state STATE]
  Show gating rules and acceptance criteria schema for workflow states.
  Helps understand gate entry/exit criteria before proposing state transition.

hive state next P### [--verbose]
  Show the next valid states for a proposal in its current state.
  Used to prevent invalid transitions before attempting `proposal transition`.

hive state history P### [--limit 10]
  Show state transitions, maturity changes, and leases over time.
  Helps debug why a proposal is stuck or retrying.
```

#### Documents & Governance

```
hive doc list [--project P] [--type architecture|governance|reference|research] [--limit 20] [--cursor C]
  List tracked documents in control plane. Includes docs/, governance/, architecture/ trees.

hive doc get <DOC_ID|PATH> [--project P] [--raw]
  Fetch document content. Path examples: governance/CONVENTIONS.md, architecture/multi-project.md.
  DOC_ID: internal control-plane ID.

hive doc sync [--project P] [--from-git|--from-control] [--verify]
  One-way sync: from-git pushes docs to control plane; from-control pulls to git.
  --verify: syntax check and link validation. Default: read-only summary (exit code 0=no-changes, 1=error).

hive decision record P### [--title T] [--body B|--stdin] [--adr-format]
  Create a decision record for a proposal ADR-style. Stored in control plane discussion thread.
  --adr-format: generates ADR template (status, context, decision, consequences, alternatives).

hive decision list [--project P] [--proposal P###] [--limit 20] [--cursor C]
  List all decision records across proposals (control-plane governance feed).
```

#### Workforce & Agency Operations (read-only for non-ops)

```
hive agency list [--project P] [--status active|draining|offline] [--limit 20]
  List agencies. Requires at least read permission on the project.

hive agency info <AGENCY_ID> [--project P] [--include subscriptions|leases|runs]
  Show agency metadata, subscriptions, current leases, and recent runs.

hive worker list [--project P] [--agency A] [--limit 20] [--cursor C]
  List workers (per-dispatch ephemeral execution identities). Scope to agency/project.
  Shows: worker ID, dispatch ID, status, claimed model, started_at, completed_at.

hive worker show <WORKER_ID> [--include runs|errors|context|toolsets]
  Show worker context, actual model and route used, toolsets loaded, cumulative tokens, error log.

hive lease list [--project P] [--state active|expired|released] [--proposal P###] [--limit 20] [--cursor C]
  List active work leases. Filter by state, proposal, or agency.

hive lease release <LEASE_ID> [--force] [--with-message M]
  Release a lease. Requires ownership or op privilege. --force to release expired leases too.
```

#### Provider / Model / Route Inspection

```
hive provider list [--project P] [--status active|deprecated|disabled]
  List configured AI providers (Anthropic, OpenAI, Xiaomi, etc.).

hive provider show <PROVIDER> [--include accounts|models|rates]
  Show provider metadata, configured accounts, and pricing tiers.

hive model list [--provider PROV] [--capability CODE_GEN|REASONING|VISION|...] [--limit 20] [--cursor C]
  List models in catalog. Filter by provider and capability tags.
  Shows: model name, context window, output limit, cost tier, status.

hive model show <MODEL_NAME>
  Show model metadata, capabilities, context window, token costs, and available routes.

hive route list [--project P] [--model M] [--host HOST] [--enabled-only] [--limit 20]
  List model routes (executable provider+model+account+host+toolsets bindings).
  Shows: route ID, model, provider, host affinity, priority, is_default, is_enabled, cost.

hive route show <ROUTE_ID> [--project P] [--include toolsets|host-policy|context-policy]
  Show route configuration, toolsets, host policy, and context policy.

hive route toggle <ROUTE_ID> --enable|--disable [--yes]
  Enable or disable a route (ops/admin only). Requires --yes.

hive route test <ROUTE_ID> [--project P] [--input-tokens 100] [--output-tokens 50]
  Smoke-test a route (ping + model capability check). Simulates token usage (does not spend).
  Useful for diagnosing "no routes available" errors.

hive budget show [--project P] [--scope global|project|agency|proposal|dispatch]
  Show budget caps, spend, burn rate, and TTL. Scopes nest: global > project > agency > proposal > dispatch.
  Shows: limit, used, remaining, daily_reset_at, soft_warning_pct.

hive budget set --scope S --limit L [--soft-warning PCTL] [--project P] [--yes]
  Set budget cap for a scope. Requires op/admin role. --yes to skip confirmation.
  Exit code 3=permission, 4=scope-conflict.
```

#### Dispatch & Queue Inspection

```
hive dispatch list [--project P] [--proposal P###] [--state new|claimed|running|completed|failed] [--limit 20] [--cursor C]
  List dispatch events. One dispatch per (project, proposal, role, state) until terminal or reissued.
  Shows: dispatch ID, proposal, role, state, claimed_by (agency), model route used, created_at, expires_at.

hive dispatch show <DISPATCH_ID> [--project P] [--include events|runs|errors|audit]
  Show dispatch metadata and related run/error records.

hive offer list [--project P] [--agency A] [--state pending|accepted|rejected|expired] [--limit 20] [--cursor C]
  List work offers (dispatch edges not yet claimed). Shows: offer ID, proposal, required capabilities, expiry.

hive queue show [--project P] [--agency A]
  Show dispatch queue state for a project or agency: pending, claimed, running, terminal.
  Useful for understanding why work is stuck or dispatcher is overloaded.
```

#### Operator Stop / Cancel

```
hive stop dispatch <DISPATCH_ID> [--project P] [--reason R] [--yes]
  Cancel a single dispatch (no retry). Proposal stays in its state.
  Requires op/admin. --yes to skip confirmation. --reason recorded in audit log.

hive stop proposal P### [--project P] [--reason R] [--yes]
  Cancel all active dispatches for a proposal. Proposal transitions to a terminal or error state.
  Requires op/admin. --yes. --reason in audit.

hive stop agency <AGENCY_ID> [--reason R] [--drain] [--yes]
  Suspend an agency. --drain: complete in-flight work before marking offline.
  Requires op/admin.

hive stop host <HOST_ID> [--reason R] [--drain] [--yes]
  Drain or offline a host. --drain: finish running processes. Used for maintenance.
  Requires op/admin.

hive stop worker <WORKER_ID> [--reason R] [--escalate-to-dispatch] [--yes]
  Kill a single worker. --escalate-to-dispatch: retry the dispatch on different worker.
  Requires op/admin.

hive stop route <ROUTE_ID> [--reason R] [--yes]
  Disable a route temporarily (does not cancel in-flight work).
  Requires op/admin.
```

#### Service & System Ops

```
hive service list [--project P] [--host HOST] [--status running|failed|inactive|restarting]
  List systemd services. Filter by project, host, or status.
  Shows: service name, type (mcp-server, orchestrator, etc.), host, status, last_checked_at.

hive service status <SERVICE_NAME> [--host HOST]
  Show detailed service status, process PID, uptime, resource usage, last error.

hive service restart <SERVICE_NAME> [--host HOST] [--wait-for-ready] [--yes]
  Restart a service via systemd. --wait-for-ready blocks until service reports healthy.
  Requires op/sudo privilege on the host.

hive service logs <SERVICE_NAME> [--host HOST] [--lines 50] [--follow] [--since 1h]
  Tail service logs (journalctl proxy). --follow streams. --since filters by time.

hive mcp ping [--timeout 5]
  Ping the MCP server. Returns latency and server version.
  Exit code 5=remote-failure if timeout or unreachable.

hive mcp smoke [--project P] [--include health|tool-availability|schema-version]
  Run MCP readiness checks (toolset availability, schema compatibility, auth, etc.).
  Shows: [OK] tool category, [WARN] degraded capability, [ERROR] blocker.

hive mcp health [--json]
  Get MCP server health: status, version, connected services, heartbeat uptime.

hive db migrate [--project P|--control] [--up|--down] [--target VER] [--verify] [--yes]
  Apply pending database migrations. --up=apply, --down=rollback. Requires DB privilege.
  --verify runs post-migration checks. --yes skips safety confirmation.
  Exit code 2=no-migrations, 1=migration-failed.

hive db check [--project P|--control]
  Diagnose DB issues: connection, schema version mismatch, hanging transactions, bloat.

hive cubic list [--host HOST] [--status active|idle|failed]
  List cubic execution environments (isolated worktrees + resource cages).
  Shows: cubic ID, host, agent count, worktree path, resource limits, created_at.

hive cubic clean [--host HOST] [--older-than 24h] [--yes]
  Remove stale cubics (after successful merge or > 24h). --yes to skip confirmation.

hive cubic repair <CUBIC_ID> [--host HOST]
  Diagnose and attempt to repair a broken cubic (hung worktree, orphaned process, etc.).
```

#### Audit & Observability

```
hive audit feed [--project P] [--since 1h|--from DATE] [--limit 100] [--cursor C]
  Operational audit log: proposal transitions, lease changes, dispatch lifecycle, cancellations, auth failures.
  Shows: timestamp, agent, action, resource (proposal, dispatch, etc.), status, reason.

hive audit events [--project P] [--resource-type proposal|dispatch|agency|route] [--resource-id ID] [--limit 100]
  Scoped event stream (subset of feed). Filter by resource type and ID.

hive metrics show [--project P] [--scope project|agency|proposal] [--metric tokens|cost|cache-hit|wall-clock] [--window 24h]
  Show aggregated metrics: token consumption, cost per project/agency, cache hit rates, proposal cycle time.
  Metrics are read-only (computed from run ledger). Not for individual billing.

hive report run [--project P] [--report-type efficiency|spending|proposal-health|workforce] [--output-format text|csv|json] [--since 7d]
  Generate an aggregated report. Types: efficiency (tokens/proposal, cache stats), spending (cost by agency/model/route),
  proposal-health (median cycle time, stuck proposals), workforce (agency utilization, dispatch success rate).
```

#### Scan / Quality & Linting

```
hive scan [--project P] [--type hardcoding|secrets|performance|all] [--git-staged|--git-diff BASE] [--fail-on high|medium|low] [--json]
  Run static analysis (hardcoding scanner P454, secrets detector, perf hints).
  --git-staged: scan staged files only. --git-diff: diff against base branch.
  --fail-on LEVEL: exit code 5 if issues >= LEVEL found.
  Finds: hardcoded paths (/data/code/AgentHive), hardcoded models, hardcoded state names, API keys in comments.

hive lint [--project P] [--fix] [--strict]
  Run eslint + tsc on the project root. --fix applies auto-fixes. --strict=extra rules.
  Proxy to npm run lint / npm run typecheck. Non-zero exit if errors.
```

#### Knowledge & Memory

```
hive kb add --title T [--body B|--stdin] [--tags T1,T2] [--project P]
  Add knowledge to team knowledge base (persisted pgvector embeddings in control plane).
  Callable by MCP tools for proposal search/context building.

hive kb search <QUERY> [--project P] [--limit 10] [--confidence MIN_SCORE]
  Vector search the KB. Returns (pattern, decision, context, source-proposal).
  Confidence threshold (0–1) filters by relevance score.

hive memory show [--agent AGENCY] [--project P] [--keys PATTERN]
  Show agent/team memory KV store (session-persistent). Keys are namespaced (e.g., myagency:key-name).

hive memory set <KEY> <VALUE> [--agent AGENCY] [--project P]
  Set memory value (string or JSON). Scoped to agency and project.

hive memory delete <KEY> [--agent AGENCY] [--project P]
  Delete a memory key.
```

#### Doctor / Diagnostics

```
hive doctor [--project P] [--fix] [--verbose]
  Run full readiness suite (per P446). Checks: DB connection, MCP health, control-plane sync,
  service health, host policy, route availability, budget coherence, Git worktree sanity, schema versions.
  Reports [OK], [WARN], [ERROR] per check. --fix attempts remediation. --verbose shows details.
  Exit code: 0=healthy, 1=warnings-only, 5=errors (cannot proceed).
```

#### Board & UI Launchers

```
hive board [--project P] [--theme dark|light]
  Launch the TUI dashboard. Shows: proposals by state, active leases, dispatches, metrics, command palette.
  --theme overrides default (respects NO_COLOR env).
  Opened in a tmux session; `tmux kill-session -t hive` to close.

hive web [--project P] [--browser] [--port 3000]
  Start the web dashboard (Node.js dev server). Shows same views as TUI in web form.
  --browser: open default browser. --port: listen on custom port. Runs in foreground; Ctrl+C to stop.

hive tui                      Alias for `hive board`.
```

#### Completion & Version

```
hive completion bash|zsh|fish|powershell [--install]
  Generate shell completion script. --install: write to system completion dir (requires shell-specific setup).
  Examples: eval "$(hive completion bash)", source <(hive completion zsh).

hive version [--json]
  Show CLI version, API version, MCP version, DB schema version.
  --json: machine-readable output.

hive help [<topic>]
  Print help. <topic>: workflows (state machine overview), recipes (multi-step task walkthroughs),
  context (how context resolution works), credentials (auth setup), formatting (--format details).
```

---

## 2. Cross-Cutting Conventions

### Context Resolution Order

Commands resolve the working context (project, agency, host) in this order:

1. **Explicit flag**: `--project P`, `--agency A`, `--host H` override everything.
2. **Environment**: `HIVE_PROJECT`, `HIVE_AGENCY`, `HIVE_HOST` env vars.
3. **CWD-derived**: infer from current git worktree or repo root (using `getProjectRoot()` from P448).
4. **Control-plane default**: fall back to user's primary project subscription in control plane.
5. **Fail fast**: if no context can be resolved, exit with code 2 (not-found) + clear message.

Examples:

```bash
# Explicit flag overrides everything
hive proposal list --project alpha  # List proposals for project "alpha"

# Env var if no flag
HIVE_PROJECT=beta hive proposal list

# CWD-derived if in /data/code/AgentHive (project root)
cd /data/code/AgentHive && hive proposal list  # Lists for AgentHive project

# Fall back to control plane default
hive proposal list  # Uses user's primary project from control plane
```

### Output Format Flag

**Universal flag**: `-o, --format text|json|jsonl|yaml|sarif` (default: `text` for TTY, `json` for non-TTY)

| Format | Use | Example |
| --- | --- | --- |
| **text** (default) | Human-friendly, colored, paginated. TTY only. | `hive proposal list` |
| **json** | One complete JSON object per list item or command output. AI-agent contract. | `hive proposal list --format json` |
| **jsonl** | One JSON object per line (streaming). Useful for piping/tailing. | `hive proposal list --format jsonl \| grep '"state":"DRAFT"'` |
| **yaml** | YAML format (popular in k8s/config tools). Useful for `hive doc sync`. | `hive proposal get P### --format yaml` |
| **sarif** | SARIF (Static Analysis Results Interchange Format). For `hive scan` output to CI/CD. | `hive scan --format sarif > results.sarif` |

**Quiet mode**: `--quiet, -q` suppresses all output except exit code.

```bash
hive proposal claim P### && echo "Claimed" || echo "Failed"  # With quiet: only exit code
hive proposal claim P### --quiet && echo "Claimed"
```

### Stable Exit Codes

| Code | Meaning | Examples |
| --- | --- | --- |
| **0** | Success | proposal created, state transitioned, lease acquired |
| **1** | Usage / invalid input | unknown command, invalid flag, malformed proposal ID, wrong type |
| **2** | Not found | proposal not found, workflow state not recognized, project not registered |
| **3** | Permission denied | no lease, not owning proposal, non-op tried `hive stop`, no DB access |
| **4** | Conflict | already leased, state transition blocked, budget exceeded, duplicate operation |
| **5** | Remote failure | MCP timeout, DB unreachable, service down, provider rate-limit |

### Pagination

Commands returning lists support:

- `--limit N` (default 20, max 100): number of items per page.
- `--cursor C` (optional): opaque token for next page (from previous `next_cursor` in JSON output).
- JSON output includes `next_cursor: "..."` and `has_more: true|false`.
- Text output shows "Page 1/5, next: hive proposal list --cursor abc123".

```bash
hive proposal list --limit 10 --format json | jq '.next_cursor'
hive proposal list --limit 10 --cursor abc123  # Next page
```

### Color & TTY Detection

- Respects `NO_COLOR=1` env var (disables all ANSI codes).
- Auto-detects TTY: if stdout is a pipe/file, disables color automatically.
- Text tables in non-TTY use ASCII instead of Unicode box-drawing.
- Log output from services (e.g., `hive service logs`) respects `--no-color` flag.

### Stdin Contracts

Commands that accept content (`proposal create`, `ac add`, `discuss`, `decision record`) support:

- `-` or `--stdin`: read from stdin instead of requiring --body or --editor.
- Useful for piping: `echo "My description" | hive proposal create --type issue --title "Bug" --stdin`.
- Editor mode if no flag/stdin: opens `$EDITOR` (default: nano, respects `.editorconfig`).

### State & Maturity Values

**NEVER hardcode state/maturity literals in command code.** All state names come from the control plane (P453).

Commands discover valid states at runtime:

```bash
hive workflow show rfc  # Shows: DRAFT, REVIEW, DEVELOP, MERGE, COMPLETE

hive proposal transition P### DRAFT  # State name validated against workflow template at runtime
hive proposal transition P### INVALID_STATE  # Exit code 2: "Invalid state. Valid states: DRAFT, REVIEW, ..."
```

Valid maturity values are always: `new`, `active`, `mature`, `obsolete`. No custom values.

### Confirmation Prompts

Destructive operations require confirmation:

```bash
hive project archive --project alpha  # Prompts: "Archive project alpha? (y/n)"
hive stop dispatch D123 --yes  # Skip prompt with --yes
hive cubic clean --yes  # Required for non-interactive

# Non-TTY without --yes = exit code 4 (conflict)
hive stop dispatch D123 < /dev/null  # Exit code 4: "Destructive operation requires --yes in non-TTY"
```

---

## 3. Hierarchical Help & Discoverability

### `hive` (no args)

Prints a one-screen context summary + domain map:

```
Project: agenthive (host: localhost, branch: main)
Agency: hermes@localhost

Proposals: 12 DRAFT, 3 REVIEW, 1 DEVELOP | hive proposal --help
Workflow:  RFC template (5 states) | hive workflow show rfc
Leases:    1 active (P123, expires in 2h) | hive lease list
Dispatch:  2 pending, 1 running | hive dispatch list

Quick start:
  hive proposal create --type issue          Create a new issue
  hive proposal list --state DRAFT            List all drafts
  hive board                                  Open TUI dashboard

See 'hive --help' for all commands.
```

### `hive --help`

Full command tree, grouped by domain (not alphabetical):

```
hive - AgentHive autonomous development platform

USAGE
  hive <domain> [options]

PROJECT LIFECYCLE
  hive project info                Register, archive, and manage projects
  hive project register
  hive project archive

PROPOSALS (Design & Implementation)
  hive proposal create             Create, edit, and inspect proposals
  hive proposal get
  hive proposal list
  ...

WORKFLOW & STATE (Lifecycle Progression)
  hive workflow list               Understand state machines and transitions
  hive workflow show
  hive state next

...

RUN 'hive help <topic>' FOR MORE INFO
  hive help workflows              Deep dive into proposal state machines
  hive help recipes                Copy-paste workflows (claim→develop→review→transition)
  hive help context                How context resolution works
  hive help credentials            Set up authentication (HIVE_MCP_URL, control-plane access, etc.)
  hive help formatting             Detailed --format examples
```

### `hive <domain> --help`

Domain-specific summary with a few example invocations:

```bash
hive proposal --help
```

```
hive proposal - Create, edit, list, and manage proposals

USAGE
  hive proposal <action> [options]

ACTIONS
  create                 Create a new proposal (type required)
  get P###               Fetch proposal details
  list                   List proposals (filterable by state, type, owner)
  search <QUERY>         Full-text search proposals
  edit P###              Update title, body, or type
  claim P### [--duration-minutes 120]    Acquire a work lease
  release P###           Release a lease
  transition P### <STATE>  Move to next workflow state (requires lease)
  maturity P### <new|active|mature|obsolete>   Set maturity
  depend P### --on P###  Add a dependency edge
  ac add P### <AC-ID>    Add acceptance criterion
  ac list P###           List all ACs (filterable by status)
  ac verify P### <AC-ID> Mark an AC as satisfied/failed
  review P###            Submit a gating review
  discuss P### <PREFIX>  Add a discussion entry (ship-verification:, gate-decision:, etc.)

EXAMPLES
  hive proposal create --type issue --title "CLI hardcoding bug"
  hive proposal list --state DRAFT
  hive proposal claim P123 --duration-minutes 240
  hive proposal transition P123 REVIEW --with-message "Moved to gate review"

See 'hive help recipes' for multi-step workflows.
```

### `hive help <topic>`

Extended help on common topics:

| Topic | Content |
| --- | --- |
| **workflows** | State machine overview, state names, maturity rules, RFC vs hotfix, gates & AC schema |
| **recipes** | Copy-paste command sequences: "capture a bug", "claim and develop", "operator stops runaway dispatch", "audit hardcoding before commit", "investigate stuck proposal" |
| **context** | How project/agency/host context is resolved, env vars, CWD resolution |
| **credentials** | Setting `HIVE_MCP_URL`, `HIVE_DB_*` env vars, control-plane access requirements |
| **formatting** | Detailed examples: json prettify, jsonl streaming, yaml templating, sarif for CI/CD |

---

## 4. Migration Strategy from `roadmap` CLI

### Mapping Table

| Roadmap Command | Hive Equivalent | Status | Notes |
| --- | --- | --- | --- |
| `roadmap init` | `hive init` | **Behavior change** | Now means project registration in control plane, not filesystem init. Warning on first run. |
| `roadmap proposal create` | `hive proposal create` | **Kept** | Unchanged semantics. |
| `roadmap proposal list` | `hive proposal list` | **Kept** | Unchanged. |
| `roadmap proposal get P###` | `hive proposal get P###` | **Kept** | Unchanged. |
| `roadmap draft` | `hive proposal create --type issue` | **Moved** | Subsumed into proposal create. |
| `roadmap talk` | **Moved to TUI**: `hive board` | **Removed** | Real-time chat → TUI / web. |
| `roadmap chat` | **Moved to TUI**: `hive board` | **Removed** | Real-time chat → TUI / web. |
| `roadmap listen` | **Moved to TUI**: `hive board` | **Removed** | Event stream → TUI board. |
| `roadmap orchestrate` | **Removed** | **Removed** | Orchestration is daemon-driven via control plane, not CLI-driven. |
| `roadmap browser` | **Moved to TUI**: `hive web` or `hive board` | **Removed** | Use `hive web` for browser or `hive board` for TUI. |
| `roadmap log` | **Integrated**: `hive dispatch list`, `hive audit feed` | **Removed** | Log viewing → dispatch/audit feeds. |
| `roadmap directive[s]` | **Removed** | **Removed** | Directives (milestones) were a legacy construct. Replaced by workflow states + maturity. |
| `roadmap decision` | `hive decision record` | **Renamed** | ADR-style decision capture → `hive decision record P### ...`. |
| `roadmap doc` | `hive doc list/get/sync` | **Kept** | Unchanged. |
| `roadmap config` | **Moved to TUI**: `hive board` settings panel | **Removed** | Config editing → TUI interactive mode. |
| `roadmap board` | `hive board` | **Kept** | Unchanged (TUI dashboard). |
| `roadmap agents` | `hive agency list`, `hive worker list` | **Renamed** | Agent listing → agency + worker commands. |
| `roadmap search` | `hive proposal search` | **Kept** | Unchanged. |
| `roadmap sequence[s]` | **Removed** | **Removed** | Sequences (workflow visualization) moved to TUI board. |
| `roadmap service` | `hive service list/status/restart/logs` | **Kept** | Service ops unchanged (admin only). |
| `roadmap completion` | `hive completion` | **Kept** | Shell completion unchanged. |
| `roadmap overview` | `hive status` | **Renamed** | Project overview → `hive status`. |
| `roadmap mcp` | `hive mcp ping/smoke/health` | **Kept** | MCP diagnostic commands unchanged. |
| `roadmap cubic` | `hive cubic list/clean/repair` | **Kept** | Cubic ops unchanged. |
| `roadmap sandbox` | **Removed or moved to TUI** | **Removed** | Sandbox execution → orchestrator + cubic controls. |
| `roadmap state-machine / sm` | `hive workflow show`, `hive state next` | **Renamed** | State machine inspection → `hive workflow`. |
| `roadmap cleanup` | **Removed** | **Removed** | Cleanup automation → orchestrator + proposals. |

### Deprecation & Grace Period

**Roadmap → Hive transition (months 1–2):**

1. `roadmap` binary becomes a thin wrapper that:
   - Emits a deprecation warning on every invocation: `"Warning: 'roadmap' is deprecated. Use 'hive' instead. See docs/deprecation.md."`
   - Maps kept commands to `hive` equivalents and forwards execution.
   - For removed commands, prints a redirect message: `"roadmap talk → Use 'hive board' instead."`

2. Scripts and CI/CD that use `roadmap` continue to work but get warnings.

3. Docs updated with migration guide: `/docs/reference/roadmap-to-hive-migration.md`.

**At month 3:**

- `roadmap` binary can be removed entirely (or kept as a permanent compatibility alias).
- Usage metrics inform decision.

### Behavior Changes & Warnings

1. **`hive init` behavior change**: Now registers project in control plane (requires control-plane connectivity). Old filesystem-init behavior is gone.
   - Warning on first run: `"Init now means 'register in control plane', not 'set up files locally'. Requires control-plane access."`

2. **No more `talk/chat/listen`**: Moved to TUI.
   - Helpful redirect: `"Use 'hive board' for real-time chat and event streams."`

3. **Config editing moved to TUI**: `hive config` → `hive board` settings panel.
   - Redirect: `"Use 'hive board' to edit config interactively, or 'hive --help' for CLI flags."`

---

## 5. Implementation Architecture

### Tech Stack & Framework

- **CLI Framework**: Commander.js (current dep, proven + stable).
- **Alternative considered**: Yargs (more minimal); Oclif (over-engineered for our needs). **Stick with Commander.**
- **Output formatters**: Custom formatters (text, json, jsonl, yaml, sarif) in `src/apps/hive-cli/common/formatters/`.
- **Transport**: All MCP-backed commands route through `src/apps/hive-cli/common/mcp-client.ts`.
- **DB queries**: All control-plane DB reads route through `src/apps/hive-cli/common/control-plane-client.ts`.

### File Structure

```
src/apps/hive-cli/
  ├── bin/
  │   └── hive.ts                    # Entrypoint (shebang, version, init Commander program)
  ├── common/
  │   ├── context.ts                 # Context resolution (project/agency/host)
  │   ├── mcp-client.ts              # MCP transport wrapper
  │   ├── control-plane-client.ts    # Control DB query helpers
  │   ├── formatters/
  │   │   ├── text-formatter.ts      # Human tables, colored output
  │   │   ├── json-formatter.ts      # Single-object JSON
  │   │   ├── jsonl-formatter.ts     # Streaming JSONL
  │   │   ├── yaml-formatter.ts      # YAML output
  │   │   └── sarif-formatter.ts     # SARIF (for scan)
  │   ├── logger.ts                  # Color logging + NO_COLOR support
  │   ├── helpers.ts                 # Pagination, confirmation prompts, etc.
  │   └── types.ts                   # Shared TS types for CLI
  ├── domains/
  │   ├── project/
  │   │   └── index.ts               # register(program) exports register/archive/info/list commands
  │   ├── proposal/
  │   │   └── index.ts               # register(program) for create/get/list/search/edit/claim/release/...
  │   ├── workflow/
  │   │   └── index.ts               # register(program) for list/show/gates/...
  │   ├── state/
  │   │   └── index.ts               # register(program) for next/history
  │   ├── document/
  │   │   └── index.ts               # register(program) for doc list/get/sync/decision
  │   ├── agency/
  │   │   └── index.ts               # register(program) for agency/worker/lease commands
  │   ├── provider/
  │   │   └── index.ts               # register(program) for provider/model/route/budget
  │   ├── dispatch/
  │   │   └── index.ts               # register(program) for dispatch/offer/queue/stop
  │   ├── service/
  │   │   └── index.ts               # register(program) for service/mcp/db/cubic
  │   ├── audit/
  │   │   └── index.ts               # register(program) for audit/metrics/report
  │   ├── scan/
  │   │   └── index.ts               # register(program) for scan/lint
  │   ├── knowledge/
  │   │   └── index.ts               # register(program) for kb/memory
  │   ├── doctor/
  │   │   └── index.ts               # register(program) for doctor
  │   ├── board/
  │   │   └── index.ts               # register(program) for board/web/tui
  │   └── util/
  │       └── index.ts               # register(program) for completion/version/help
  └── index.ts                       # Program composition (import all domains, call register())

# Backwards compat shim (deprecation wrapper)
src/apps/
  └── roadmap-compat.ts             # Thin wrapper that forwards to hive, emits warnings
```

### Command Function Signature

Every command function follows this signature for testability:

```typescript
async function commandFn(args: CommandArgs, context: CliContext): Promise<CommandResult>
```

Where:

```typescript
interface CliContext {
  project: Project;           // Resolved from flag/env/CWD
  agency?: Agency;            // Optional, if --agency flag provided
  host?: Host;                // Optional, if --host flag provided
  format: 'text'|'json'|'jsonl'|'yaml'|'sarif';
  quiet: boolean;
  logger: Logger;
  mcpClient: McpClient;
  controlPlaneClient: ControlPlaneClient;
}

interface CommandResult {
  exitCode: number;          // 0, 1, 2, 3, 4, 5 per convention
  output?: any;              // Formatted output (varies by format)
  error?: string;            // Error message (logged if present)
}
```

Side-effect-free units (core logic) can be tested without the CLI framework.

### Output Formatters

All formatters share a common interface:

```typescript
interface OutputFormatter {
  formatList(items: any[], meta?: PaginationMeta): string;
  formatRecord(record: any): string;
  formatTable(data: { headers: string[]; rows: any[][] }): string;
  formatError(error: Error | string): string;
}
```

Shared logic in `common/formatters/`:

- **TextFormatter**: ANSI colors, Unicode tables, responsive width, respects `NO_COLOR`.
- **JsonFormatter**: Single complete object; includes `_meta` with next_cursor if applicable.
- **JsonlFormatter**: One object per line; no wrapping metadata.
- **YamlFormatter**: YAML dump with comments (useful for config/doc sync).
- **SarifFormatter**: SARIF v2.1.0 for static analysis results (used by `hive scan`).

Example:

```typescript
// Controller orchestrates, formatters output
const proposals = await mcpClient.listProposals(filter);
const formatter = getFormatter(format);  // Chosen by --format flag
console.log(formatter.formatList(proposals, { next_cursor: "abc", has_more: true }));
```

### MCP & Control-Plane Client Layers

**`mcp-client.ts`**: Single point of contact for all MCP calls.

```typescript
class McpClient {
  async listProposals(filter: ...): Promise<Proposal[]>
  async getProposal(id: string): Promise<Proposal>
  async createProposal(input: ...): Promise<Proposal>
  // ... all proposal tools
  async transitionProposal(id, newState, message?): Promise<Proposal>
  async claimProposal(id, durationMinutes?): Promise<Lease>
  // ... all RFC tools, lease tools, discussion tools
}
```

Transport abstraction:
- Currently SSE (`http://127.0.0.1:6421/sse`).
- P446 may add alternate transports (gRPC, direct socket). MCP client swaps transport via config, not CLI code.

**`control-plane-client.ts`**: Query helper for direct control-DB reads (performance, low-latency, non-MCP workflows).

```typescript
class ControlPlaneClient {
  async getProject(projectId: string): Promise<Project>
  async listProjects(): Promise<Project[]>
  async getWorkflowTemplate(template: string): Promise<WorkflowTemplate>
  async listAgencies(): Promise<Agency[]>
  async listHosts(): Promise<Host[]>
  async listModelRoutes(): Promise<ModelRoute[]>
  // etc.
}
```

Rationale: MCP is the source of truth for proposals/workflow state (durability + audit). But reading static metadata (projects, workflows, providers, hosts) via control DB is faster and avoids tool invocation overhead.

### State Names & Maturity Constants

**CRITICAL**: All workflow state names come from control plane at runtime. No hardcoding.

File: `src/core/workflow/state-names.ts` (per P453). Loaded once at CLI startup:

```typescript
import { getStateNames } from '../core/workflow/state-names.ts';

const stateNames = await getStateNames(project);
// stateNames = { draft: 'DRAFT', review: 'REVIEW', develop: 'DEVELOP', ... }
```

In commands, validate user input against the loaded state set:

```typescript
if (!Object.values(stateNames).includes(newState)) {
  context.logger.error(`Invalid state. Valid: ${Object.values(stateNames).join(', ')}`);
  return { exitCode: 2, error: "Invalid state" };
}
```

Maturity is fixed:

```typescript
const MATURITY_VALUES = ['new', 'active', 'mature', 'obsolete'];
```

---

## 6. Daily Workflow Examples

### 1. New Project Bootstrap

```bash
# Register a new project in control plane
hive init --name "project-alpha" --repo /path/to/repo --db-host pg.example.com

# Output:
# Project registered: agenthive_project_alpha
# Added to control plane. You can now create proposals.
# Try: hive proposal create --type component --title "..."

# Verify
hive project info --project alpha
# Shows: project name, repo path, DB DSN, workforce subscriptions, active proposals
```

### 2. Capture a Defect Found While Coding

```bash
# Create an issue proposal inline
hive proposal create --type issue \
  --title "CLI hardcoding: /data/code/AgentHive literals" \
  --body "Found 12 hardcoded paths in src/apps/commands. Should use getProjectRoot()." \
  --format json

# Output (JSON):
# {
#   "id": "P456",
#   "state": "DRAFT",
#   "maturity": "new",
#   "created_by": "hermes@localhost",
#   "created_at": "2026-04-24T...",
#   ...
# }

# Or open editor if no --body:
hive proposal create --type issue --title "Hardcoding bug"
# Opens $EDITOR for body entry
```

### 3. Claim and Develop a Proposal

```bash
# Discover drafts
hive proposal list --state DRAFT --format text
# Shows a table:
# P456 [DRAFT] CLI hardcoding: /data/code/AgentHive literals                              14 min
# P457 [DRAFT] Control-plane DDL sketch for multi-project                                  2 h
# ...

# Claim one for development
hive proposal claim P456 --duration-minutes 240
# Output:
# Claimed P456 for 240 minutes. Lease ID: L123.
# Type: hive proposal release P456 to release early.

# Add acceptance criteria
hive proposal ac add P456 "ac-001-scan-error" \
  --body "hive scan --type hardcoding finds zero /data/code/AgentHive literals" \
  --verification-type test

# Work locally (edit files, run tests, commit)
# Then mark your work ready for review
hive proposal maturity P456 mature --with-message "Ready for gating review"
# Output:
# Updated maturity to 'mature' (was 'new'). Still in DRAFT state.
# Send to gating review: hive proposal transition P456 REVIEW
```

### 4. Operator Stops a Runaway Dispatch

```bash
# Discover the runaway
hive dispatch list --state running --format text
# Shows:
# D999 [RUNNING] P123 (DEVELOP phase) claimed by hermes@localhost (started 12h ago, expires never)

# Stop it
hive stop dispatch D999 \
  --reason "Runaway agent, exceeded token budget" \
  --yes

# Output:
# Stopped dispatch D999. No automatic retry. Proposal P123 remains in DEVELOP.
# To retry with a different approach: hive dispatch list --proposal P123

# Alternative: stop all dispatches for a proposal
hive stop proposal P123 \
  --reason "Pivoting to different solution" \
  --yes

# Output:
# Stopped 2 dispatches for P123. Proposal transitions to ERROR state (manual recovery needed).
```

### 5. Audit Hardcoding Before Committing

```bash
# Scan staged files for hardcoding
hive scan --type hardcoding --git-staged --fail-on medium

# Output (text):
# Hardcoding Scanner Report
# ========================
#
# [HIGH] src/apps/commands/project.ts:45
#   Literal path: "/data/code/AgentHive"
#   Suggestion: Use getProjectRoot() from src/shared/runtime/paths.ts
#   Line: const ROOT = "/data/code/AgentHive";
#
# [MEDIUM] src/core/workflow/state-names.ts:12
#   Hardcoded workflow state: "DRAFT"
#   Suggestion: Load from control plane (P453)
#
# Summary: 1 HIGH, 1 MEDIUM, 0 LOW
# Exit code: 4 (fail-on medium: errors found >= medium)

# Fix issues, re-scan
hive scan --type hardcoding --git-staged --fail-on high

# Exit code: 0 (only LOW issues remain, below threshold)
# Safe to commit!
```

### 6. Investigate Why a Proposal Is Stuck

```bash
# Show proposal details + leases + events
hive proposal show P123 --include full

# Output:
# Proposal: P123
# Title: Control plane hardening
# State: DEVELOP (entered 48h ago)
# Maturity: new (no progress)
# Leases:
#   - L456 claimed by hermes@localhost (started 48h ago, expired 1h ago, still held!)
# Dispatch Events:
#   - D789: DRAFT → REVIEW (OK, 48h ago)
#   - D790: DRAFT → DEVELOP (CLAIMED by hermes, but no worker activity for 40h)
#   - D791: DRAFT → DEVELOP (FAILED after 2h: MCP timeout)
# Recent Runs:
#   - W890: RUNNING (40h, no heartbeat in 10h) ← PROBLEM
#
# Diagnosis: Worker W890 is hung or dead. Dispatch D790 is stuck.

# Release the expired lease and stop the dispatch
hive lease release L456 --force --with-message "Releasing expired lease (48h old)"
hive stop dispatch D790 --reason "Worker hung, no heartbeat for 10h"

# Retry on a fresh dispatch
hive dispatch list --proposal P123 --state new
# Shows: D792 (pending, created just now after stop)
# Next agent to pick up: hermes or another agency
```

---

## 7. Open Questions / Deferred

1. **Board vs Web**: Should `hive board` launch the TUI in tmux, and `hive web` open a browser? Or should one command offer both modes (`hive board --web`)? *Decision: separate commands (`hive board` = TUI, `hive web` = browser) for clarity. Both share the same backend API.*

2. **Permanent roadmap alias**: After the grace period, do we keep `roadmap` as a permanent compatibility alias pointing to `hive`, or drop it entirely? *Decision: drop after month 3 unless usage metrics show high adoption. Provide clear migration docs.*

3. **Interactive/streaming commands**: Some users may want `hive propose ... --editor` to launch an editor before creating. Should `proposal create` support an interactive mode with file-based composition? *Decision: yes; `hive proposal create` with no flags + no stdin opens editor interactively (UX like `git commit`).*

4. **Approval/release workflows**: Should `hive proposal review` emit different verbs for different gate outcomes (e.g., `--approved`, `--changes-requested`, `--ready-to-merge`)? Or is `--with-message` sufficient? *Decision: `--with-message` is sufficient; gate outcome is inferred from the message (MCP) or explicitly set via structured flags like `--ready-for-merge | --recommend-draft`.*

5. **Cross-project commands**: Should `hive` support querying across all projects (e.g., `hive proposal list --across-projects`)? Or is that only for web/TUI? *Decision: only same-project by default; explicit `--across-projects` flag requires admin role (for portfolio views). Most developers work single-project.*

6. **Dispatch retry policies**: Should `hive stop dispatch` offer a `--reissue` flag to immediately create a new dispatch with different parameters, or should operators always manually `hive dispatch list` + wait for orchestrator? *Decision: `--escalate-to-dispatch` on `hive stop worker` (retry) + recommend manual `hive dispatch list` for operator review. Prevents accidental cascade.*

7. **Proposal templates**: Should new proposals use templates (e.g., `hive proposal create --template "security-review"`)? *Decision: templates live in control-plane docs; users copy-paste body or edit. No CLI-enforced templates yet (future P# if adoption warrants).*

8. **Batch operations**: Should `hive proposal` support batch actions (e.g., `hive proposal transition P### P### P### --to REVIEW --yes`)? *Decision: no in v1. Single-proposal focus prevents cascading errors. Operators can write loops: `for p in P1 P2 P3; do hive proposal transition $p REVIEW; done`.*

9. **Config persistence**: Should `hive` store user preferences (e.g., `--format json` as default, `--limit 50` as preferred pagination) in `~/.hive/config` or `$HIVE_CONFIG_DIR`? *Decision: yes; simple TOML file. Flags always override. See `hive help context`.*

10. **Plugin system**: Should we support `hive <plugin-command>` for third-party extensions (e.g., vendor-specific domain commands)? *Decision: deferred (P#). For now, all commands are built-in. Future: git-style plugin discovery (`hive-myplugin` in PATH).*

---

## 8. Implementation Roadmap

### Current Implementation Status (as of 2026-06-16)

> **Status as of 2026-06-17:** `bin/hive` shim and `jiti` runtime are present. No prebuilt `dist/hive-cli.cjs.js` bundle exists yet. Dependency proposals P453, P410, P411, P446, P454 are all COMPLETE.

| Phase | Status | Duration | Deliverables | Depends On |
| --- | --- | --- | --- | --- |
| **Phase 1: Core Scaffolding** | COMPLETE | 1 week | Domain module template, context resolution, formatters, mcp-client wrapper, control-plane-client | — |
| **Phase 2: Proposal Domain** | PARTIAL | 2 weeks | proposal create/get/list/search/edit/claim/release/transition/maturity (without MCP integration, mock first) | Phase 1 |
| **Phase 3: Workflow + State** | PARTIAL | 1 week | workflow list/show, state next/history (read from control plane) | Phase 1, P453 (state-names) |
| **Phase 4: Provider + Route + Budget** | PARTIAL | 1.5 weeks | provider/model/route/budget list/show/toggle (read from control DB) | Phase 1, control-plane DDL (P411) |
| **Phase 5: Dispatch + Queue** | PARTIAL | 1 week | dispatch list/show, offer list, queue show, stop dispatch|proposal|agency|host|worker|route | Phase 1, Phase 2 (for proposal context) |
| **Phase 6: Service + System Ops** | PARTIAL | 1 week | service list/status/restart/logs, mcp ping/smoke/health, db migrate/check, cubic list/clean/repair | Phase 1 |
| **Phase 7: Audit + Observability** | PARTIAL | 1 week | audit feed/events, metrics show, report run | Phase 1, control-plane audit schema (P410) |
| **Phase 8: Scan + Lint** | PARTIAL | 1 week | scan hardcoding/secrets/performance, lint eslint/tsc (P454 hardcoding scanner) | Phase 1, P454 scanner impl |
| **Phase 9: Knowledge + Doctor** | PARTIAL | 1 week | kb add/search, memory show/set/delete, doctor readiness suite | Phase 1, P446 doctor spec |
| **Phase 10: Board + UI Launchers** | NOT-STARTED | 1.5 weeks | board (tmux TUI), web (dev server launch), tui alias | Phase 1, existing board code |
| **Phase 11: Help + Completion + Version** | NOT-STARTED | 0.5 weeks | hierarchical help, shell completion, version command | Phase 1–10 (all domains) |
| **Phase 12: Migration + Docs** | NOT-STARTED | 1 week | roadmap compat shim, deprecation guide, ADR docs, help recipes | Phase 1–11 |
| **Phase 13: Testing + Polish** | NOT-STARTED | 2 weeks | E2E tests (against mock control plane), performance tuning, UX refinement | Phase 1–12 |

> **Note (2026-06-16):** Phase 1 scaffolding is live at `src/apps/hive-cli/` with a `bin/hive` shim. TypeScript runs via `jiti` (no build step required). Phases 2–9 have stub domain handlers in place; most subcommands return structured output for the core paths but fall back to `[stub]` for less-common actions. See P788 for the gap inventory.

| Artifact | Status | Notes |
|----------|--------|-------|
| `bin/hive` shim | ✅ EXISTS | Routes to prebuilt bundle or jiti dev-path |
| `src/apps/hive-cli/index.ts` | ✅ EXISTS | CLI entry point |
| `src/apps/hive-cli/commands/` | ✅ EXISTS | Top-level commands (doctor, workflow, proposal, stop, etc.) |
| `src/apps/hive-cli/domains/` | ✅ EXISTS | Domain modules: agency, audit, budget, cubic, db, dispatch, knowledge, lease, lint, mcp, meta, model, project, proposal, provider, route, scan, stop, system, trust, worker, workflow |
| `jiti` dev-loader | ✅ INSTALLED | `node_modules/jiti` present; dev-path fallback works |
| `dist/hive-cli.cjs.js` bundle | ❌ NOT BUILT | Production path unavailable; falls through to jiti dev-path. Run `npm run build:cli` (if defined) to create. |
| Shell completions | ❓ UNKNOWN | No evidence of `hive completion` generating working scripts |
| `roadmap` compatibility alias | ❓ UNKNOWN | Verify whether `bin/roadmap` or shim exists |

### Phase Implementation Status

| Phase | Deliverables | Status |
| --- | --- | --- |
| **Phase 1: Core Scaffolding** | Domain module template, context resolution, formatters, mcp-client wrapper | ✅ COMPLETE — scaffolding, common module, and formatters exist |
| **Phase 2: Proposal Domain** | proposal create/get/list/search/edit/claim/release/transition/maturity | ✅ COMPLETE — `domains/proposal/` with handlers, schema, and tests |
| **Phase 3: Workflow + State** | workflow list/show, state next/history | ✅ COMPLETE — `domains/workflow/` with handlers, schema, and tests |
| **Phase 4: Provider + Route + Budget** | provider/model/route/budget list/show/toggle | ✅ COMPLETE — `domains/provider/`, `domains/route/`, `domains/budget/` exist |
| **Phase 5: Dispatch + Queue** | dispatch list/show, offer list, queue show, stop commands | ✅ COMPLETE — `domains/dispatch/`, `domains/stop/` exist |
| **Phase 6: Service + System Ops** | mcp ping/smoke/health, db migrate/check, cubic list/clean/repair | ✅ COMPLETE — `domains/mcp/`, `domains/db/`, `domains/cubic/`, `domains/system/` exist |
| **Phase 7: Audit + Observability** | audit feed/events, metrics show, report run | ✅ COMPLETE — `domains/audit/` exists |
| **Phase 8: Scan + Lint** | scan hardcoding/secrets/performance, lint eslint/tsc | ✅ COMPLETE — `domains/scan/`, `domains/lint/` exist |
| **Phase 9: Knowledge + Doctor** | kb add/search, memory show/set/delete, doctor readiness suite | ✅ COMPLETE — `domains/knowledge/`, `commands/doctor.ts` exist |
| **Phase 10: Board + UI Launchers** | board (tmux TUI), web (dev server launch), tui alias | ❌ NOT STARTED — no `board`, `web`, or `tui` domain/command found in source |
| **Phase 11: Help + Completion + Version** | hierarchical help, shell completion, version command | ⚠️ PARTIAL — help likely included via CLI framework; completion unverified |
| **Phase 12: Migration + Docs** | roadmap compat shim, deprecation guide, ADR docs | ⚠️ PARTIAL — migration strategy in Section 4 exists; compat shim status unknown |
| **Phase 13: Testing + Polish** | E2E tests, performance tuning, UX refinement | ⚠️ PARTIAL — unit/integration tests exist per domain; E2E test coverage unknown |

**Summary:** Phases 1–9 are substantially complete. Phase 10 (board/web launchers) is the primary gap. Phases 11–13 are partially done.

**Original estimate**: 15–16 weeks for full feature parity with legacy `roadmap` CLI + new control-plane-aware commands.

---

## 9. Coordination with Parallel Work

### AI Engineer (AI-Agent Ergonomics & Structured Output)

**Coordinate on:**

- **Output contract**: Ensure `--format json|jsonl|yaml` is sufficient for AI agent consumption. Discuss if JSONL needs a `_id` field per line or if separate `_meta` is acceptable.
- **State names**: AI agent code must also respect runtime state names (P453). Provide `getStateNames()` export from CLI common module for re-use.
- **Context passing**: CLI context resolution code should be exportable as a library for agent-context spawning.

**Deference:** AI Engineer defines structured output schema per command. CLI implements per that schema.

### Backend Architect (System-Ops Coverage & DB-Backed Commands)

**Coordinate on:**

- **Control-DB reads**: CLI `control-plane-client.ts` wraps DB queries. Backend Architect defines query design. CLI calls the library; Backend Architect owns optimization.
- **State-machine loading**: Control-DB schema for `workflow_template`, `state`, `transition`. CLI loads at startup; Backend Architect owns schema + migrations.
- **MCP vs direct DB**: CLI defers to Backend Architect on whether a command should go through MCP (durable, audited) or direct DB (fast, metadata-only).
- **Pagination**: Backend Architect provides cursor-based pagination helpers (opaque tokens); CLI formatters use them.

**Deference:** Backend Architect defines data access layer; CLI calls it.

---

## 10. Testing Strategy (Sketch)

- **Unit tests**: Command functions tested in isolation with mock context + fixtures (no framework).
- **Integration tests**: Commands + real control-plane DB clone (CI environment).
- **E2E tests**: Commands + mock MCP server (captured protocol exchanges).
- **Help text tests**: Verify `hive --help`, `hive <domain> --help`, `hive help <topic>` are formatted correctly.
- **Exit code tests**: Verify exit codes match the spec (0, 1, 2, 3, 4, 5).
- **Formatter tests**: JSON, YAML, text, JSONL, SARIF outputs validate structure.

---

## Conclusion

The `hive` CLI is a **clean, domain-driven interface** to AgentHive's control plane. It balances **discoverability** (help system, context summary) with **power** (deep filtering, pagination, format flexibility). **Streamy/conversational concerns move to TUI/web**, leaving CLI for daily operations: proposing, reviewing, debugging, auditing.

Implementation is **modular and testable**, with clear separation between transport (MCP, control DB), domain logic (workflow state, proposal lifecycle), and output formatting (text, JSON, YAML, SARIF). All state names and maturity values come from the control plane at runtime, enforcing single source of truth.

The **migration from `roadmap` CLI** is graceful: a compatibility wrapper maintains backward compatibility during a 3-month grace period, then can be dropped or kept as a permanent alias depending on usage.
