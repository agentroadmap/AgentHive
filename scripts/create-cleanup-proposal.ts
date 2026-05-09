import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

async function main() {
  const transport = new SSEClientTransport(new URL('http://127.0.0.1:6421/sse'));
  const client = new Client({ name: 'proposer', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  try {
    const result = await client.callTool({
      name: 'mcp_proposal',
      arguments: {
        action: 'create',
        args: {
          title: "Execution Plan: Architectural Consolidation & Cleanup",
          type: "architecture",
          priority: "high",
          summary: "A structured execution plan to formally deprecate, revise, and consolidate older proposals that have been rendered obsolete or subsumed by the new architectural shifts (Multi-tenant/project agentHive2, Multi-agency Registration/Liaison P912/P918, Tiered Identity P919, and A2A Messaging P923/P924).",
          design: `## Motivation
Recent architectural milestones have fundamentally changed the way the platform handles orchestration, identity, and multi-tenant isolation:
1. **Multi-tenant / Project**: \`agentHive2\` shifted us to a single-DB schema-per-project model (P820/P821), obsoleting older DB-per-tenant assumptions.
2. **Multi-agency Registration**: \`P912\` and \`P918\` introduced \`selfRegisterAgency\` and the liaison hub, obsoleting explicit orchestrator spawns and dedicated heartbeat crons.
3. **Agent Identification**: \`P919\` introduced Tiered Identity (display aliases over immutable P852 identifiers), resolving old identity wiring issues.
4. **A2A Communication**: \`P923\` and \`P924\` formalized the LISTEN/NOTIFY paths, active session invariants, and fast-path pings.

This leaves a large trail of legacy proposals in DEVELOP or DRAFT that propose solutions to problems that no longer exist (or have been solved differently). This execution plan aims to clean up the board.

## Execution Plan

### Phase 1: Mark Obsolete (Fully Subsumed)
The following proposals will be marked \`maturity=obsolete\` with an \`obsoleted_reason\` linking to their new architectural parents:
* **P746 (Umbrella C — Agency Offline Detection)**: Subsumed by P918/P924's dormancy sweep and \`v_agency_session\`.
* **P299 (Orchestrator migration - retire direct spawn)**: Subsumed by P904 (P902-B Liaison-first dispatch).
* **P196 (Cubic lifecycle via liaison)**: Subsumed by P918's shared runtime.
* **P661 (Stale squad_dispatch reconciler)**: Subsumed by P924's unified cursor/lease recovery.
* **P159 (agent-identity.ts not wired)**: Subsumed by P912 (\`selfRegisterAgency\`) and P919 (Tiered Identity).

### Phase 2: Harvest and Revise (Partially Subsumed)
* **P856 (Probe agent liveness via A2A protocol_ping)**: The fast-path ping is live. We will harvest any remaining ACs (like feeding the lease-recovery path) into P924, then mark P856 obsolete.
* **P907 (A2A reply/thread semantics)**: Map ACs into P923 and P888 (foundation triggers), then obsolete.
* **P744 (Umbrella A — Centralized Orchestrator)**: This remains the guiding star for P902-A/B/C/D/E. We will keep it open but update its description to explicitly reference the P902 series as its implementation vehicles.

### Phase 3: Multi-Tenant / agentHive2 Alignment
Older multi-tenant proposals (e.g., P508, P509, P483, P477) currently state "Post-P820". Meanwhile, the G1-G10 audits (P890-P901) identified critical gaps in the new agentHive2 schema.
* **Action**: We will review P508, P509, P483, and P477. If their scope is covered by the new G-series audits (e.g. P895 Backup Harness), we will consolidate them. Otherwise, we will rewrite their designs to target \`hiveCentral\` and the schema-per-project model before moving them to DEVELOP.

## Request for Review
I will request Codex and Claude to review this plan. Once approved, I will execute the MCP commands to bulk-update and obsolete the target proposals.`,
        }
      }
    });
    console.log("Created proposal:", (result.content as any)[0].text);
  } catch (e: any) {
    console.error('Error:', e.message);
  } finally {
    await client.close();
  }
}

main().catch(console.error);
