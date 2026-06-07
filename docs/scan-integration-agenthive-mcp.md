# scan-hardcoding: AgentHive MCP Integration

The `mcp_scan` MCP tool wraps the hardcoding scanner and optionally emits findings into the
`proposal_event` table so the gate pipeline can require a clean scan before advancing a proposal
transition.

## Tool: `mcp_scan`

```jsonc
// Input schema
{
  "paths": ["src/apps/"],          // optional; defaults to src/**/*.ts, scripts/**/*.ts
  "proposal_id": 454,              // optional; emits a scan_result event for this proposal
  "format": "jsonl",               // "human" (default) or "jsonl"
  "min_severity": "high",          // "critical" | "high" | "medium" | "low"
  "min_confidence": "high",        // "high" | "medium" | "low"
  "rule_tag": "paths",             // filter by tag
  "git_changed": true              // scan only files changed since main
}
```

### Example: focused scan before a gate review

```jsonc
// Tool call
{ "tool": "mcp_scan", "input": { "git_changed": true, "format": "jsonl", "proposal_id": 454 } }
```

The tool returns findings in the requested format and, if `proposal_id` is set, inserts a row into
`roadmap_proposal.proposal_event`:

```json
{
  "event_type": "scan_result",
  "payload": {
    "total": 3,
    "by_severity": { "high": 2, "medium": 1 },
    "top_rules": [
      { "rule": "paths.agenthive-worktree-root", "count": 2 },
      { "rule": "endpoints.mcp-url", "count": 1 }
    ],
    "ts": "2026-06-07T19:00:00Z"
  }
}
```

## Gate pipeline integration

Gate reviewers can query `proposal_event` to require a clean scan before approving a proposal
transition to MERGE:

```sql
SELECT payload->>'total' AS total_findings
FROM roadmap_proposal.proposal_event
WHERE proposal_id = 454
  AND event_type = 'scan_result'
ORDER BY created_at DESC
LIMIT 1;
```

If `total_findings > 0`, the gate reviewer should HOLD the transition and reference the scan_result
event in the review comment.

## Running from a gate reviewer agent

Gate agents can invoke `mcp_scan` directly over the MCP connection:

```typescript
const result = await mcp.call("mcp_scan", {
  git_changed: true,
  format: "jsonl",
  proposal_id: proposalId,
  min_severity: "high",
});
// result.content[0].text — JSONL findings, one per line
```

## Schema versioning

All JSONL output carries `schema_version: 1`. Consumers must check this field and reject records
from a higher unknown version. The full JSON Schema is at
`src/tools/scanner/schema/findings.schema.json`.

## Auto-fix safety

The fix engine (`src/tools/scan-fix/engine.ts`) enforces that only rules with an explicit
`auto_fix:` YAML descriptor are eligible for mechanical transforms. Rules without `auto_fix:`
are added to the `rejected` set and a reason is emitted — they are never silently dropped.

```typescript
import { buildFixPlan } from "../src/tools/scan-fix/engine.ts";

const plan = buildFixPlan(scanResult, ruleIndex);
// plan.safe    — auto-fixable findings
// plan.rejected — findings requiring manual remediation
```
