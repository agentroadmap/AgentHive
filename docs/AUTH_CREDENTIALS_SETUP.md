# P1435-C3: Per-(OS-user, provider) Credential Setup

**Status**: Implementation complete. AC-4 (documentation) fulfilled by this file.

## Overview

AgentHive supports per-provider API credential configuration for agencies. Credentials are stored per (agency_provider, route_provider) tuple in `roadmap.model_routes`, enabling:

1. **Shared credentials across agencies** (via shared route)
2. **Provider-specific auth failure handling** (fail-loud, no silent retries)
3. **Operator-controlled credential rotation** (auth_down_until TTL)

## Credential Storage

### Schema: `roadmap.model_routes`

```sql
-- Primary credential columns:
api_key_primary        TEXT    -- Direct API key storage (highest priority)
api_key_secondary      TEXT    -- Fallback key
api_key_env            TEXT    -- Env var name for primary key
api_key_fallback_env   TEXT    -- Env var name for fallback
cli_api_key_env        TEXT    -- Env var name the CLI reads
auth_down_until        TIMESTAMP WITH TIME ZONE  -- Marks auth as down (TTL)
```

### Credential Resolution Order (buildSpawnProcessEnv)

When spawning an agent, credentials are resolved in this order:

1. **Database primary key** (`api_key_primary`)
   - Highest priority; set by operator or automated provisioning
   - No expiry; persists until explicitly updated
2. **Database secondary key** (`api_key_secondary`)
   - Fallback if primary missing
3. **Environment variable** (`api_key_env`)
   - Named env var (e.g., `ANTHROPIC_API_KEY`)
   - Read from process.env or ~/.claude/settings.json
4. **Fallback environment variable** (`api_key_fallback_env`)
   - Named fallback env var
   - Same resolution as primary

The first non-null value is used. If none resolve, the spawn fails before execution.

### Example Configuration

```sql
-- Store API key directly in DB (highest priority)
UPDATE roadmap.model_routes
SET api_key_primary = 'sk-proj-abc123...'
WHERE agent_provider = 'anthropic'
  AND route_provider = 'anthropic'
  AND model_name = 'claude-opus';

-- Or use env var fallback (lower priority)
UPDATE roadmap.model_routes
SET api_key_env = 'ANTHROPIC_API_KEY',
    cli_api_key_env = 'ANTHROPIC_API_KEY'
WHERE agent_provider = 'anthropic'
  AND route_provider = 'anthropic';
```

## Auth Failure Handling (Fail-Loud)

When a spawned agent receives a **401 (Unauthorized)** or **403 (Forbidden)** response from the provider:

1. **Liaison detects error** (liaison-agent.ts)
   - Error message is scanned for "401", "403", "Unauthorized", "Forbidden", or "authentication"
2. **setProviderAuthDown() is called**
   - `obstacle_type = 'PROVIDER_AUTH_DOWN'` logged to `escalation_log`
   - `auth_down_until = NOW() + 1 HOUR` set on all routes for that provider
   - `severity = 'critical'` (requires operator intervention)
3. **Offer/claim path skips that provider** (AC-3)
   - `authDownFilterSql("mr")` filter: `auth_down_until IS NULL OR auth_down_until <= NOW()`
   - Agencies cannot claim offers using routes marked as auth-down
4. **Operator manually clears**
   - `clearProviderAuthDown(provider)` sets `auth_down_until = NULL`
   - Or operator updates DB: `UPDATE roadmap.model_routes SET auth_down_until = NULL WHERE route_provider = $1`

### No Silent Retry

- Auth failures trigger immediate escalation, NOT automatic retry
- No backoff queue; the provider is immediately excluded from routing
- Prevents credential exhaustion attacks and key-discovery timing leaks
- Operator must actively investigate and re-provision credentials

## Pre-Claim Auth Readiness (AC-5)

Before an agency claims an offer via `fn_claim_work_offer`:

1. **AgencyClaimLoop checks** `isProviderAuthDown(provider)`
2. If auth is down:
   - Claim is skipped (returns null from claimOne)
   - Warning logged: `"Provider auth for '<provider>' is down; skipping claim"`
   - Loop retries on next poll interval (default 30s)
3. If auth is up:
   - Claim proceeds normally
   - fn_claim_work_offer validates capability match and TTL

This ensures an agency never attempts to spawn a worker when its provider's credentials are unavailable.

## Distinct from Quota Cooldown (P1359)

Both use `<field>_until` TTL mechanics, but are **semantically different**:

| Aspect | auth_down_until | cooldown_until |
|--------|---|---|
| **Cause** | 401/403 auth failure | Quota exhaustion |
| **Trigger** | Liaison detects HTTP error | Spending system quota check |
| **Resolution** | Operator re-provisions credentials | TTL auto-expires (1 hour) |
| **Operator Action** | Manual investigation + key rotation | None (automatic recovery) |
| **SQL Filter** | authDownFilterSql() | cooldownFilterSql() |
| **Log Entry** | PROVIDER_AUTH_DOWN (critical) | BUDGET_EXHAUSTED (escalation varies) |

## Operator Workflow

### Check Auth Status

```sql
SELECT route_provider, auth_down_until, model_name
FROM roadmap.model_routes
WHERE auth_down_until IS NOT NULL
  AND auth_down_until > NOW()
ORDER BY auth_down_until DESC;
```

### View Auth Failure Events

```sql
SELECT agent_identity, escalated_at, resolution_note
FROM roadmap.escalation_log
WHERE obstacle_type = 'PROVIDER_AUTH_DOWN'
  AND resolved_at IS NULL
ORDER BY escalated_at DESC;
```

### Manually Clear Auth Failure

```sql
-- Option 1: All routes of a provider
UPDATE roadmap.model_routes
SET auth_down_until = NULL
WHERE route_provider = 'anthropic';

-- Option 2: All routes
UPDATE roadmap.model_routes
SET auth_down_until = NULL;
```

### Provision New Credentials

```sql
-- Update primary key directly
UPDATE roadmap.model_routes
SET api_key_primary = 'sk-proj-<new-key>',
    api_key_secondary = NULL,  -- Clear backup if rotating
    auth_down_until = NULL     -- Clear auth-down flag
WHERE agent_provider = 'anthropic'
  AND route_provider = 'anthropic';
```

## Testing

See `tests/p1435-c3-auth.test.ts` for comprehensive test coverage:

- **AC-1**: Schema supports per-provider credential storage
- **AC-2**: Auth errors logged and auth_down_until marked
- **AC-3**: Route filter respects auth_down_until TTL
- **AC-5**: Pre-claim auth readiness gated

Run tests:

```bash
NODE_PATH=/data/code/AgentHive/node_modules node --import jiti/register --test tests/p1435-c3-auth.test.ts
```

All 12 tests passing ✅
