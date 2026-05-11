# P228 — Cubic Runtime Abstraction

> **Status:** COMPLETE  
> **Type:** component  
> **Source-of-truth:** Postgres `roadmap_proposal.proposal` row P228  
> This file is a synced projection of the design. The Postgres record is canonical per CONVENTIONS.md §0.

## Problem

The cubic was a metadata-only container with no execution semantics. Spawning an agent required inline, per-CLI logic scattered through `agent-spawner.ts` with no abstraction for auth, model selection, or inter-agent messaging. Extending the platform to a second CLI (Codex, Hermes) meant duplicating that logic.

## Solution

Five modules under `src/core/runtime/` provide:

| Module | Responsibility |
|--------|---------------|
| `cli-builders.ts` | Per-CLI argv and env construction |
| `provider.ts` | `RuntimeProvider` interface + `SubprocessProvider` |
| `auth-modes.ts` | `host_inherit` / `key_inject` env resolution |
| `model-routing.ts` | Phase-to-model table and cost-optimised picker |
| `a2a-messenger.ts` | Same-host agent-to-agent messaging via `message_ledger` |

A sixth module, `cli-builder-route-resolver.ts`, was added by P450 to layer DB-driven route resolution on top of each builder's hardcoded defaults.

---

## 1. CliBuilder Interface

`src/core/runtime/cli-builders.ts`

```typescript
interface CliBuilder {
  readonly name: CliName;           // 'claude' | 'codex' | 'hermes' | 'gemini' | 'copilot'
  buildArgv(options: BuildArgvOptions): string[];
  buildEnv(options: BuildEnvOptions): Record<string, string>;
  executableName(): string;
  defaultModel(): string;
  buildCommandSpec(task, route): CommandSpec; // primary entry point for spawner
}
```

`buildCommandSpec()` is the preferred call path. It accepts a `route` object (from `cli-builder-route-resolver`) and returns a `CommandSpec` with `argv`, `env`, and optional `stdin`.

### CLI implementations

| Builder | Executable | Task flag | Model flag | Default model |
|---------|-----------|-----------|-----------|---------------|
| `ClaudeCliBuilder` | `claude` | `--print` | `--model` | `claude-sonnet-4-6` |
| `CodexCliBuilder` | `codex` | `exec --dangerously-bypass-approvals-and-sandbox` | `--model` | `gpt-4-turbo` |
| `HermesCliBuilder` | `hermes` | `chat -q … --yolo -Q` | `-m` | `xiaomi/mimo-v2-omni` |
| `GeminiCliBuilder` | `gemini` | `--prompt` | `--model` | `gemini-pro` |
| `CopilotCliBuilder` | `gh` | `copilot suggest` | `--model` | `gpt-4` |

### Registry helpers

```typescript
getCliBuilder(cliName: string): CliBuilder   // falls back to hermes for unknown names
isKnownCli(cliName: string): boolean
listCliNames(): CliName[]
resolveBuilderModel(cliName: string): Promise<string>  // route-first, then default
```

`resolveBuilderModel` is the async model resolver added by P450. It queries `roadmap.model_routes` for an active route matching `agent_cli = cliName`. On miss it logs a row to `roadmap.cli_builder_fallback_audit` and returns the builder's hardcoded default.

---

## 2. RuntimeProvider Interface

`src/core/runtime/provider.ts`

```typescript
interface RuntimeProvider {
  spawn(task, options: SpawnOptions): Promise<SpawnedAgent>;
  send(agentId, message): Promise<void>;         // delegates to A2AMessenger
  recv(agentId, timeoutMs?): Promise<AgentMessage | null>;
  health(processId): Promise<HealthStatus>;
  shutdown(processId, timeoutMs?): Promise<ShutdownResult>;
  cleanup(): Promise<void>;
}
```

### SubprocessProvider

`SubprocessProvider` is the production implementation. It:

1. **spawn** — forks a `claude --print [--model …] <task>` child via `node:child_process.spawn`. Captures stdout/stderr into an in-memory `ProcessEntry`. Enforces `timeoutMs` with SIGTERM → SIGKILL escalation.
2. **health** — polls OS process table via `process.kill(pid, 0)` (signal-0 liveness check). Returns `running | idle | error` plus optional `uptime_ms` and `memory_mb`.
3. **shutdown** — sends SIGTERM, polls for up to `timeoutMs` (default 8 s), then escalates to SIGKILL.
4. **cleanup** — reaps done or stale (> 10 min) entries from the in-process map.
5. **send / recv** — intentional no-ops; callers must use `A2AMessenger` directly.

