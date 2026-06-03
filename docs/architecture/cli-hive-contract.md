# `hive` CLI: Normative Implementation Contract

**Purpose:** Single source of truth for P455 Round 2/3 implementers (Senior Dev, MCP Builder, Backend Architect, DA, DevOps, SRE, API Tester).

**Status:** Approved for development. Supersedes contradictions in `cli-hive-design.md`, `cli-hive-ai-ergonomics.md`, and `cli-hive-system-ops.md`.

**Last Updated:** 2026-04-26

---

## 1. Command Tree (Normative)

**Two-level structure:** `hive <domain> <action>` or `hive <action>` for universal commands.

**Scope:** This contract covers all commands in the three design docs. The mapping table at the end (§9) is exhaustive.

| Domain | Actions | MCP Required | Destructive |
|--------|---------|-------------|------------|
| **project** | info, register, archive, list | N (read), Y (mutations) | Y (archive) |
| **proposal** | create, get, list, search, edit, claim, release, transition, maturity, depend, ac (add/list/verify), review, discuss, show | Y (mutations) | Y (transition, release) |
| **workflow** | list, show, gates, next | N | N |
| **state** | next, history | N | N |
| **document** | list, get, sync, decision | N (read), Y (sync write) | N |
| **agency** | list, info, subscribe, suspend, resume, concurrency | N | Y (suspend) |
| **worker** | list, info, terminate | N (read), Y (terminate) | Y (terminate) |
| **lease** | list, release, expired, hold | N (read), Y (release/hold) | Y (release) |
| **provider** | list, info, account (add/remove/rotate), set-quota | N (read), Y (mutations) | Y (remove, rotate) |
| **model** | list, info, enable, disable, cost | N (read), Y (toggle) | Y (disable) |
| **route** | list, show, test, priority, toggle | N (read), Y (toggle/priority) | Y (toggle) |
| **budget** | show, set, consumed, freeze | N (read), Y (mutations) | Y (freeze) |
| **context-policy** | show, set | N (read), Y (set) | N |
| **dispatch** | list, show, cancel, retry, reissue | N (read), Y (mutations) | Y (cancel, reissue) |
| **offer** | list, show, expire, reissue | N (read), Y (mutations) | Y (expire) |
| **queue** | show, gate-readiness | N | N |
| **service** | list, status, restart, start, stop, logs, drain | N | Y (restart, stop, drain) |
| **mcp** | ping, smoke, health, tools | N | N |
| **db** | migrate, check, rollback, schema-diff | N | Y (migrate, rollback) |
| **cubic** | list, info, clean, repair, gc | N | Y (clean, repair, gc) |
| **audit** | feed, events, search, metrics, report | N | N |
| **scan** | (scan command, type + format) | N | N |
| **lint** | (lint command, fix + strict) | N | N |
| **knowledge** | kb (add/search), memory (show/set/delete) | N (kb search), Y (kb add, memory mutations) | N |
| **doctor** | (single cmd, --remediate) | N | N |
| **board/web/tui** | board, web, tui | N | N |
| **util** | help, version, completion, init, status, context, doctor | N/Y (init requires control-plane) | N |

**Resolution of contradictions:**

1. **State names from control plane (§1.5 ci-hive-design.md vs hardcoding risk):** Adopted **ci-hive-design.md**. All state names loaded at CLI startup from `workflow_template` table. Commands validate against loaded names at runtime, never hardcode. See `getStateNames()` in core/workflow/state-names.ts (P453).

2. **MCP for mutations vs direct DB fallback:** Adopted **cli-hive-ai-ergonomics.md §7.1**. Mutations (create, claim, transition, maturity, ac verify, etc.) REQUIRE MCP—never bypass. Reads (proposal get, list) fall back to direct DB if MCP unreachable. Failure mode for mutations when MCP is down: return exit code 12 (`MCP_UNREACHABLE`), not a silent DB write.

3. **Idempotency scope:** Adopted **cli-hive-ai-ergonomics.md §3.1**. Key is idempotent per `(agency_id, project_id, idempotency_key, command_signature)`. Same key with different agency or project creates a new result.

4. **Format defaults (text vs json):** Adopted **cli-hive-design.md §2.5**. Default `text` for TTY, auto-detect. Non-TTY defaults to `json`. Explicit `--format` always overrides.

