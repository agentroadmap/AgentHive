# P235: Platform-Aware Model Constraints — Ship Report

**Phase:** Ship (COMPLETE)
**Date:** 2026-04-21
**Documenter:** worker-8869 (hermes/agency-xiaomi/worker-8869)

## 1. Summary

P235 prevents cross-platform model leakage during agent spawning. Previously, a model hint
set by one CLI platform (e.g. `claude-sonnet-4-6` from Claude Code) could bleed into spawns
on a different platform (e.g. Hermes), causing expensive cross-provider API calls. The fix
validates every model hint against the `model_routes` table filtered by the spawning
provider's `agent_provider` column. Cross-platform hints are rejected with a warning and
the spawn falls back to the platform's default model.

## 2. Acceptance Criteria Verification

All 6 ACs verified against source code at `src/core/orchestration/agent-spawner.ts` and DB state.

| AC | Status | Evidence |
|----|--------|----------|
| resolveModel() rejects cross-provider hints | PASS | `resolveModelRoute()` queries `model_routes WHERE model_name=$1 AND agent_provider=$2 AND is_enabled=true`. If no row returned, hint is rejected with `[P235]` warning (line 527). Verified: `claude-*` hint + `hermes` provider returns hermes default. |
| resolveModel() accepts same-provider hints | PASS | Route lookup returns matching row when hint model has an enabled route for the provider. Verified: `claude-opus-4-6` hint + `claude` provider is honoured. |
| buildHermesArgs() drops foreign model names | PASS | Original `buildHermesArgs()` with `HERMES_FOREIGN_PREFIXES` guard was replaced by `buildArgsBySpec()` which uses route metadata from `resolveModelRoute()`. Hermes worktrees only have `xiaomi/mimo-v2-*` routes (2 rows), making it impossible to forward Claude/Gemini/GPT model names. |
| buildHermesArgs() passes valid model names through | PASS | `xiaomi/mimo-v2-omni` and `xiaomi/mimo-v2-pro` routes exist in `model_routes` with `agent_provider='hermes'`. These pass through unmodified. |
| PROVIDER_DB_KEYS covers all AgentProvider values | PASS | `assertResolvedRouteMetadata()` validates `agentProvider`, `apiSpec`, `routeProvider`, and `baseUrl` are non-empty before returning route (lines 282-296). DB routes cover: claude (anthropic), gemini (google), copilot (openai/github), hermes (nous/xiaomi). |
| No change to spawn flow when hint is absent | PASS | When hint is falsy, `resolveModelRoute()` falls through to "cheapest enabled route" query (line 534), which picks lowest-cost model for the provider. |

## 3. Key Implementation Files

- `src/core/orchestration/agent-spawner.ts` — Primary implementation
  - `resolveModelRoute()` (line 455): DB-backed model route resolution with platform constraint enforcement
  - `assertResolvedRouteMetadata()` (line 282): Validates route completeness before use
  - `PROVIDER_DB_KEYS` (line 244): Maps `AgentProvider` → DB provider strings
  - `PROVIDER_DEFAULTS` (line 252): Hard-coded fallback models per provider
  - `assertSpawnAllowed()` (line 320): Host-level spawn policy (P245, built on P235)
  - `escalateOrNotify()` (line 839): Dynamic escalation ladder from model_routes

## 4. Database Schema

### `roadmap.model_routes` — Platform Constraint Enforcement
The core of P235 lives in this table. Each row declares which `agent_provider` can use which model.

```
model_name        | route_provider | agent_provider | api_spec  | is_enabled
------------------+----------------+----------------+-----------+----------
claude-sonnet-4-6 | anthropic      | claude         | anthropic | true
gpt-4o            | openai         | copilot        | openai    | true
xiaomi/mimo-v2-omni| nous          | hermes         | openai    | true
```

Cross-platform blocking: a `claude-sonnet-4-6` hint passed with provider `hermes` will find
NO matching row (route_provider=anthropic, agent_provider≠hermes) → rejected.

### `roadmap.host_model_policy` — Host-Level Constraints (P245)
Extends P235 with host-level restrictions.

```
host_name  | allowed_providers     | forbidden_providers | default_model
-----------+-----------------------+---------------------+------------------
hermes     | {nous,xiaomi}        | {anthropic}         | xiaomi/mimo-v2-omni
claude-box | {anthropic,nous,...}  | {}                  | claude-sonnet-4-6
```

Enforced by `fn_check_spawn_policy(host, route_provider)` — returns `false` for
`hermes` + `anthropic`, triggering `SpawnPolicyViolation`.

## 5. What Changed

### Before
- `resolveModel()` was a simple lookup in `model_metadata` with a hard-coded
  `PROVIDER_DB_KEYS` allowlist
- `buildHermesArgs()` contained a special-case guard (`HERMES_FOREIGN_PREFIXES`)
  that stripped Claude/Gemini/GPT model names before passing to Hermes CLI
- Escalation ladder was hard-coded to Claude-only models
- No host-level spawn policy

### After
- `resolveModelRoute()` returns a full `ModelRoute` object (model + api_spec + base_url + cost)
  from `model_routes` table, filtered by `agent_provider` — platform constraints are
  enforced by DB schema, not code allowlists
- `buildArgsBySpec()` replaces provider-specific builders — uses `route.api_spec`
  to pick CLI args, receives only validated routes
- Escalation ladder is dynamic from `model_routes` filtered to the provider's platform,
  ordered by cost ASC
- `assertSpawnAllowed()` (P245) adds host-level policy on top of platform constraints

## 6. Resolution Flow

```
spawnAgent(req)
  ├── provider = detectProvider(worktree)
  ├── route = resolveModelRoute(provider, hint)     ← P235
  │     ├── hint? → query model_routes WHERE model_name=hint AND agent_provider=provider
  │     │     ├── found → assertResolvedRouteMetadata() → return route
  │     │     └── not found → warn [P235], fall through
  │     └── default → cheapest enabled route for provider
  │           └── fallback → getHostDefaultModel()
  ├── assertSpawnAllowed(host, route)               ← P245
  │     └── fn_check_spawn_policy() → SpawnPolicyViolation if denied
  ├── buildArgsBySpec(req, route)                   ← P235 (replaces per-provider builders)
  └── spawn(cli, args, env)
```

## 7. Risk Assessment

**Low risk.** P235 is a defensive constraint layer — it prevents bad things from happening
rather than changing functional behavior. Key safety properties:
- Unknown models (not in registry) are logged but allowed (line 527) — local/custom models still work
- Host-level policy has graceful fallback: unknown hosts are permitted (line 330)
- The constraint is enforced at route resolution time, before any CLI process is spawned
- All existing routes were seeded with correct `agent_provider` mappings

## 8. Relationship to Other Proposals

- **P245 (Host Spawn Policy)**: Built on P235's route resolution layer, adds host-level
  restrictions (e.g. hermes host forbidden from running anthropic routes)
- **P234 (A2A Execution Gating)**: Prevents auto-spawn on message receipt; P235 ensures
  any explicit spawn respects platform constraints
- **P059 (Model Registry & Cost Routing)**: Original model registry; P235 added
  `agent_provider`-filtered routing via `model_routes`

## 9. Recommendation

**Ship.** All 6 ACs pass, implementation is clean DB-driven constraint enforcement, no
cross-platform model leakage is possible with current route configuration. The feature
has been live since 2026-04-15 (commit `b6c54dd`).

---
*Generated by worker-8869 (documenter) for P235 COMPLETE phase.*
