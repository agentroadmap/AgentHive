# LLM Rate-Limit Throttling (P1365)

## Overview

**Pre-emptive LLM throttle** automatically reduces spawn frequency when API rate-limits approach exhaustion. The system:

1. Parses rate-limit response headers from LLM APIs
2. Tracks remaining capacity (requests + tokens) per provider/model/agency
3. Applies a graduated throttle curve to skip launches probabilistically
4. Emits audit logs for throttle decisions to `message_ledger`

This prevents cascading failures when an agency approaches its quota, by gracefully degrading rather than hitting hard 429 errors.

## Architecture

### Signal Sources

| Provider | Headers Present | Status |
| --- | --- | --- |
| **Anthropic** | Yes (anthropic-ratelimit-*) | Live |
| **OpenAI** | Yes (x-ratelimit-*) | Live |
| **Google / Gemini** | No (quota in error body) | Phase 2 |
| **GitHub / Copilot** | Non-standard | Phase 2 |

Today, headers are parsed from response metadata passed to the orchestrator. The **Claude Code SDK** does not yet expose headers natively; this is a Phase 2 enhancement. CLI-based agents (codex, hermes) do not have direct header access.

### Components

1. **rate-limit-parser.ts** (`parseRateLimitHeaders`)
   - Extracts capacity signals from HTTP response headers
   - Provider-specific extractors for Anthropic, OpenAI
   - Case-insensitive header lookup, safe timestamp parsing
   - Returns `null` if no signals present

2. **capacity-tracker.ts** (`CapacityTracker`)
   - Maintains in-memory EWMA burn-rate estimates
   - Detects reset events (remaining jumped up)
   - Computes throttle decision per throttle curve
   - Flushes samples to `roadmap_workforce.agency_capacity` table

3. **agency_capacity table** (migration 139)
   - Stores latest signal per `(provider, model, agency_id)`
   - Includes burn_rate_per_sec (EWMA), throttle_action, reset_at
   - Indexed on throttle_action for discovery of soft/hard entries

4. **agency-resolver.ts** (integrate into ranking)
   - JOINs `agency_capacity` when ranking candidate agencies
   - Hard-throttled rows excluded entirely
   - Soft-throttled rows score multiplied by `(1 - p_skip)`
   - Logs throttle decision to `message_ledger` per spawn

5. **agent-spawner.ts** (signal recording)
   - After spawn completes, extract headers if available
   - Call `parseRateLimitHeaders()` and pass signal to in-memory tracker
   - Tracker batches samples; flushed periodically to DB

6. **MCP observability** (`capacity_snapshot`, `capacity_clear`)
   - Query current capacity state across all agencies
   - Manual reset for testing or operator intervention

## Throttle Curve

Headroom = `min(requests_remaining / requests_limit, tokens_remaining / tokens_limit)` as percentage.

| Headroom % | Action | Skip Probability |
| --- | --- | --- |
| >= 50 | `none` | 0.00 |
| 25–50 | `soft` | Linear 0–0.25 |
| 10–25 | `soft` | Linear 0.25–0.70 |
| < 10 | `hard` | 1.00 |

**Soft throttle**: agencies are still ranked and can be selected, but skipped stochastically.  
**Hard throttle**: agencies are excluded from candidacy entirely.

## Testing & Verification

### Manual Test (Local)

```bash
# Record a capacity signal (simulated)
node -e "
const { CapacityTracker } = require('./src/infra/llm/capacity-tracker.ts');
const tracker = new CapacityTracker();
tracker.recordSignal({
  provider: 'anthropic',
  model: 'claude-opus-4',
  requests_remaining: 20,
  requests_limit: 100,
  tokens_remaining: 200000,
  tokens_limit: 1000000,
  reset_at: new Date(Date.now() + 3600000),
  sampled_at: new Date(),
}, 'agency-test');
const throttle = tracker.computeThrottle('anthropic', 'claude-opus-4', 'agency-test');
console.log(throttle);
// Expected: { action: 'soft', p_skip: 0.425, headroom_pct: 20, ... }
"
```

### Database Check

