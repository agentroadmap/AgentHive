% **Type:** architecture | reference  
% **MCP-tracked:** P441 (Service Operations) + P434 (Provider Route and Budget Governance) + P442 (Operator Stop and Cancel)  
% **Source-of-truth:** Postgres `roadmap_proposal.proposal` rows P441, P434, P442, P446  

# AgentHive `hive` CLI: System Operations and DB-Backed Command Catalog

**Audience:** Platform operators, cluster admins, AI engineers deploying AgentHive, and on-call SRE roles.

**Purpose:** Define the operator-facing CLI (`hive`) that provides safe, auditable, and discoverable access to control-plane state, service orchestration, dispatch routing, budget enforcement, and emergency stop controls without forcing operators to write SQL or hit TUI/web dashboards in crisis scenarios.

**Status:** Architecture design for P441, P434, P442, P446 implementation.

---

## 1. Design Principles

1. **Non-interactive wrapping of systemd and DB operations.** Every `hive` command is deterministic and scriptable. No interactive prompts except explicit confirmations on destructive ops.
2. **All destructive actions require `--yes`.** Safety is non-negotiable: `--yes` is mandatory for any operation that removes, stops, or modifies runtime state. For panic operations, require both `--yes` and `--really-yes`.
3. **Comprehensive audit trail.** Every write (service restart, dispatch cancel, lease release, provider rotation, budget cap change) writes to `control_audit.operator_action_log` with actor, scope, reason, and result. No CLI operation bypasses this.
4. **Schema-qualified SQL across all operations.** All queries schema-qualify tables with `control_*` prefixes (per P436) or use compatibility shims during migration from `roadmap_*`.
5. **Unified output formats.** All commands support `--format json|jsonl|yaml|table` (table is default). Structured output enables automation and downstream processing.
6. **Fail-closed routing gates.** Route resolution, budget checks, host policy, and capability matching all fail closed. Escalation is immediate.
7. **MCP integration, never bypass.** All mutations that touch proposals, dispatches, or leases go through MCP. The CLI is a thin wrapper, not a second source of truth.
8. **No credentials in CLI input.** Secrets are resolved at spawn time via vault/env references only. Operators never pass raw API keys to the CLI.

---

## 2. Command Taxonomy

The `hive` CLI is organized into 8 domains and 1 power-user escape hatch:

| Domain | Purpose | Key Commands |
| :--- | :--- | :--- |
| **service** | Manage systemd services, health, logs, drain | status, restart, start, stop, logs, drain |
| **doctor** | Readiness checks and remediation hints | (single command; ~12 sub-checks) |
| **agency** | Workforce inspection and suspension | list, info, subscribe, suspend, resume, concurrency |
| **worker** | Ephemeral agent processes (read-mostly) | list, info, terminate |
| **lease** | Proposal work-lease lifecycle | list, release, expired, hold |
| **dispatch** | Offer/claim/run queue operations | list, show, cancel, retry, reissue |
| **offer** | Open work items | list, show, expire, reissue |
| **provider** | AI provider account and credential management | list, info, account add\|remove\|rotate, set-quota |
| **model** | Model catalog, route enablement, cost | list, info, enable\|disable, cost show\|set |
| **route** | Model execution policies (routes) | list, show, test, priority, toggle |
| **budget** | Spend caps and consumption tracking | show, set, consumed, freeze |
| **context-policy** | Context windowing and retrieval | show, set |
| **queue** | Implicit gate queue (mature proposals) | show, gate-readiness |
| **cubic** | Worktree lifecycle and cleanup | list, info, clean, repair, gc |
| **stop** | Emergency operator stop (all scopes) | dispatch, proposal, agency, host, worker, route, all |
| **audit** | Observability and audit feed | feed, search, metrics, report, escalation |
| **sql** | Power-user SQL escape hatch | exec, explain, snapshot |

---

## 3. Service / System Operations Domain

### 3.1 `hive service`

Lists and manages systemd services across the AgentHive runtime. Wraps systemd only; never attempts direct process manipulation.

```
hive service status [--format json|table]
  Show all registered services (mcp-server, orchestrator, gate-pipeline, etc.)
  Output: service_name, status (running|stopped|failed), pid, uptime, owner_host, last_heartbeat

hive service restart <service-name> [--yes] [--reason <text>]
  Restart a service via systemctl. Writes to operator_action_log.
  Requires --yes for non-dry-run.

hive service start <service-name> [--reason <text>]
hive service stop <service-name> [--yes] [--reason <text>]
  Start/stop a service. Systemctl wrapper.

hive service logs <service-name> [--since <duration>] [--grep <pattern>] [--format jsonl|text]
  Tail service logs from journalctl.
  Example: hive service logs agenthive-mcp-server --since 10m --grep ERROR

hive service drain <host-name> [--grace 60s] [--reason <text>]
  Mark a host as draining (no new work spawns), wait for active dispatches to complete,
  then allow graceful shutdown. Writes service_lease rows with expires_at = now() + grace.
```

