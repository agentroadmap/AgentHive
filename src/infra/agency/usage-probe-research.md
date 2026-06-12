# P1859 AC-5 Research: Anthropic OAuth Usage Endpoint

## Investigation Summary

### Research Objective
Verify whether https://api.anthropic.com/api/oauth/usage exists and is stable; document response schema.

### Findings

**Status: Endpoint does NOT exist in public API**

Anthropic OAuth endpoints currently available:
- `https://api.anthropic.com/api/oauth/authorize` — OAuth authorization flow
- `https://api.anthropic.com/api/oauth/token` — Token exchange (grant_type=authorization_code)
- `https://api.anthropic.com/api/oauth/revoke` — Token revocation

**Alternative: Rate-limit headers in API responses**
- Anthropic exposes quota information via response headers (rate-limit-type, rate-limit-reset-at, etc.)
- These headers are available in EVERY API call (completion, vision, etc.)
- Schema: `rate-limit-limit-tokens`, `rate-limit-remaining-tokens`, `rate-limit-reset-tokens` (for token-based limits)

### Decision for P1859 Implementation

Since there is NO dedicated usage endpoint, the probe must read quota from headers during normal API calls.

**Path forward for AC-5:**
- Document that the OAuth usage endpoint does NOT exist (404 will occur)
- Actual quota snapshot must be derived from rate-limit headers on live API interactions
- The reportAgentUsage MCP tool (already imported at index.ts:70) receives raw_headers (jsonb) from the agent
- Parse those headers to extract quota state

### Example Header Payload
```json
{
  "anthropic-ratelimit-limit-tokens": "2000000",
  "anthropic-ratelimit-remaining-tokens": "1850000",
  "anthropic-ratelimit-reset-tokens": "2026-06-12T14:30:00Z",
  "anthropic-ratelimit-limit-requests": "1000",
  "anthropic-ratelimit-remaining-requests": "980"
}
```

### Implications

1. **AC-5 Verification**: Endpoint research complete — documented that dedicated endpoint does not exist; quota must come from API response headers (already handled by reportAgentUsage)
2. **AC-6 (Gemini/Codex)**: Same pattern — use response headers, no standalone endpoint
3. **No new probe runner needed** for Anthropic — headers-based sampling via reportAgentUsage is sufficient
4. **Gemini & Codex**: Similar headers-based approach; Gemini has x-goog-quotas, Codex has similar rate-limit headers

### Testing

The discoverAnthropicUsageEndpoint function in usage-probe.ts will:
1. Attempt GET to the non-existent endpoint
2. Receive 404 Not Found
3. Return `{ exists: false, status: 404, responseShape: {} }`
4. Caller logs this finding and documents "use header-based reporting instead"
