# P1859 AC-5 Research: Anthropic OAuth Usage Endpoint

## Investigation Summary

### Research Objective
Verify whether https://api.anthropic.com/api/oauth/usage exists and is stable; document response schema.

### Findings

**Status: Endpoint EXISTS and returns HTTP 200**

The Anthropic OAuth usage endpoint is available at:
- `https://api.anthropic.com/api/oauth/usage` — **HTTP 200 (VERIFIED)**

**Other OAuth endpoints (for reference):**
- `https://api.anthropic.com/api/oauth/authorize` — OAuth authorization flow
- `https://api.anthropic.com/api/oauth/token` — Token exchange
- `https://api.anthropic.com/api/oauth/revoke` — Token revocation

### Response Schema

The `/usage` endpoint returns a JSON object with utilization percentages (0-100) per time window:

```json
{
  "five_hour": {
    "utilization": 4.0,
    "resets_at": "2026-06-12T07:39:59.655277+00:00"
  },
  "seven_day": {
    "utilization": 64.0,
    "resets_at": "2026-06-17T02:59:59.655328+00:00"
  },
  "seven_day_oauth_apps": null,
  "seven_day_opus": null,
  "seven_day_sonnet": {
    "utilization": 22.0,
    "resets_at": "2026-06-17T02:59:59.655341+00:00"
  },
  "seven_day_cowork": null,
  "seven_day_omelette": null,
  "tangelo": null,
  "iguana_necktie": null,
  "omelette_promotional": null,
  "cinder_cove": null,
  "extra_usage": {
    "is_enabled": false,
    "monthly_limit": null,
    "used_credits": null,
    "utilization": null,
    "currency": null,
    "disabled_reason": null
  }
}
```

### Request Headers (Required)

```
Authorization: Bearer <oauth_access_token>
anthropic-beta: oauth-2025-04-20
```

The OAuth access token is stored in `~/.claude/.credentials.json` under `.claudeAiOauth.accessToken`.

### Implementation: Quota Snapshot Mapping

**Binding constraint**: The _maximum_ utilization across windows determines capacity.

Example from sample response:
- five_hour.utilization = 4%
- seven_day.utilization = 64% ← **BINDING (highest)**
- seven_day_sonnet.utilization = 22%

**Quota snapshot**:
- `quota_limit = 100` (percentage scale)
- `quota_remaining = 100 - 64 = 36` (36% of quota still available)
- `quota_reset_at = "2026-06-17T02:59:59.655328+00:00"` (resets_at of binding window)
- `raw_headers` = full JSON response (for audit/debug)

This is a **percentage-based** quota system (0-100%), not token-count-based.

### Secondary Source: Rate-Limit Headers

Anthropic also exposes per-request quota via response headers on every API call:
- `anthropic-ratelimit-limit-tokens` — Token limit
- `anthropic-ratelimit-remaining-tokens` — Tokens remaining
- `anthropic-ratelimit-reset-tokens` — Reset time

The `/usage` endpoint is the primary, authoritative source; headers are supplementary.

### Decision for P1859 Implementation

**Path forward for AC-5:**
1. Primary: Poll `https://api.anthropic.com/api/oauth/usage` endpoint directly
2. Extract binding utilization (max of windows) and map to quota snapshot
3. Store full raw response in raw_headers jsonb for audit trail
4. reportAgentUsage accepts rate-limit headers as secondary source (AC-6)
5. Failure degradation: Write stale_flag=true row on 404/429/network error (AC-7)

### P1699 Integration

The P1699 quota-based dispatch controller consumes the snapshot:
```
effective_cap = min(max_in_flight, floor(quota_remaining * target_quota_pct))
```

Example with sample data:
- quota_remaining = 36
- target_quota_pct = 0.80
- max_in_flight = 10
- effective_cap = min(10, floor(36 * 0.80)) = min(10, 28) = 10

When quota tightens:
- If quota_remaining = 8 (only 8% left)
- effective_cap = min(10, floor(8 * 0.80)) = min(10, 6) = **6** (quota-limited)