**Backing SQL Pattern:**
```sql
SELECT
  s.service_name,
  s.status,
  h.host_name,
  ph.process_id,
  ph.uptime_seconds,
  ph.last_heartbeat_at,
  s.updated_at
FROM control_runtime.systemd_service s
  LEFT JOIN control_runtime.host h ON s.host_id = h.id
  LEFT JOIN control_runtime.process_heartbeat ph ON s.id = ph.service_id
WHERE s.status IN ('running', 'failed', 'inactive')
  AND ph.created_at > now() - interval '5 minutes'
ORDER BY s.service_name;
```

---

### 3.2 `hive doctor`

Single top-level readiness check. Runs the platform health suite from P446 + P415:

```
hive doctor [--remediate <check-code>]
```

**Built-in Checks:**
1. **mcp-reachable** — HTTP GET to MCP endpoint (per P446)
2. **db-reachable** — Postgres connection to control DB
3. **db-schema-version** — Check `schema_version` table matches expected baseline
4. **control-vs-project-consistency** — Sample project-id references in control DB exist in project registries
5. **agency-registered** — All agencies referenced in worker records are in `control_workforce.agency`
6. **host-policy-resolved** — All active routes have host_model_policy entries
7. **scanner-self-test** — Internal MCP consistency check (P446)
8. **orphan-leases** — Detect leases > N minutes old without active work
9. **escalation-storms** — Count escalation_log entries in last hour; warn if > threshold
10. **services-up** — All critical services (orchestrator, gate-pipeline, mcp-server) are running
11. **disk-space** — Check worktree_root partitions have > 10% free
12. **journalctl-errors** — Last 100 journal lines with ERROR/CRITICAL severity

**Output format (table default):**
```
check_code              severity  status    remediation_hint
mcp-reachable          INFO      pass      
db-reachable           CRITICAL  fail      Run: hive sql exec "SELECT version();"
db-schema-version      WARNING   outdated  Migration P305 pending; run: pg_migrate apply
agency-registered      INFO      pass      
orphan-leases          WARNING   found     Expired lease ids: L-123, L-456; run: hive lease release L-123 --reason orphan
escalation-storms      CRITICAL  active    13 escalations in last hour; run: hive escalation list --unresolved
services-up            CRITICAL  degraded  Services down: agenthive-mcp-server; run: hive service start agenthive-mcp-server
disk-space             WARNING   low       /data/code/worktrees: 8% free; run: hive cubic gc --idle >24h
journalctl-errors      INFO      found     Last error 3m ago; run: hive service logs agenthive-orchestrator --since 10m --grep ERROR
```

**Remediation:**
```
hive doctor --remediate orphan-leases
  → Suggests: hive lease release <id> --reason orphan

hive doctor --remediate escalation-storms
  → Suggests: hive escalation list --unresolved
```

---

### 3.3 `hive mcp`

MCP-specific probes (per P446):

```
hive mcp ping [--timeout 5s]
  HTTP HEAD to MCP endpoint; exits 0 if reachable within timeout.

hive mcp smoke [--timeout 30s]
  Run a quick MCP method call (e.g., list_actions) to confirm service is alive.

hive mcp tools [--format json|list]
  List registered MCP tools. Maps to mcp_tools.tool_name from MCP registry.

hive mcp health
  Detailed health: SSE transport, method latency percentiles, last error.
```

---

### 3.4 `hive db`

Schema migration and integrity operations:

```
hive db migrate [--dry-run] [--from <version>] [--to <version>] [--yes]
  Apply pending numbered migration files in order.
  --dry-run: print SQL without executing.
  --yes: required for non-dry-run.
  Writes to control_audit.operator_action_log.

hive db check [--diff-live]
  Compare live schema against baseline DDL. Report drift.
  --diff-live: full column-by-column diff.

hive db rollback <filename> [--yes]
  Rollback a specific numbered migration (reads corresponding .down.sql if exists).
  Requires --yes and --proposal P###.

hive db schema-diff <v1> <v2>
  Show DDL changes between two schema versions without applying.
```

---

### 3.5 `hive log`

Service log inspection (thin journalctl wrapper):

```
hive log <service-name> [--since <duration>] [--grep <pattern>] [--tail 50] [--format jsonl|text]
  Examples:
    hive log agenthive-orchestrator --since 5m
    hive log agenthive-mcp-server --grep "ERROR\|WARNING" --format jsonl
    hive log agenthive-claude-agency --tail 100 --format text
```

---