> The `SubprocessProvider.spawn()` defaults to `claude --print` and ignores `CliBuilder`. For spawns that need multi-CLI dispatch, use `agent-spawner.ts` which drives `CliBuilder` and `resolveAuthEnv` together.

---

## 3. Auth Modes

`src/core/runtime/auth-modes.ts`

The cubic does **not** create or store credentials. Auth responsibility stays on the host.

### `host_inherit` (default)

```typescript
buildHostInheritEnv({ homeDir, extraPathDirs? }): Record<string, string>
```

Sets `HOME` to the authenticated user's directory (e.g. `/home/andy`). The CLI finds its auth files automatically (`~/.claude/auth`, `~/.codex/config.json`, etc.). Optionally prepends `extraPathDirs` to `PATH`.

**Use case:** local development, single-host orchestration where the CLI is already installed and authenticated.

### `key_inject`

```typescript
buildKeyInjectEnv({ homeDir, apiKeyVault }): Record<string, string>
```

Spreads `apiKeyVault` (e.g. `{ ANTHROPIC_API_KEY: "sk-…" }`) directly into the subprocess env. The CLI uses injected credentials; no local auth files are required.

**Use case:** ephemeral containers, remote hosts, CI/CD pipelines.

### `resolveAuthEnv(opts: AuthModeOptions)`

Dispatcher that returns the correct env map given `mode`, `hostInherit`, and `keyInject` options. Falls back to `{ HOME: process.env.HOME ?? "/var/lib/agenthive" }` if neither option set is populated.

### `CubicRuntimeMetadata`

Cubic `metadata` JSON is typed as:

```typescript
interface CubicRuntimeMetadata {
  agent_cli: string;        // 'claude' | 'codex' | 'hermes' | 'gemini' | 'copilot'
  host: string;             // 'localhost' | '<remote-host>'
  auth_mode: AuthMode;      // 'host_inherit' | 'key_inject'
  home_dir?: string;        // resolved home directory for the auth user
  model_override?: string;  // optional CLI model flag value
}
```

`resolveCubicRuntimeMetadata(partial)` merges with defaults: `agent_cli=claude`, `host=localhost`, `auth_mode=host_inherit`.

---

## 4. Model Routing

`src/core/runtime/model-routing.ts`

### Phase-to-model table

The orchestrator (not individual agents) decides model selection. The default table:

| Phase | Model | Rationale |
|-------|-------|-----------|
| `DRAFT` | `claude-opus-4-7` | Architecture work needs maximum reasoning depth |
| `REVIEW` | `claude-sonnet-4-6` | Gate review is cost-sensitive |
| `DEVELOP` | `claude-sonnet-4-6` | Coding tasks: cost vs. capability balance |
| `MERGE` | `claude-haiku-4-5` | Integration validation: simple checks, lowest cost |
| `COMPLETE` | `claude-haiku-4-5` | Terminal state: minimal work |
| `TRIAGE` | `claude-sonnet-4-6` | Hotfix triage: reliable + fast |
| `FIX` | `claude-sonnet-4-6` | Hotfix coding |
| `DEPLOYED` | `claude-haiku-4-5` | Post-deploy lightweight verification |

### Resolution order

```
model_override (cubic metadata) → PHASE_MODEL_TABLE[phase] → claude-sonnet-4-6
```

`resolvePhaseModel(phase, modelOverride?)` implements this precedence.

### Cost-optimised picker

`selectCostOptimizedModel({ phase, acCount, modelOverride? })` applies a heuristic: proposals with ≥ 20 acceptance criteria use `claude-opus-4-7`; smaller proposals use the phase default. This is in addition to any explicit `model_override`.

### CLI model flag

`buildModelFlag(agentCli, modelOverride?)` returns the correct argv fragment for each CLI:

- `claude` / `codex` / `gemini` / `copilot` → `["--model", modelOverride]`
- `hermes` → `["-m", modelOverride]`

---

## 5. A2A Messaging

`src/core/runtime/a2a-messenger.ts`

> **Note:** `A2AMessenger` predates the P833 unified message envelope. For new callers, prefer the MCP `mcp_message` tool surface (`msg_send` / `msg_read` / `msg_ack`). `A2AMessenger` is kept for `RuntimeProvider` compatibility and will be folded into the MCP path in a follow-up to P837.

### Architecture

Same-host messaging uses the `roadmap.message_ledger` table with `pg_notify` for real-time delivery:

```
Agent A                 Postgres                  Agent B
  │── INSERT message_ledger ──────────────────────▶│
  │── pg_notify('a2a_messages', {to, from, id}) ──▶│
                                                    │
                                                    │── pollOne() → UPDATE read_at
                                                    │── return A2AMessage
```

`recv()` uses `UPDATE … SET read_at = now() WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)` — the row survives for ACK tracking (P833 semantics); earlier `DELETE`-on-read was a bug that destroyed ACK provenance.

### API

```typescript
const messenger = createA2AMessenger('orchestrator');

// Point-to-point
const id = await messenger.send('claude-one', { type: 'task_assigned', content: { ... } });

// Broadcast to a named channel
await messenger.broadcast('proposal_updates', { type: 'status_changed', content: { ... } });

// Receive with timeout
const msg = await messenger.recv({ timeoutMs: 5000, messageType: 'task_assigned' });
```

---

## 6. Route Resolver (P450 extension)

`src/core/runtime/cli-builder-route-resolver.ts`

Queries `roadmap.model_routes` for a live route before falling back to the builder's hardcoded `defaultModel()`:

```typescript
const route = await getRouteForBuilder('claude');
if (route.found) {
  // use route.modelName, route.baseUrl, route.routeProvider
} else {
  // fallback: emits row to roadmap.cli_builder_fallback_audit
}
```

V1 keeps `defaultModel()` intact. V2 removal is gated on 24 h with zero fallback count in `cli_builder_fallback_audit`.

---

## 7. Multi-Host Federation Sketch

Current deployment is single-host (`host=localhost`). Cross-host dispatch is future scope (P229+).

### Planned architecture

```
Host A (claude)              Host B (gemini)
  Orchestrator
      │
      ├── LocalMessenger (pg_notify) ──▶ claude-one
      │
      └── FederatedMessenger (WebSocket / HTTP webhook)
                │
                └──────────────────────────────▶ gemini-one (Host B)
```

`A2AMessenger` will gain a `FederatedMessenger` implementation that bridges via WebSocket RPC. The cubic `host` field drives the routing decision: `localhost` → `LocalMessenger`; anything else → `FederatedMessenger`.

Cubic metadata for a remote agent would look like:

```json
{
  "agent_cli": "gemini",
  "host": "gemini-host.internal",
  "auth_mode": "key_inject",
  "model_override": "gemini-1.5-pro",
  "messaging": { "channel": "proposal_updates", "a2a_enabled": true }
}
```

---

## 8. Deployment & Operations

### Restarting after code changes

Code changes must be merged to `main` before services see them (CLAUDE.md). Restart the orchestrator with `sudo systemctl restart agenthive-orchestrator`.

### Checking model fallbacks

```sql
SELECT builder, fallback_model, called_at
FROM roadmap.cli_builder_fallback_audit
ORDER BY called_at DESC
LIMIT 20;
```

### Adding a model route

```sql
INSERT INTO roadmap.model_routes (agent_cli, model_name, route_provider, base_url, is_enabled, priority)
VALUES ('claude', 'claude-opus-4-7', 'anthropic', 'https://api.anthropic.com', true, 10);
```

### A2A message backlog

```sql
SELECT id, from_agent, to_agent, message_type, created_at, read_at
FROM roadmap.message_ledger
WHERE read_at IS NULL
ORDER BY created_at ASC
LIMIT 50;
```

---

## 9. Acceptance Criteria Coverage

| AC | Status | Evidence |
|----|--------|---------|
| CliBuilder unit tests — full coverage | Delivered | `tests/core/runtime/cli-builders.test.ts` |
| RuntimeProvider unit tests | Delivered | `tests/core/runtime/provider.test.ts` |
| Auth mode unit tests | Delivered | `tests/core/runtime/auth-modes.test.ts` |
| Model routing unit tests | Delivered | `tests/core/runtime/model-routing.test.ts` |
| agent-spawner integration via CliBuilder + auth | Delivered | `src/core/orchestration/agent-spawner.ts` — uses `buildCommandSpec` + `resolveAuthEnv` |
| Cubic metadata schema extensions | Delivered | `CubicRuntimeMetadata` in `auth-modes.ts`; DB columns via migration |
| A2A same-host messaging | Delivered | `A2AMessenger` + `message_ledger` (P833 envelope) |
| Cross-host federation sketch | Delivered | §7 above — implementation deferred to P229 |
| Documentation | This file |
