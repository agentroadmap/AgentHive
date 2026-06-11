# P1730 AC-1: MCP Init Diagnosis Guide

## Overview

**Problem**: Since 2026-06-02, concurrent spawns (cap >= 5) experience 20-minute zero-output failures. Hypothesis: MCP-init contention on the single `127.0.0.1:6421/sse` endpoint.

**Solution**: Instrument MCP init with separate 60-90s timeout + collect timing baselines at different concurrency caps to confirm/refute the contention hypothesis.

## How to Collect Diagnostics

### 1. Set Environment Variables

```bash
# Enable MCP init instrumentation (already default):
export AGENTHIVE_MCP_CONNECT_TIMEOUT_MS=90000

# Optional: use a shorter timeout for faster diagnostics
# export AGENTHIVE_MCP_CONNECT_TIMEOUT_MS=30000
```

### 2. Run Spawns at Different Concurrency Levels

The diagnostics system records timing for every spawn. Run controlled tests at multiple cap levels:

#### Baseline (cap = 1)
```bash
# Set spawn cap to 1 (conservative)
# Restart orchestrator or set via runtime config
# Run 10-20 normal proposals through DEVELOP/REVIEW workflow
# Expected: init times 1-3s, all "ready"
```

#### Moderate Load (cap = 3-5)
```bash
# Gradually increase cap to 3, then 5
# Run the same workload
# Expected: if init is NOT contended, times stay 1-3s
# If init IS contended, times rise to 10-30s (still < 90s timeout)
```

#### High Load (cap = 8-12)
```bash
# Increase cap to 8-12
# Run the workload
# Expected if contended: times spike to 60-90s, timeouts visible
# Expected if NOT contended: times stay < 5s, high throughput
```

### 3. Extract the Diagnosis Report

After collecting samples, access the in-memory diagnostics:

#### Via CLI (if exposed)
```bash
hive diagnostics mcp-init
```

#### Via Direct API Call
```typescript
import { getMcpInitDiagnosticsReport } from "src/core/orchestration/agent-spawner.ts";

console.log(getMcpInitDiagnosticsReport());
```

#### Via Database (post-implementation in AC-4)
```sql
-- Future: P1730 will store timings in a table for historical analysis
SELECT * FROM roadmap.mcp_init_timings
WHERE timestamp >= now() - interval '1 hour'
ORDER BY timestamp DESC;
```

### 4. Interpret Results

The report shows:
```
## P1730 AC-1 Diagnosis: MCP Init Timing Report

Collected 47 MCP init samples.

Baseline (min): 1200ms
Maximum: 89000ms
Average: 15300ms

Distribution by status:
  ready: 41 (87%) — max 45000ms
  timeout: 6 (13%) — max 89000ms

Next steps:
- If max > 60s, MCP init contention confirmed → proceed to AC-4
- If max < 10s, init is not the bottleneck → investigate shared resources (DB pool, OAuth tokens)
```

## Interpretation Guide

### Contention Confirmed (max > 60s)
- **Evidence**: max init times exceed 60s at cap >= 5
- **Root cause**: MCP-sse-server is serializing/queuing concurrent init requests
- **Remediation**: AC-4 mitigation (scale server, per-spawn endpoint, or stagger init)

### No Contention (max < 10s)
- **Evidence**: init times stay <10s even at cap=12
- **Root cause**: different bottleneck (DB pool exhaustion, OAuth token thrashing, child CPU)
- **Remediation**: investigate shared-resource hypothesis (P1365, P1682)

### Ambiguous (max 30-60s)
- **Evidence**: moderate slowdown at high concurrency
- **Root cause**: partial contention or combined factors
- **Remediation**: AC-4 mitigation + monitor shared resources

## Expected Timeline

1. **Collect**: ~2 hours of normal workflow at cap=1, 3, 5, 8 (auto-collected)
2. **Analyze**: Review report output, confirm hypothesis
3. **Build**: Implement AC-4 mitigation based on findings
4. **Verify**: Re-run at cap=5+ with mitigation, confirm <5% livelock rate (AC-3)

## Architecture

### Timing Collection Points

The `mcp-init-wrapper.ts` module records:

- **startMs**: wall-clock start of spawn
- **connectMs**: time to TCP connect (if logged by child)
- **authMs**: time from connect to auth complete
- **firstMessageMs**: time to first MCP tool response
- **totalMs**: total elapsed time
- **status**: pending → connected → authenticated → ready (or timeout)

### Child-side Instrumentation

For timing to be captured, the spawned child must emit log lines:
```
[mcp-init] connect start
[mcp-init] auth complete
[mcp-init] ready
```

These lines are parsed from stderr by the wrapper.

### Diagnostic Export Points

```typescript
// In-memory diagnostics (for live monitoring)
getMcpInitDiagnostics(capLevel?: number)
getMcpInitDiagnosticsReport()

// Per-sample inspection
getMcpInitTimings()  // all samples
clearMcpInitTimings() // reset between test runs
```

## Known Limitations

1. **Timing accuracy**: microsecond-level jitter due to Node.js event loop scheduling
2. **Lost samples**: if child crashes before emitting [mcp-init] markers, sample is dropped
3. **In-memory only**: diagnostics are cleared on orchestrator restart
4. **No historical**: current implementation doesn't persist to DB (P1730 AC-5 deferred)

## Debugging

### Timings not appearing?

Check:
1. Is `AGENTHIVE_MCP_CONNECT_TIMEOUT_MS` set in orchestrator env?
2. Does spawned child emit `[mcp-init]` markers to stderr?
3. Is MCP_URL in the process env?

### Spike in init times but no timeouts?

Likely causes:
- MCP server under load (concurrent tools, large responses)
- Network latency to MCP endpoint
- Child process CPU contention

Check:
```bash
# Monitor MCP server health
sudo systemctl status agenthive-mcp
journalctl -u agenthive-mcp -f

# Monitor system load
top -p $(pgrep -f mcp-sse-server)
```

## References

- P1730 AC-1: Root-cause MCP init contention
- P1730 AC-2: Implement separate MCP-connect timeout
- P1730 AC-3: Verify fix reduces livelock <5% at cap=5+
- P1730 AC-4: Deploy mitigation (scale, endpoint, stagger)