## 4. Workforce Domain (Read-Mostly)

### 4.1 `hive agency`

Stable agency (dispatcher) inspection and lifecycle:

```
hive agency list [--status active|suspended|archived] [--format json|table]
  Output: identity, provider_family, status, host_affinity, max_concurrent_claims, subscribed_projects

hive agency info <identity>
  Full agency record including trust_tier, capabilities, service_user_id, created_at.

hive agency subscribe <identity> <project-id> [--max-concurrent <int>] [--required-trust-tier authority|trusted|known|restricted]
  Add agency to project subscription (control_project.project_subscription).

hive agency suspend <identity> [--reason <text>] [--yes]
  Mark agency as suspended (blocks new claims). Destructive; requires --yes.
  Writes to operator_action_log.

hive agency resume <identity> [--reason <text>]
  Resume a suspended agency.

hive agency concurrency show <identity> [--project <id>]
  Show current active claims vs. max_concurrent_claims across all projects or for a specific project.

hive agency concurrency set <identity> <max-int> [--project <id>] [--yes]
  Update max_concurrent_claims for this agency (global or per-project).
```

**Backing SQL:**
```sql
SELECT
  a.agency_id,
  a.identity,
  a.status,
  COUNT(DISTINCT d.dispatch_id) AS active_claims,
  a.max_concurrent_claims,
  array_agg(DISTINCT ps.project_id) AS subscribed_projects
FROM control_workforce.agency a
  LEFT JOIN control_dispatch.squad_dispatch d ON a.agency_id = d.agency_id AND d.dispatch_status = 'active'
  LEFT JOIN control_project.project_subscription ps ON a.identity = ps.agency_identity
WHERE a.agency_id = $1
GROUP BY a.agency_id;
```

---

### 4.2 `hive worker`

Ephemeral per-dispatch worker inspection (read-only by design):

```
hive worker list [--agency <identity>] [--proposal P###] [--host <name>] [--status active|completed|failed]
  Output: worker_id, identity, agency_id, dispatch_id, status, started_at, completed_at

hive worker info <worker_id>
  Full worker record: identity, agency, dispatch, capabilities, host, last_heartbeat.

hive worker terminate <worker_id> [--signal TERM|KILL] [--reason <text>] [--yes]
  Stop an OS process and mark dispatch as failed. Destructive; requires --yes.
  Both process termination and dispatch status update must succeed atomically.
  Writes to operator_action_log.
```

---

### 4.3 `hive lease`

Proposal work-lease (claim) lifecycle:

```
hive lease list [--proposal P### | --agency <identity>] [--status active|expired]
  Output: lease_id, proposal_id, agency_identity, claimed_at, expires_at, status

hive lease release <lease_id> [--reason <text>] [--yes]
  Force-release a claim (mark dispatch as failed and close lease).
  Requires --yes. Destructive. Writes to operator_action_log.

hive lease expired [--age >10m]
  List leases past their expires_at time that should have been cleaned up.
  Suggests: hive lease release <id> --reason expired

hive lease hold <lease_id> [--duration 30m] [--reason <text>]
  Extend lease expiration (e.g., for long-running work).
```

---

## 5. Provider / Model / Route / Budget Domain

### 5.1 `hive provider`

Provider account and credential lifecycle:

```
hive provider list [--provider anthropic|openai|google|xiaomi|nous] [--status active|rotating|expired]
  Output: account_id, provider, account_name, plan_type, credential_status, owner_scope, current_spend_usd

hive provider info <account_id>
  Full record: provider, plan_type, credential_status, expires_at, last_rotated_at, base_url.
  Does NOT show credential_ref or raw secrets.

hive provider account add <provider> <account-name> --plan-type <token_plan|api_key_plan|subscription|local> \
                            --credential-ref <vault:...|env:...> [--base-url <url>] [--owner-scope global|project|agency] [--owner-id <uuid>]
  Register a new provider account. Credential-ref is a vault/env reference only (no raw secrets).
  Example: hive provider account add anthropic staging --plan-type token_plan --credential-ref vault:agenthive/anthropic/staging-1

hive provider account remove <account_id> [--reason <text>] [--yes]
  Deregister a provider account (mark as revoked). Destructive; requires --yes.

hive provider account rotate-credential <account_id> --credential-ref <vault:...> [--yes]
  Rotate credential reference and set status to 'rotating'.
  Spawner will accept old + new during grace window; after grace, switch to new.
  Requires --yes.

hive provider account set-quota <account_id> --daily <usd|tokens> --monthly <usd|tokens> [--yes]
  Update budget caps for this account.
```

---

### 5.2 `hive model`

Model catalog and route enablement:

```
hive model list [--provider anthropic|openai|...] [--enabled true|false] [--capability reasoning|coding|vision|tool_use]
  Output: model_name, provider, context_window, output_limit, capabilities, status, objective_rating

hive model info <model_name>
  Full model metadata: context_window, training_cutoff, capabilities, availability on each route.

hive model enable <route_id> [--reason <text>]
hive model disable <route_id> [--reason <text>] [--yes]
  Toggle route.is_enabled. Disabling prevents new spawns. Requires --yes.

hive model cost show <model_name> [--format json|table]
  Show pricing across all routes that use this model:
    route_id | agent_provider | input $/M | output $/M | cache-write $/M | cache-read $/M

hive model cost set <route_id> --input <usd-per-million> --output <usd-per-million> \
                     [--cache-write <usd>] [--cache-read <usd>] [--yes]
  Update pricing for a specific route. Affects future spend tracking.
```

---

### 5.3 `hive route`

Model execution policy (the executable object):

```
hive route list [--host <name>] [--agent-provider claude|hermes|copilot] [--enabled true|false] [--format json|table]
  Output: route_id, model_name, agent_provider, provider_account_id, priority, is_enabled, is_default

hive route show <route_id>
  Full route record: model_name, provider_account_id, agent_cli, cli_path, api_spec, base_url,
                     priority, capabilities, objective_rating, spawn_toolsets, spawn_delegate.

hive route test <route_id> [--model-hint <name>] [--host <name>]
  Dry-run resolveModelRoute(): check host policy, budget, credential availability, and endpoint health.
  Output: pass|fail + reason.

hive route priority <route_id> <int> [--yes]
  Reorder route resolution priority (lower = higher priority).

hive route toggle <route_id> [--yes]
  Flip is_enabled on/off. Prevents/allows spawning with this route.
```

**Backing SQL (test subcommand):**
```sql
-- Gate 1: Host policy
SELECT 1 FROM control_runtime.host_model_policy
WHERE host_id = (SELECT id FROM control_runtime.host WHERE host_name = $host)
  AND route_provider = (SELECT route_provider FROM control_models.model_route WHERE route_id = $route_id)
  AND allowed = true;

-- Gate 2: Credential active
SELECT credential_status FROM control_models.provider_account
WHERE provider_account_id = (SELECT provider_account_id FROM control_models.model_route WHERE route_id = $route_id)
  AND credential_status IN ('active', 'rotating');

-- Gate 3: Route enabled
SELECT is_enabled FROM control_models.model_route WHERE route_id = $route_id;
```

---

### 5.4 `hive budget`

Hierarchical spend caps and tracking:

```
hive budget show [--scope global|project|agency|provider_account|route|proposal] [--id <uuid>] [--format json|table]
  Output (per scope): daily_cap_usd, monthly_cap_usd, consumed_today_usd, consumed_mtd_usd, burn_projection_pct

hive budget set <scope> <id> --daily <usd> --monthly <usd> [--yes]
  Update cap. Scope: global | project <id> | agency <id> | provider_account <id> | route <id> | proposal P###
  Example: hive budget set project 12345-uuid --daily 1000 --monthly 30000

hive budget consumed <scope> <id> [--since <duration>]
  Show detailed spend breakdown by model, agency, provider_account.

hive budget freeze <scope> <id> [--reason <text>] [--yes]
  Admin-only: prevent this scope from incurring further spend.
```

---

### 5.5 `hive context-policy`

Context window and retrieval strategy:

```
hive context-policy show [--scope global|project|agency|proposal] [--id <uuid>]
  Output: max_prompt_tokens, max_history_tokens, retrieval_policy (none|kb_topk|kb_vector|full_proposal_chain),
           retrieval_topk, summarization_policy, truncation_behavior

hive context-policy set <scope> [--id <uuid>] --max-prompt-tokens <int> --max-history-tokens <int> \
                        --retrieval <policy> [--retrieval-topk <int>] --summarization <policy> [--yes]
  Update context policy for a scope.
  Example: hive context-policy set project --id 123-uuid --max-prompt-tokens 80000 --retrieval kb_topk --retrieval-topk 10
```

---

## 6. Dispatch / Queue / Offer Domain

### 6.1 `hive dispatch`

Work dispatch inspection and lifecycle:

```
hive dispatch list [--state assigned|active|blocked|completed|cancelled|failed] [--age >30m] [--proposal P###] [--format json|table]
  Output: dispatch_id, proposal_id, agency_identity, state, created_at, last_activity_at

hive dispatch show <dispatch_id> [--include offers|claims|runs|events]
  Full dispatch record with optional nested details.

hive dispatch cancel <dispatch_id> [--reason <text>] [--yes]
  Mark dispatch as cancelled. Requires --yes. Writes to operator_action_log.

hive dispatch retry <dispatch_id> [--yes]
  Force re-claim within retry policy. Resets attempt count if under max_retries.

hive dispatch reissue <dispatch_id> [--reason <text>] [--yes]
  Mark old dispatch as terminal (failed), post new dispatch with fresh idempotency key.
  For stuck or permanently broken work.
```