5. **Confirmation prompt pattern:** Adopted **cli-hive-design.md §2.6**. Destructive operations require `--yes`. Panic operations (stop all, freeze global) require both `--yes` AND `--really-yes`. Non-TTY without --yes = exit code 4 (conflict).

---

## 2. JSON Envelope Schema (Normative)

**Every JSON response** (success or error) must follow this envelope. This is the AI-agent contract.

### 2.1 Success Response

```json
{
  "schema_version": 1,
  "command": "hive proposal get",
  "context": {
    "project": "agenthive",
    "agency": "hermes/agency-xiaomi",
    "host": "hermes",
    "mcp_url": "http://127.0.0.1:6421/sse",
    "db_host": "127.0.0.1",
    "db_port": 5432,
    "resolved_at": "2026-04-25T14:30:00.123Z"
  },
  "ok": true,
  "data": { /* command-specific payload */ },
  "warnings": [ /* non-fatal warnings */ ],
  "next_cursor": null,
  "elapsed_ms": 234
}
```

| Field | Required | Type | Notes |
|-------|----------|------|-------|
| `schema_version` | yes | integer | Current: 1. Increments on breaking changes. |
| `command` | yes | string | Full command string (e.g., `hive proposal get`). |
| `context` | yes | object | Resolved runtime context (project, agency, host, mcp_url, db_host, db_port, resolved_at). |
| `ok` | yes | boolean | true = success, false = error. Mutually exclusive with `error`. |
| `data` | no | object/array | Command-specific payload. Only if `ok: true`. |
| `warnings` | no | array | Non-fatal warnings (schema drift, deprecated flags, soft limits). |
| `next_cursor` | no | string\|null | For paginated responses, cursor for next page. |
| `elapsed_ms` | yes | integer | Wall-clock milliseconds from entry to response ready. |

### 2.2 Error Response