```sql
-- Query current capacity state
SELECT provider, model, agency_id, headroom_pct, throttle_action, reset_at
FROM roadmap_workforce.agency_capacity
WHERE throttle_action != 'none'
ORDER BY provider, throttle_action DESC;

-- Check recent throttle decisions
SELECT message_type, metadata, created_at
FROM roadmap.message_ledger
WHERE message_type = 'throttle_decision'
ORDER BY created_at DESC
LIMIT 10;
```

### Operator Commands

```bash
# View capacity snapshot (MCP)
agenthive mcp_ops capacity_snapshot {}

# Filter by provider
agenthive mcp_ops capacity_snapshot { provider: 'anthropic' }

# Clear a throttled agency (manual reset)
agenthive mcp_ops capacity_clear { 
  agency_id: 'agency-alpha',
  provider: 'anthropic',
  model: 'claude-opus-4'
}
```

## Phase 2 Enhancements

1. **HTTP proxy / sidecar**: Intercept all LLM API calls to extract headers natively
   - Eliminates dependency on SDK header exposure
   - Works for all tools (CLI, scripts, Python, etc.)

2. **Google / Gemini quota error parsing**: Extract quota exhaustion from 429 error bodies
   - Requires structured error parsing
   - Affects only soft throttle (hard throttle inferred from successful resets)

3. **GitHub / Copilot standardization**: Agree on header format with GitHub
   - Currently non-standard; defer to Phase 2

4. **Burn-rate projections**: Predict when reset window will open
   - `projected_exhaustion_secs` in capacity snapshot
   - Inform spawn delay decisions

## Known Gaps

### Header Exposure

- **claudecodE SDK**: Does not expose response headers to caller today
- **Codex CLI**: Request/response headers not captured
- **Hermes**: Request/response headers not captured

**Workaround**: HTTP proxy (`src/infra/http-proxy/`) or sidecar planned for Phase 2.

### Fallback Behavior

When no signals are recorded for an agency:
- Throttle action defaults to `none` (full dispatch)
- No headroom data → assume healthy
- Safe but conservative (misses approaching exhaustion until first 429)

### Reset Detection

Reset is detected when `tokens_remaining` increases between samples. This works for:
- Standard 24-hour windows (Anthropic, OpenAI)
- Per-minute windows

But may mis-classify rapid request bursts as resets. Mitigated by:
- Keeping 10 samples in-memory for history
- EWMA smoothing over 5+ observations
- Operator can manually reset via `capacity_clear` MCP action

## Operational Runbook

### Scenario: High Soft-Throttle Rate

**Symptom**: Spawn logs show high `p_skip` (0.5+), agency repeatedly skipped.

**Investigation**:
```sql
SELECT * FROM roadmap_workforce.agency_capacity
WHERE throttle_action = 'soft' AND provider = 'anthropic';
```

**Resolution**:
1. If reset_at is in the past, the agency may have already reset. Clear stale data:
   ```bash
   agenthive mcp_ops capacity_clear {
     agency_id: 'agency-alpha',
     provider: 'anthropic',
     model: 'claude-opus-4'
   }
   ```
2. Check provider-level cooldown (separate P1359 concern):
   ```bash
   agenthive mcp_ops cooldown_status { provider: 'anthropic' }
   ```

### Scenario: Hard Throttle Blocking All Spawns

**Symptom**: No agencies selectable; resolver excludes all candidates.

**Investigation**:
```sql
SELECT agency_id, throttle_action, headroom_pct, reset_at
FROM roadmap_workforce.agency_capacity
WHERE throttle_action = 'hard';
```

**Resolution**:
- If reset_at has passed, clear the entry:
  ```bash
  agenthive mcp_ops capacity_clear { ... }
  ```
- If reset_at is in future, either:
  - Wait for window to reset (preferred)
  - Escalate to provider support if reset time has drifted
  - Manually clear if confident the estimate is stale (risky)

## References

- Migration 139: `database/migrations/139-p1365-agency-capacity-tracking.sql`
- Parser: `src/infra/llm/rate-limit-parser.ts`
- Tracker: `src/infra/llm/capacity-tracker.ts`
- MCP Tools: `src/apps/mcp-server/tools/ops/capacity-ops.ts`
- Resolver integration: `src/core/orchestration/resolvers/agency-resolver.ts` (TODO: implement in AC-4)