---

### 6.2 `hive offer`

Work offer (claim opportunity) inspection:

```
hive offer list [--open | --claimed | --proposal P###] [--format json|table]
  Output: offer_id, proposal_id, state (open|claimed|expired), role, created_at, claimed_by

hive offer show <offer_id>
  Full offer: dispatch_id, required_capabilities, budget_scope, claims (nested).

hive offer expire <offer_id> [--reason <text>] [--yes]
  Force offer expiration (mark for cleanup). Requires --yes.

hive offer reissue <offer_id> [--reason <text>] [--yes]
  Close expired offer and post new one with same dispatch_id.
```

**Auto-escalation (in `hive doctor`):**
- Offers open > N minutes without claims trigger escalation.

---

### 6.3 `hive queue`

Implicit gate queue (proposal maturity → dispatch):

```
hive queue show [--workflow rfc|hotfix] [--format json|table]
  List mature proposals awaiting gate transition to Develop.
  Output: proposal_id, title, state (Review), maturity (mature), dependencies_met, ready_for_gate

hive queue gate-readiness P###
  Why is this proposal gate-ready or gate-blocked?
  Output: status (ready|blocked), checks (list of passed/failed AC, dependency status).
```

---

### 6.4 `hive transition`

State transition history (read-only audit):

```
hive transition history P### [--since <duration>] [--format json|table]
  Audit log of all state transitions for a proposal.

hive transition pending [--workflow rfc|hotfix] [--format json|table]
  List proposals waiting for state machine advancement.
```

---

## 7. Cubic + Worktree Domain

### 7.1 `hive cubic`

Per-agent cubic (execution context) lifecycle:

```
hive cubic list [--agent <identity>] [--proposal P###] [--status active|idle|orphaned]
  Output: cubic_id, agent_identity, proposal_id, worktree_path, last_activity_at

hive cubic info <cubic_id>
  Full record: worktree_path, agent, proposal, dispatch, age, file_count, memory_footprint.

hive cubic clean <cubic_id> [--reason <text>] [--yes]
  Release + remove (release lease, delete worktree from filesystem).
  Destructive; requires --yes.

hive cubic repair [--dry-run] [--yes]
  Reconcile cubics table against actual /data/code/worktree-* filesystem state.
  --dry-run: report discrepancies without fixing.
  Uses canonical repair script from P447.

hive cubic gc [--idle >60m] [--dry-run]
  Garbage-collect idle cubics older than threshold.
  --dry-run: report what would be cleaned.
```

---

### 7.2 `hive worktree`

Git worktree reconciliation:

```
hive worktree list
  Show all git worktrees (from git worktree list).

hive worktree prune [--dry-run] [--yes]
  Remove orphaned git worktrees not in cubics table.
  Requires --yes.
```

---

## 8. Operator Stop / Cancel Domain

The most safety-critical surface. Every stop writes to `operator_action_log` with actor, scope, reason, and result.

### 8.1 `hive stop`

Top-level stop verb routing to scope-specific handlers:

```
hive stop dispatch <id> [--reason <text>] [--yes]
  Mark dispatch as cancelled. Idempotent on retry.
  Writes: operator_action_log(scope=dispatch, scope_id, actor, reason, result).

hive stop proposal P### [--reason <text>] [--yes]
  Cancel all active dispatches on this proposal.
  Cascades to all open/active/claimed dispatches tied to P###.

hive stop agency <identity> [--reason <text>] [--yes]
  Suspend agency (blocks new claims, does NOT kill active workers).

hive stop host <name> [--grace 60s] [--reason <text>] [--yes]
  Drain host: acquire exclusive service_lease on all critical services,
  wait up to --grace for active dispatches to complete,
  prevent new spawns on this host.

hive stop worker <worker_id> [--signal TERM|KILL] [--reason <text>] [--yes]
  Terminate OS process AND mark dispatch as failed atomically.
  Requires --yes.

hive stop route <route_id> [--reason <text>] [--yes]
  Block route (is_enabled = false). Prevents new spawns.

hive stop all --scope <project|agency|...> [--reason <text>] [--yes] [--really-yes]
  Panic button. Stops all dispatches in a given scope.
  Requires BOTH --yes AND --really-yes.
```

**Atomicity & Idempotence:**
- Each stop is idempotent: same scope+reason = same effect on retry.
- If a stop partially fails (e.g., process killed but dispatch status update failed), re-running the same command completes the action.
- Writes to `operator_action_log` happen last; if already present for this scope+reason, skip duplicate write.