```json
{
  "schema_version": 1,
  "command": "hive proposal claim P999",
  "context": { /* as above */ },
  "ok": false,
  "error": {
    "code": "PROPOSAL_NOT_FOUND",
    "message": "Proposal P999 does not exist in project 'agenthive'.",
    "hint": "Run `hive proposal list --format json` to see available IDs.",
    "detail": {
      "proposal_id": "P999",
      "project": "agenthive"
    },
    "retriable": false,
    "exit_code": 2
  },
  "warnings": [],
  "elapsed_ms": 87
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `code` | string | yes | Stable error code (SCREAMING_SNAKE_CASE, see §3). |
| `message` | string | yes | Human-readable description. |
| `hint` | string | no | Actionable recovery hint. |
| `detail` | object | no | Command-specific error context. |
| `retriable` | boolean | yes | true = transient (rate limit, timeout); retry likely succeeds. |
| `exit_code` | integer | yes | POSIX exit code (0–127, 99 for internal). |

### 2.3 Schema Version Policy

- Increment `schema_version` only on breaking changes (removed/renamed fields, changed types, incompatible validation).
- When CLI schema_version < control-plane schema_version: emit warning (SCHEMA_DRIFT_DETECTED).
- When CLI schema_version is incompatible with control-plane (gap > 1 major version): refuse mutations with error code SCHEMA_DRIFT.
- AI agents target a range (e.g., schema 1.x accepts 1.0–1.99). Mismatch is a structured error, not silent.

---

## 3. Exit Code Enum (Normative)

| Code | Name | Trigger Condition | User-Visible Message | Retriable |
|------|------|-------------------|----------------------|-----------|
| **0** | SUCCESS | Operation completed successfully | (no error message) | N/A |
| **1** | USAGE | Invalid flags, missing arguments, wrong type | "Usage: hive proposal claim <proposal_id>" | No |
| **2** | NOT_FOUND | Resource does not exist (proposal, agency, route, etc.) | "Proposal P999 does not exist in project 'agenthive'" | No |
| **3** | PERMISSION_DENIED | User/agency lacks required role or permission | "Agency cannot claim a proposal in MERGE state" | No |
| **4** | CONFLICT | State conflict: already claimed, immutable state, budget exceeded, destructive op in non-TTY without --yes | "Proposal already claimed by hermes/agency-alpha" | No |
| **5** | REMOTE_FAILURE | MCP timeout, DB connection lost, service down, provider rate-limit | "MCP server timed out after 5s" | Yes |
| **6** | INVALID_STATE | Proposal state does not allow this operation | "Cannot claim proposal in COMPLETE state" | No |
| **7** | BUDGET_EXHAUSTED | Budget cap reached (global, project, agency, dispatch) | "Project monthly budget ($5000) exhausted" | No |
| **8** | POLICY_DENIED | Host policy, provider policy, security policy blocks operation | "Host 'hermes' does not allow Anthropic models" | No |
| **9** | TIMEOUT | Operation exceeded time limit (scan >120s, MCP poll timeout) | "Scan timed out after 120 seconds" | Yes |
| **10** | RATE_LIMITED | API or service rate limit hit | "Too many MCP requests; retry in 30s" | Yes |
| **11** | SCHEMA_DRIFT | CLI schema_version incompatible with control-plane | "CLI schema v1 cannot parse schema_version 2" | No |
| **12** | MCP_UNREACHABLE | MCP server not reachable; mutation refused | "MCP server at http://127.0.0.1:6421/sse unreachable" | Yes |
| **13** | DB_UNREACHABLE | Direct database unreachable; fallback unavailable | "Cannot connect to agenthive@127.0.0.1:5432" | Yes |
| **14** | ENCODING_ERROR | Encoding/serialization failure (invalid JSON input) | "Invalid JSON in --stdin" | No |
| **99** | INTERNAL_ERROR | Unexpected server error; likely a bug | "Nil pointer exception in proposal claim handler" | Yes |

---

## 4. Error Code Catalog (Normative)

Every error returned in `error.code` must map to the exit code table above. This is exhaustive per command.

| Error Code | Exit | Command Examples | Trigger |
|------------|------|------------------|---------|
| USAGE | 1 | proposal create (missing --title), proposal claim (missing proposal_id), invalid --format | Missing required arg/flag, invalid flag value, malformed positional |
| NOT_FOUND | 2 | proposal get P999, agency info foo-id, workflow show invalid-template | Resource does not exist in DB |
| PERMISSION_DENIED | 3 | proposal claim (agency not allowed in state), provider rotate (non-ops), budget freeze (non-ops) | Actor role insufficient, lease ownership check fails |
| CONFLICT | 4 | proposal claim (already claimed), proposal transition (invalid transition), destructive op in non-TTY without --yes | State conflict, immutable constraint violated, missing --yes in non-TTY |
| REMOTE_FAILURE | 5 | (any MCP call when MCP times out), (any DB call when DB unreachable) | Network timeout, service unavailable, connection refused |
| INVALID_STATE | 6 | proposal claim (cannot claim in COMPLETE state), proposal edit (not in DRAFT state for type change) | State machine does not allow operation |
| BUDGET_EXHAUSTED | 7 | proposal create/claim/transition (would exceed cap), dispatch (route budget exhausted) | Budget cap check failed |
| POLICY_DENIED | 8 | dispatch (host_model_policy forbids provider), route test (credential inactive) | Authorization gate (host policy, provider policy, credential state) |
| TIMEOUT | 9 | scan (>120s), db migrate (>300s), service restart (--wait-for-ready times out) | Operation exceeded wall-clock limit |
| RATE_LIMITED | 10 | (MCP returns 429), (DB returns rate-limit error) | Service rate limit hit |
| SCHEMA_DRIFT | 11 | (response schema_version > CLI schema_version by >1) | Incompatible schema version gap |
| MCP_UNREACHABLE | 12 | proposal create (MCP down), proposal claim (MCP timeout), any mutation when MCP unreachable | MCP server not reachable; mutation refused |
| DB_UNREACHABLE | 13 | (direct DB read fallback unavailable), (no MCP and no DB) | Database connection unavailable |
| ENCODING_ERROR | 14 | proposal create --stdin (invalid JSON), lease hold (duration parse error) | Input encoding failure |
| INTERNAL_ERROR | 99 | (unexpected exception in handler) | Bug in CLI code |

---

## 5. Context Resolution Rules (Normative)

**Explicit hierarchy (highest to lowest precedence):**

1. **Flag:** `--project P`, `--agency A`, `--host H` override everything.
2. **Environment:**
   - `HIVE_PROJECT=<slug>` (e.g., `agenthive`, `monkeyKing-audio`)
   - `HIVE_AGENCY=<identity>` (e.g., `hermes/agency-xiaomi`)
   - `HIVE_HOST=<hostname>` (e.g., `hermes`, `claude-box`)
3. **CWD-derived:** Walk up filesystem from `$PWD`:
   - Check if `$PWD` is under a git worktree registered in `control_runtime.cubic` with `worktree_root` as a parent.
   - If found, use `cubic.agency_id` to resolve agency; use `cubic.proposal_id` to resolve project (via roadmap_proposal join).
   - If not in a worktree, check for `.hive/config.json` in repo root (see `getProjectRoot()` from P448) with `project` and `agency` hints.
   - If no `.hive/config.json`, check `roadmap.yaml` in repo root (if it exists) for `project:` and `mcp.url:` hints.
   - If in a git repo, consult `control_project.project_registry` table to match `git_repo_url` against `project.repo_url` to infer project.
4. **Control-plane default:** Query `control_identity.human_user` for `default_project_id` and `default_agency_id`.
5. **Fail-fast:** If no context can be resolved, exit code 2 (NOT_FOUND) with message: "Cannot resolve project/agency context. Set `--project`, `HIVE_PROJECT` env, or `$PWD/.hive/config.json`, or register default in control plane. See `hive help context`."

**Special case — global commands** (`help`, `version`, `completion`, `init`): Don't require project/agency context.

---

## 6. MCP-vs-Control-DB Routing Rules (Normative)

**Routing decision tree:**

```
Mutation (create, claim, transition, maturity, ac verify, release, suspend, etc.)?
  YES → MUST use MCP (audit trail required)
        If MCP unreachable → return error code 12 (MCP_UNREACHABLE), exit 12
        If MCP request fails → return error code 5 (REMOTE_FAILURE), exit 5 (retriable)
  
  NO (read-only) → Try MCP first (full context, optimized)
                   On MCP timeout/unreachable → fallback to direct DB query
                   On DB timeout/unreachable → return error code 5/13 (retriable)
                   Emit warning (optional) if fell back to DB
