# P383: Single-call prop_get_detail

## Status
- Proposal: P383 (COMPLETE)
- SQL View: DEPLOYED (migration 041)
- MCP Code: WRITTEN
- Server Restart: REQUIRED to load `prop_get_detail` tool

## Problem
Agents need multiple MCP calls to get full proposal context:
- 1 call for projection (basic fields + ACs + deps)
- 1+ calls for discussions
- 1+ calls for reviews
- 1+ calls for gate decisions
- 1 call for dispatches

When a proposal is denied at gate, the rationale is buried in `gate_decisions` which requires a separate query agents often skip.

## Solution
Single MCP call `prop_get_detail` returns everything in one shot.

## Architecture

### SQL View: `roadmap_proposal.v_proposal_detail`
Location: `scripts/migrations/041-proposal-detail-view.sql`

Extends `v_proposal_full` with 4 new JSONB aggregations:
- `discussions` - all discussions (author, body, created_at)
- `reviews` - all reviews (verdict, findings, notes, reviewer)
- `gate_decisions` - full gate history (decision, rationale, blockers, challenges, AC verification)
- `active_dispatches` - open/assigned/active dispatches

All use `LEFT JOIN LATERAL` for performance.

### MCP Handler: `getProposalDetail`
Location: `src/apps/mcp-server/tools/proposals/pg-handlers.ts:1109-1239`

- Input: `{ id: string, format?: "json" | "yaml_md" }`
- Queries `v_proposal_detail` by display_id or numeric id
- Returns JSON (default) or human-readable YAML+Markdown

### Tool Registration
Location: `src/apps/mcp-server/tools/proposals/backend-switch.ts:352-372`

```typescript
server.addTool({
  name: "prop_get_detail",
  description: "Get complete proposal detail in one call...",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      format: { type: "string", enum: ["json", "yaml_md"] }
    },
    required: ["id"]
  },
  handler: (args) => handlers.getProposalDetail(args)
});
```

## Usage

```bash
# JSON (machine-readable, full detail)
mcp_proposal:prop_get_detail({id: "P206"})

# YAML+Markdown (human-readable)
mcp_proposal:prop_get_detail({id: "P206", format: "yaml_md"})
```

## Key Use Cases

### Gate Decision Visibility
When a proposal is denied, agents can see exactly why:
```json
{
  "gate_decisions": [
    {
      "decision": "hold",
      "from_state": "develop",
      "to_state": "merge",
      "decided_by": "gate-agent",
      "rationale": "SEND BACK (cycle 7). Zero implementation code exists...",
      "blockers": ["No implementation code"],
      "challenges": ["Complex dependency chain"]
    }
  ]
}
```

### One-shot Context for Agent Pickup
Agent picking up a proposal gets everything: ACs to verify, dependencies to check, what the gate agent said last time, who's dispatched, and current lease.

## Related
- Extends: `v_proposal_full` (migration 039)
- Uses: `roadmap.gate_decision_log`, `roadmap_proposal.proposal_discussions`, `roadmap_proposal.proposal_reviews`, `roadmap_workforce.squad_dispatch`
- Complements: `prop_get` (projection only), `prop_project` (alias for projection)