---

## 9. Audit / Observability / Reporting

### 9.1 `hive audit feed`

Unified event log tailing:

```
hive audit feed [--project <id>] [--proposal P###] [--since <duration>] [--format jsonl|table]
  Tail proposal_event outbox + gate_decision_log + escalation_log + operator_action_log unified.
  Output (JSONL): timestamp, event_type, actor, scope, scope_id, reason, result, causal_id (per P443).
  
  Example:
    hive audit feed --since 10m --grep "escalation\|operator_action"
```

---

### 9.2 `hive audit search`

Server-side event filtering:

```
hive audit search --grep <pattern> [--since <duration>] [--project <id>] [--format jsonl|table]
  Full-text or regex search on event payloads.
```

---

### 9.3 `hive metrics show`

Daily/weekly rollups:

```
hive metrics show [--scope global|project|agency] [--id <uuid>] [--period day|week|month]
  Output: claims_per_hour, cost_per_run_usd, success_rate_pct, p95_latency_sec,
           budget_burn_projection_pct, average_context_tokens.
```

---

### 9.4 `hive report run`

Fixed operator reports:

```
hive report run <report-id> [--since <duration>] [--format json|csv|html]
  Catalog:
    - spending-summary: cost breakdown by project, agency, provider
    - escalation-summary: recent escalations and triggers
    - agency-utilization: claims/hour, success rate, p95 latency per agency
    - schema-drift: DDL differences from baseline
    - hardcoding-trend: uses of hardcoded paths/endpoints (per P448–P451 audit)
```

---

### 9.5 `hive escalation`

Escalation log inspection and resolution:

```
hive escalation list [--unresolved] [--since <duration>] [--format json|table]
  Output: escalation_id, severity (critical|warning|info), event_type, scope, scope_id,
           triggered_at, resolved_at, resolution_reason.

hive escalation resolve <escalation_id> [--reason <text>] [--yes]
  Mark as resolved. Writes to operator_action_log.
```

---

## 10. SQL Edge-Cases Domain (Power-User)

For operators who need direct DB access **without leaving the CLI**:

### 10.1 `hive sql exec`

Execute arbitrary read-only or write SQL:

```
hive sql exec <query> [--format json|csv|table] [--write]
  Run SQL against control DB. Schema-qualifies automatically if missing (warns on attempt).
  --write: required for INSERT/UPDATE/DELETE; logs to operator_action_log with actor + query hash.
  
  Example (read-only):
    hive sql exec "SELECT COUNT(*) FROM control_dispatch.squad_dispatch WHERE dispatch_status = 'active'"
  
  Example (write, with --write flag):
    hive sql exec "UPDATE control_budget.budget_cap SET monthly_usd = 10000 WHERE scope_id = ..." --write --yes
```

---

### 10.2 `hive sql explain`

EXPLAIN ANALYZE wrapper:

```
hive sql explain <query>
  Run EXPLAIN ANALYZE and pretty-print the plan.
```

---

### 10.3 `hive sql snapshot`

Export a table for offline analysis:

```
hive sql snapshot --table <fqn> [--where <condition>] [--format jsonl|csv]
  Export rows to stdout (piping to files is up to the operator).
  Example: hive sql snapshot --table control_dispatch.squad_dispatch --where "dispatch_status = 'failed'" --format jsonl
```

---

## 11. Safety, Audit, and Confirmation Conventions

All destructive commands follow a strict pattern:

| Property | Standard |
| :--- | :--- |
| **Requires `--yes`?** | Yes, for all destructive actions (stop, release, remove, rotate, freeze, cancel). |
| **Requires `--really-yes`?** | Yes, for panic operations (stop all, freeze global). |
| **Writes to `operator_action_log`?** | Yes, all writes include actor, scope, reason, result. |
| **Idempotent on retry?** | Yes. Retry with same parameters has no additional side effects. |
| **Reversible?** | Scope-dependent (see below). |
| **Scope** | Explicit in command (dispatch, proposal, agency, host, worker, route, all). |

**Reversibility Matrix:**
| Command | Reversible | Notes |
| :--- | :--- | :--- |
| `hive stop dispatch` | Partial | Can reissue new dispatch, but original is terminal. |
| `hive stop proposal` | Partial | Stop all dispatches; proposal remains in current state until manually transitioned. |
| `hive stop agency` | Yes | `hive agency resume` unfreezes. |
| `hive stop host` | Yes | Drain is not permanent; new work can be scheduled once drain expires. |
| `hive stop worker` | No | Process is killed; dispatch marked failed. No undo. |
| `hive stop route` | Yes | `hive model enable` re-enables. |
| `hive lease release` | Partial | Proposal can be re-claimed by another agency. |
| `hive provider account remove` | No | Account is revoked; must provision a new one. |
| `hive provider account rotate` | Yes | Can revert to old credential during rotating phase. |
| `hive budget freeze` | Yes | `hive budget set` with new caps unfreezes. |