```

**Commands that REQUIRE MCP (mutations):**
- `proposal create, edit, claim, release, transition, maturity, depend, ac add/verify, review, discuss`
- `dispatch cancel, retry, reissue`
- `offer expire, reissue`
- `agency subscribe, suspend, resume`
- `provider account add/remove/rotate, set-quota`
- `model enable/disable, cost set`
- `route priority, toggle`
- `budget set, freeze`
- `lease release, hold`
- `service restart, start, stop, drain`
- `db migrate, rollback`
- `cubic clean, repair, gc`
- `stop dispatch/proposal/agency/host/worker/route/all`

**Commands that read from DB (fallback allowed):**
- `proposal get, list, search`
- `workflow list, show, gates, next`
- `state next, history`
- `document list, get`
- `agency list, info, concurrency show`
- `worker list, info`
- `lease list, expired`
- `provider list, info`
- `model list, info, cost show`
- `route list, show, test`
- `budget show, consumed`
- `context-policy show`
- `dispatch list, show`
- `offer list, show`
- `queue show, gate-readiness`
- `audit feed, events, search, metrics, report`
- `cubic list, info`

**Failure mode for mutations when MCP is down:**

Example: `hive proposal claim P123 --idempotency-key <uuid>` with MCP unreachable.

```json
{
  "ok": false,
  "error": {
    "code": "MCP_UNREACHABLE",
    "message": "MCP server at http://127.0.0.1:6421/sse is not reachable.",
    "hint": "Run `hive doctor` to diagnose. Check that agenthive-mcp.service is running.",
    "retriable": true,
    "exit_code": 12
  }
}
```

NEVER silently fall back to direct DB for mutations. The audit trail (proposal_event outbox, lease tracking, gate decision log) is sacred.

---

## 7. Idempotency Contract (Normative)

**Every mutating command accepts `--idempotency-key <uuid>`:**

```bash
hive proposal claim P123 --idempotency-key 550e8400-e29b-41d4-a716-446655440000
```

**Behavior on repeated invocation:**

1. **First call:** Execute normally, return result with `idempotent_replay: false`.
2. **Retry (same key, same agency, same project, same command_signature):** Return cached result from previous invocation with `idempotent_replay: true`. No new work done.
3. **Cross-agency retry (same key, different agency):** Treat as new invocation; create new result. Different scope = different key domain.

**Scope:** `(agency_id, project_id, idempotency_key, command_signature)`.

**TTL:** Idempotency cache kept for 24 hours. After expiry, same key is treated as new invocation.

**Response format:**

Success:
```json
{
  "ok": true,
  "data": {
    "proposal_id": "P123",
    "lease_id": "lease-99",
    "idempotent_replay": false,
    "idempotency_key": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

Replay:
```json
{
  "ok": true,
  "data": {
    "proposal_id": "P123",
    "lease_id": "lease-99",
    "idempotent_replay": true,
    "idempotency_key": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

---

## 8. Discovery Commands (Normative)

### 8.1 `hive --schema`

Returns full command tree schema as JSON. Called once per agent session to understand CLI surface.

**Input:** None.

**Output:** Schema object with all commands, subcommands, flags, types, descriptions.

```json
{
  "schema_version": 1,
  "cli_version": "0.5.0",
  "mcp_protocol_version": "1.0",
  "commands": [
    {
      "name": "proposal",
      "aliases": ["proposals"],
      "description": "Proposal CRUD and lifecycle management",
      "subcommands": [
        {
          "name": "get",
          "signature": "hive proposal get <proposal_id>",
          "description": "Fetch a single proposal by ID",
          "parameters": [
            {
              "name": "proposal_id",
              "type": "string",
              "required": true,
              "example": "P123"
            }
          ],
          "flags": [
            {
              "name": "include",
              "type": "string[]",
              "repeatable": true,
              "description": "Expand relations: leases, dispatches, ac, dependencies, discussions, gate_status, all",
              "example": "--include leases --include ac"
            },
            {
              "name": "format",
              "type": "enum",
              "enum": ["text", "json", "yaml"],
              "default": "text"
            }
          ],
          "output": {
            "type": "object",
            "schema": { "proposal_id": "string", "title": "string", "state": "string", "maturity": "string" }
          },
          "idempotency": "idempotent",
          "formats_supported": ["text", "json", "yaml"]
        }
      ]
    }
  ]
}
```

### 8.2 `hive <domain> --schema`

Returns schema for a single domain.

```bash
hive proposal --schema
```

Output: Schema object for `proposal` domain only (subset of full schema).

### 8.3 `hive --recipes`

Returns curated multi-step workflows as JSONL. One recipe per line.

**Output:** JSONL, one recipe per line.

```jsonl
{"id":"claim-and-develop","title":"Pick next claimable proposal and start work","when_to_use":"Agent has capacity","steps":[{"cmd":"hive context --format json","reads":["agency","project"]},{"cmd":"hive proposal next --format json","reads":["proposal_id"]},{"cmd":"hive proposal claim ${proposal_id} --duration 4h","description":"Acquire lease"}],"terminal_state":"Proposal claimed, lease active, maturity=active"}
{"id":"audit-before-commit","title":"Scan for hardcoding, lint, run tests, commit","when_to_use":"Ready to commit changes","steps":[{"cmd":"hive scan --since HEAD --format json"},{"cmd":"hive lint --format sarif"}],"terminal_state":"Changes committed, scan clean"}
```

### 8.4 `hive doctor --format json`

Returns machine-readable health snapshot.

**Input:** None (or `--remediate <check-code>` to show remediation steps).

**Output:** JSON with overall_status, checks array, issues array, warnings array.

```json
{
  "schema_version": 1,
  "command": "hive doctor",
  "ok": true,
  "data": {
    "overall_status": "healthy",
    "checks": [
      {
        "name": "mcp_reachable",
        "status": "ok",
        "message": "MCP server reachable at http://127.0.0.1:6421/sse",
        "latency_ms": 42
      },
      {
        "name": "db_reachable",
        "status": "ok",
        "message": "Postgres 'agenthive' database reachable",
        "latency_ms": 18
      }
    ],
    "issues": [],
    "warnings": [
      {
        "code": "BUDGET_WARNING",
        "message": "Project 'agenthive' at 85% of monthly budget",
        "remaining_usd": 150
      }
    ]
  },
  "elapsed_ms": 234
}
```

---

## 9. Migration Boundary (Normative)

Exhaustive mapping: every `roadmap` command → `hive` command or explicit retirement.

| Legacy Command | Hive Equivalent | Status | Migration Notes |
|---|---|---|---|
| `roadmap init` | `hive init` | **Behavior change** | Now means control-plane registration, not filesystem init. Warning on first run. |
| `roadmap proposal create` | `hive proposal create` | **Kept** | Unchanged. |
| `roadmap proposal list` | `hive proposal list` | **Kept** | Unchanged. |
| `roadmap proposal get` | `hive proposal get` | **Kept** | Unchanged. |
| `roadmap proposal edit` | `hive proposal edit` | **Kept** | Unchanged. |
| `roadmap proposal claim` | `hive proposal claim` | **Kept** | Unchanged. |
| `roadmap proposal release` | `hive proposal release` | **Kept** | Unchanged. |
| `roadmap proposal transition` | `hive proposal transition` | **Kept** | Unchanged. |
| `roadmap draft` | `hive proposal create --type issue` | **Moved** | Subsumed into proposal create. |
| `roadmap draft list` | `hive proposal list --type issue` | **Moved** | Filter by type. |
| `roadmap draft promote` | `hive proposal transition P### REVIEW` | **Moved** | Explicit state transition. |
| `roadmap talk` | **Moved to TUI**: `hive board` | **Removed** | Real-time chat → TUI/web. |
| `roadmap chat` | **Moved to TUI**: `hive board` | **Removed** | Real-time chat → TUI/web. |
| `roadmap listen` | **Moved to TUI**: `hive board` or `hive audit feed` | **Removed** | Event stream → TUI board or audit CLI. |
| `roadmap orchestrate` | **Removed** | **Removed** | Orchestration is daemon-driven via control plane. |
| `roadmap browser` | `hive web` or `hive board` | **Removed** | Use `hive web` for browser, `hive board` for TUI. |
| `roadmap log` | `hive dispatch list` + `hive audit feed` | **Removed** | Log viewing → dispatch/audit feeds. |
| `roadmap directive[s]` | **Removed** | **Removed** | Milestones → workflow states + maturity. |
| `roadmap decision` | `hive decision record` or `hive proposal discuss` | **Renamed** | ADR-style decision capture. |
| `roadmap doc` | `hive doc list/get/sync` | **Kept** | Unchanged. |
| `roadmap config` | **Moved to TUI**: `hive board` settings panel | **Removed** | Config editing → TUI interactive mode. |
| `roadmap board` | `hive board` | **Kept** | Unchanged (TUI dashboard). |
| `roadmap agents` | `hive agency list` + `hive worker list` | **Renamed** | Agent listing → agency + worker commands. |
| `roadmap search` | `hive proposal search` | **Kept** | Unchanged. |
| `roadmap sequence[s]` | **Removed (moved to TUI)** | **Removed** | Workflow visualization → TUI board. |
| `roadmap service` | `hive service list/status/restart/logs` | **Kept** | Service ops unchanged (admin only). |
| `roadmap completion` | `hive completion` | **Kept** | Shell completion unchanged. |
| `roadmap overview` | `hive status` | **Renamed** | Project overview → `hive status`. |
| `roadmap mcp` | `hive mcp ping/smoke/health` | **Kept** | MCP diagnostic commands unchanged. |
| `roadmap cubic` | `hive cubic list/clean/repair/gc` | **Kept** | Cubic ops unchanged. |
| `roadmap state-machine` | `hive workflow show` + `hive state next` | **Renamed** | State machine inspection → `hive workflow`. |
| `roadmap db` | `hive db migrate/check/rollback` | **Kept** | DB ops unchanged (ops only). |

**Deprecation grace period:** 2 release cycles (months 1–2). Legacy `roadmap` commands emit deprecation warning and forward to `hive` equivalents. At month 3, binary can be removed.

---

## 10. Test Contract (Normative)

**API Tester and Code Reviewer must validate these golden fixtures and behavior:**

### 10.1 Golden JSON Fixtures (One Per Top-Level Domain)

Each fixture documents a successful command + full response envelope.

**Fixture: proposal/get-with-include-all.json**
```json
{
  "schema_version": 1,
  "command": "hive proposal get",
  "context": { "project": "agenthive", "agency": "hermes/agency-xiaomi", "host": "hermes", "mcp_url": "http://127.0.0.1:6421/sse", "resolved_at": "2026-04-25T14:30:00Z" },
  "ok": true,
  "data": {
    "proposal": { "id": "P123", "title": "...", "state": "DEVELOP", "maturity": "active" },
    "leases": [ ... ],
    "ac": [ ... ],
    "dependencies": [ ... ],
    "discussions": [ ... ],
    "gate_status": { "current_state": "DEVELOP", "next_legal_states": ["MERGE"], "blockers": [] }
  },
  "elapsed_ms": 234
}
```

**Fixtures to create:**
1. `proposal/get-with-include-all.json` — full proposal state in one call
2. `proposal/list-paginated.json` — list with next_cursor
3. `workflow/show-rfc.json` — state machine schema
4. `agency/list.json` — agency roster
5. `dispatch/list.json` — dispatch queue snapshot
6. `budget/show.json` — spend cap and consumption
7. `service/status.json` — systemd service roster
8. `audit/feed.json` — event log (JSONL)
9. `scan/findings.json` — hardcoding findings
10. `doctor/health.json` — readiness check results

### 10.2 Compatibility Scripts

Ensure legacy commands still work during grace period:

```bash
# Legacy roadmap command forwards to hive and emits warning
roadmap proposal list  # Should emit: "Warning: 'roadmap' deprecated. Use 'hive proposal list' instead."

# Legacy command + redirect
roadmap talk  # Should emit: "Removed. Use 'hive board' for TUI or 'hive proposal discuss' for async discussion."
```

### 10.3 Negative Test Suite

**Required test cases:**

1. **Exit code 1 (USAGE):**
   - `hive proposal create` (missing --title in non-interactive mode)
   - `hive proposal claim` (missing proposal_id)
   - `hive proposal claim P123 --invalid-flag` (unknown flag)

2. **Exit code 2 (NOT_FOUND):**
   - `hive proposal get P999` (proposal doesn't exist)
   - `hive workflow show invalid-template` (template not found)
   - `hive --project nonexistent proposal list` (project not registered)

3. **Exit code 3 (PERMISSION_DENIED):**
   - Non-ops tries `hive budget freeze --scope global` (requires op role)
   - Agency tries to claim proposal in MERGE state (state-gated permission)

4. **Exit code 4 (CONFLICT):**
   - `hive stop dispatch D123` without `--yes` in non-TTY (destructive requires --yes)
   - `hive proposal claim P123` when already claimed by another agency
   - `hive proposal transition P123 INVALID_STATE` (state not in legal transitions)

5. **Exit code 5 (REMOTE_FAILURE):**
   - MCP timeout on `hive proposal create`
   - DB unreachable on `hive proposal list` (read fallback should try 3 times)

6. **Exit code 12 (MCP_UNREACHABLE):**
   - `hive proposal claim P123` with MCP down (mutation refused)
   - MCP unreachable should NOT fall back to DB for mutations

7. **Idempotency:**
   - `hive proposal claim P123 --idempotency-key <uuid>` returns same lease_id on retry
   - `idempotent_replay: true` flag on second call with same key

8. **Format outputs:**
   - `hive proposal list --format json` returns JSON envelope
   - `hive proposal list --format jsonl` returns JSONL (one per line)
   - `hive proposal list --format yaml` returns YAML
   - `hive scan --format sarif` returns SARIF v2.1.0

---

## 11. Open Questions (Unresolved)

Questions that Round 2 implementers or Platform Architect must resolve:

| Question | Assigned To | Notes |
|----------|-------------|-------|
| Should `hive init` create a `.hive/config.json` file locally, or only register in control plane? | Backend Architect | Current design says control-plane only, but CWD resolution would benefit from local hints. |
| What is the exact format of `idempotency_key` cache storage (DB table, Redis, in-memory)? | Backend Architect / DA | Must persist across CLI invocations. 24-hour TTL required. |
| Should `hive proposal next` be implemented as a separate command, or folded into `hive proposal list --next`? | Software Architect (P455) | AI-first command; if implemented, needs its own schema and gate-readiness scoring logic. |
| For `hive --recipes`, should recipes be static (hardcoded) or dynamic (loaded from control plane)? | Backend Architect | Static = simpler, less network. Dynamic = updatable without CLI release. |
| Should `hive context --format json` output `agency` as a string (identity) or nested object (full record)? | AI Engineer | String is lighter; object is richer. Current design assumes string. |
| For `--include` relations, should expanded nested entities use the same envelope, or a flattened structure? | Backend Architect | Design shows nested object per relation. Flattening would reduce nesting depth. |
| Should `hive doctor --remediate` run auto-fixes (e.g., `hive lease release`), or only suggest them? | DevOps | Current design = suggest only. Auto-fix is risky. |
| Exit code 13 (DB_UNREACHABLE) — should reads retry 3 times with exponential backoff before failing? | Backend Architect | Yes, standard (1s, 2s, 4s). Needs explicit timeout budget (max 10s). |

---

## 12. What This Contract Does NOT Cover

**Out of scope for P455:**

1. **Plugin system** (git-style `hive-myplugin` discovery) — deferred to future proposal.
2. **Config file storage** (~/.hive/config, user preferences) — specified in design docs, not contracted here.
3. **Interactive editor mode** (`hive proposal create` → opens $EDITOR) — framework already supports; implementation detail.
4. **Batch operations** (transactional multi-proposal mutations) — out of scope; single-proposal focus in v1.
5. **Cross-project queries** (`--across-projects` flag) — not in this contract; portfolio views handled by web/TUI.
6. **Custom state machines** (user-defined workflows) — control plane provides workflow_template; CLI reads only.
7. **Streaming events** (WebSocket/SSE output) — MCP handles streaming; CLI surfaces as `--watch` (JSONL output).
8. **AI agent orchestration** (spawning agents, workflow automation) — orchestrator daemon's job, not CLI's.
9. **Local-only mode** (CLI without control-plane connectivity) — CLI assumes control-plane access for mutations.
10. **Export/import commands** (backup/restore entire project state) — not in command tree; handled separately.

---

## 13. Acceptance Criteria

Round 2 implementers validate:

- [ ] All commands listed in command tree (§1) are implemented.
- [ ] All commands support `--format text|json|jsonl|yaml|sarif` (sarif for scan/lint only).
- [ ] Every command emits JSON envelope with `schema_version`, `command`, `context`, `ok`, `data`, `warnings`, `elapsed_ms`.
- [ ] Error responses include error.code (§3), error.message, error.hint, error.detail, error.retriable, error.exit_code.
- [ ] All exit codes (0, 1, 2, ..., 99) documented in error handler.
- [ ] Context resolution follows precedence (§5): flag → env → CWD → control-plane default.
- [ ] Mutations route through MCP (§6); MCP unavailable returns error code 12, not silent fallback.
- [ ] Reads fall back to direct DB if MCP unreachable.
- [ ] All mutating commands accept `--idempotency-key <uuid>` (§7).
- [ ] `hive --schema`, `hive <domain> --schema`, `hive --recipes`, `hive doctor --format json` implemented.
- [ ] Legacy `roadmap` commands forward to `hive` with deprecation warning during grace period (§9).
- [ ] Golden JSON fixtures (§10.1) present in test suite.
- [ ] Negative test suite (§10.3) covers all exit codes and error paths.
- [ ] Documentation includes 10+ operator tasks and copy-paste recipes.
- [ ] All destructive commands require `--yes`; panic operations require `--yes --really-yes`.
- [ ] Audit log written for every write operation (proposal_event, operator_action_log, etc.).

---

## Summary of Key Decisions

**Six decisions that shaped this contract:**

1. **Mutations require MCP; reads fall back to DB (§6).** Preserves audit trail while avoiding cascading failures.

2. **Every JSON response uses universal envelope (§2).** AI agents detect schema drift and degrade gracefully; no silent incompatibilities.

3. **Idempotency keys on all mutations (§7).** Agents can retry safely without duplicate leases or state transitions.

4. **Context resolution walks up CWD + checks control plane (§5).** No hardcoded paths; works in any git worktree.

5. **All state names loaded from control plane at startup (§1, §3 resolution).** Single source of truth (P453); no hardcoding risk.

6. **Destructive commands require `--yes` (§5 confirmation pattern).** Safety is non-negotiable; no accidental stops or deletes in scripts.

---

**Next Steps for Round 2:**

1. **Senior Dev:** Implement domain modules in `src/apps/hive-cli/domains/`. Use command signatures from §1.
2. **Backend Architect:** Design idempotency cache (§7), refine MCP/DB routing (§6), populate control-plane schema (§5 CWD resolution).
3. **MCP Builder:** Expose schema version in responses; implement error.code catalog (§4); add `--idempotency-key` handling.
4. **Code Reviewer:** Write negative test suite (§10.3); validate all exit codes; check golden fixtures.
5. **API Tester:** Test context resolution (§5) across worktrees, projects, and env vars; validate envelope structure (§2).
6. **SRE / DevOps:** Test operator commands (`hive stop`, `hive doctor`, `hive service`); validate audit logging.

---

**References:**

- P453: Control-plane state names
- P455: `hive` CLI redesign (this proposal)
- P448: getProjectRoot() runtime paths
- P446: Doctor readiness checks
- P441–P442: Service ops, dispatch lifecycle
- P434: Provider/route/budget governance
- CONVENTIONS.md: Workflow, MCP, Git governance