---

## 12. Destructive Action Matrix

Every destructive command in the catalog, with safety requirements:

| Command | Scope | Requires `--yes` | Requires `--really-yes` | Idempotent | Reversible | Audit Log |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `service restart` | service | Yes | No | Yes | Yes (re-restart) | Yes |
| `agency suspend` | agency | Yes | No | Yes | Yes (resume) | Yes |
| `lease release` | dispatch | Yes | No | Yes | Partial | Yes |
| `dispatch cancel` | dispatch | Yes | No | Yes | Partial | Yes |
| `dispatch reissue` | dispatch | Yes | No | Yes | Partial | Yes |
| `offer expire` | offer | Yes | No | Yes | Partial | Yes |
| `cubic clean` | cubic | Yes | No | Yes | No | Yes |
| `worktree prune` | worktree | Yes | No | Yes | No | Yes |
| `provider account remove` | provider | Yes | No | Yes | No | Yes |
| `provider account rotate` | provider | Yes | No | Yes | Yes (revert) | Yes |
| `model disable` | route | Yes | No | Yes | Yes (enable) | Yes |
| `budget freeze` | budget | Yes | No | Yes | Yes (set) | Yes |
| `stop dispatch` | dispatch | Yes | No | Yes | Partial | Yes |
| `stop proposal` | proposal | Yes | No | Yes | Partial | Yes |
| `stop agency` | agency | Yes | No | Yes | Yes (resume) | Yes |
| `stop host` | host | Yes | No | Yes | Yes (drain expires) | Yes |
| `stop worker` | worker | Yes | No | Yes | No | Yes |
| `stop route` | route | Yes | No | Yes | Yes (enable) | Yes |
| `stop all` | scope | Yes | **Yes** | Yes | Partial | Yes |

---

## 13. SQL Library & Query Patterns

The CLI ships curated read queries mapping command flags to SQL. Schema qualification is automatic; compatibility shim used during P436 migration.

### Pattern 1: Active Dispatches > N Minutes Old
```sql
SELECT
  d.dispatch_id,
  p.proposal_id,
  a.identity,
  d.dispatch_status,
  EXTRACT(EPOCH FROM (now() - d.created_at)) / 60 AS age_minutes
FROM control_dispatch.squad_dispatch d
  JOIN control_workflow.proposal p ON d.proposal_id = p.id
  JOIN control_workforce.agency a ON d.agency_id = a.id
WHERE d.dispatch_status IN ('open', 'claimed', 'active')
  AND EXTRACT(EPOCH FROM (now() - d.created_at)) > ($age_minutes * 60)
ORDER BY d.created_at ASC;
```

### Pattern 2: Open Offers Without Claimers
```sql
SELECT
  o.offer_id,
  d.dispatch_id,
  p.proposal_id,
  o.created_at,
  EXTRACT(EPOCH FROM (now() - o.created_at)) / 60 AS open_minutes
FROM control_dispatch.work_offer o
  JOIN control_dispatch.squad_dispatch d ON o.dispatch_id = d.id
  JOIN control_workflow.proposal p ON d.proposal_id = p.id
WHERE o.offer_status = 'open'
  AND o.created_at < now() - interval '10 minutes'
ORDER BY o.created_at ASC;
```

### Pattern 3: Expired Leases
```sql
SELECT
  l.lease_id,
  p.proposal_id,
  a.identity,
  l.expires_at,
  EXTRACT(EPOCH FROM (now() - l.expires_at)) / 60 AS expired_minutes
FROM control_dispatch.dispatch_lease l
  JOIN control_workflow.proposal p ON l.proposal_id = p.id
  JOIN control_workforce.agency a ON l.agency_id = a.id
WHERE l.expires_at < now()
  AND l.released_at IS NULL
ORDER BY l.expires_at ASC;
```

### Pattern 4: Cubic GC (Idle > N Hours)
```sql
SELECT
  c.cubic_id,
  a.identity,
  c.worktree_path,
  c.last_activity_at,
  EXTRACT(EPOCH FROM (now() - c.last_activity_at)) / 3600 AS idle_hours
FROM control_runtime.cubic c
  JOIN control_workforce.agency a ON c.agency_id = a.id
WHERE c.status = 'idle'
  AND c.last_activity_at < now() - interval '1 hour' * $idle_hours
ORDER BY c.last_activity_at ASC;
```

### Pattern 5: Doctor Health Checks
```sql
-- Service status
SELECT service_name, status FROM control_runtime.systemd_service
WHERE status != 'running' AND status != 'inactive';

-- MCP reachability (HTTP GET via spawner, not SQL)

-- Orphan leases
SELECT lease_id, proposal_id FROM control_dispatch.dispatch_lease
WHERE expires_at < now() AND released_at IS NULL;

-- Escalation storms
SELECT COUNT(*) FROM control_audit.escalation_log
WHERE created_at > now() - interval '1 hour' AND severity IN ('critical', 'warning');

-- Low disk
SELECT partition, percent_used FROM sys.partition_usage
WHERE mountpoint = '/data/code/worktrees' AND percent_used > 90;
```

---

## 14. Migration from Legacy Commands

Legacy `roadmap` CLI commands are absorbed into `hive` or retired:

| Legacy Command | New Home | Notes |
| :--- | :--- | :--- |
| `roadmap service ...` | `hive service` | Unchanged semantics (systemctl wrapper). |
| `roadmap state-machine start\|stop\|restart\|status` | `hive service` subcommands | Unified service management. |
| `roadmap state-machine agencies` | `hive agency list` | Moved to workforce domain. |
| `roadmap state-machine offers` | `hive dispatch list --state open` | Integrated into dispatch domain. |
| `roadmap orchestrate` | TUI/web or `hive service logs` | Was interactive setup; interactive features move to TUI. |
| `roadmap mcp ...` | `hive mcp` | Unchanged. |
| `roadmap cubic ...` | `hive cubic` | Unchanged. |
| `roadmap sandbox ...` | Removed / TUI | Sandbox inspection moves to web/TUI. |

**Grace Period:** Legacy commands remain as thin forwarders to new ones for 2 release cycles, with deprecation warnings. After grace, they are removed.

---

## 15. Distributed Authorization Model

The CLI enforces authorization based on the invoking user/actor:

- Actors are resolved from `control_identity.human_user` or `control_identity.service_user`.
- All operations write `actor_id` to `operator_action_log`.
- Sensitive operations (budget freeze, provider rotate, service restart) require `--reason` for audit.
- Escalation-level operations (stop all, panic drain) require `--really-yes` in addition to `--yes`.

The CLI does NOT implement permission checks itself. That is delegated to:
- Database role-based access control (systemd services, credential storage, etc.).
- Service-side authorization (MCP methods, spawner policy, etc.).

---

## 16. Implementation Phasing

| Phase | Scope | Deliverables |
| :--- | :--- | :--- |
| **Phase 1: Core Service Ops** | Service management, doctor, logging | `hive service`, `hive doctor`, `hive mcp`, `hive db`, `hive log` |
| **Phase 2: Workforce & Dispatch** | Agency, worker, lease, dispatch, offer | `hive agency`, `hive worker`, `hive lease`, `hive dispatch`, `hive offer` |
| **Phase 3: Provider & Budget** | Accounts, models, routes, budgeting | `hive provider`, `hive model`, `hive route`, `hive budget`, `hive context-policy` |
| **Phase 4: Queue & Transition** | Gate queue, state machine audit | `hive queue`, `hive transition` |
| **Phase 5: Cubic & Worktree** | Cubic lifecycle, worktree reconciliation | `hive cubic`, `hive worktree` |
| **Phase 6: Stop & Escalation** | Emergency stops, audit feed, reporting | `hive stop`, `hive audit`, `hive metrics`, `hive report`, `hive escalation` |
| **Phase 7: SQL Escape Hatch** | Power-user operations | `hive sql` (exec, explain, snapshot) |
| **Phase 8: Integration & Polish** | Cross-domain testing, output formatting, help text | All commands support `--format`, `-h`, shell completion |

---

## 17. Acceptance Criteria (Per P441, P434, P442, P446)

- [ ] All commands support `--format json|jsonl|yaml|table` output (table is default).
- [ ] All destructive commands require `--yes` flag and write to `operator_action_log`.
- [ ] `hive doctor` runs 12 checks with severity levels and remediation hints.
- [ ] `hive stop <scope>` is idempotent and atomic across all scope types.
- [ ] SQL queries are schema-qualified with `control_*` prefixes (or compatibility shims during P436 migration).
- [ ] Every operator action is logged with actor, scope, reason, and result in `control_audit.operator_action_log`.
- [ ] Help text (`-h`, `--help`) is available on every command and subcommand.
- [ ] All commands are scriptable (no interactive prompts except `--yes` confirmation on destructive ops).
- [ ] Integration tests cover the most critical workflows (service start/stop, dispatch cancel, budget check, stop all).
- [ ] Documentation includes examples for the top 10 operator tasks.

---

**Version:** 1.0  
**Status:** Approved for implementation (P441, P434, P442, P446)  
**Last Updated:** 2026-04-24
