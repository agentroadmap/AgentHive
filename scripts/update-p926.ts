import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

async function main() {
  const transport = new SSEClientTransport(new URL('http://127.0.0.1:6421/sse'));
  const client = new Client({ name: 'updater', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  const design = `## Motivation
Recent architectural milestones (Multi-tenant agentHive2, Multi-agency P912/P918, Tiered Identity P919, and A2A Messaging P923/P924) require a formal cleanup of the proposal backlog. Previous attempts at bulk obsoletion were premature and risky. This proposal defines a surgical, target-by-target execution plan to consolidate, rewrite, or safely defer legacy proposals.

## Target-by-Target Disposition

| ID   | Action  | Target / Parent | Justification / Notes |
|------|---------|-----------------|-----------------------|
| **P299** | Defer | P904 | Cannot obsolete until P904 (Liaison-first dispatch) is COMPLETE. |
| **P661** | Defer | None | Concerns stale \`squad_dispatch\` reconciliation, not liaison messages. Do not obsolete. |
| **P159** | Defer | None | Concerns \`public_key\` and \`key_rotated_at\` wiring. Not covered by P912/P919. Do not obsolete. |
| **P196** | Defer | None | Cubic lifecycle cleanup. Keep active. |
| **P746** | Defer | None | Has unresolved dependency state (P744 -> P746 -> P745). No bulk obsoletion. |
| **P856** | Migrate | P924 | Blocks P855. ACs must be explicitly migrated to P924 before obsoleting. |
| **P907** | Migrate | P923, P888 | A2A thread semantics. ACs must be mapped to P923 and P888 before obsoleting. |
| **P744** | Rewrite | P902 series | Central orchestrator umbrella. Must be updated to explicitly reference P902-A/B/C/D/E as implementation vehicles. |
| **P483** | Rewrite | P893 | Project lifecycle ops. Rewrite design to target \`hiveCentral\` tenant lifecycle. |
| **P509** | Rewrite | P895 | Tenant DB ops. Rewrite design to target \`hiveCentral\` backup harness. |
| **P477** | Defer | None | Web control-plane redesign. Too large to safely bulk-subsume. |
| **P508** | Defer | None | Tenant schema templates. Too large to safely bulk-subsume. |
| **P917** | Include | P912 AC-6 | MCP agency lifecycle actions. Keep active in scope. |
| **P900** | Include | P835 follow-up | Poison-pill persistence. Keep active in scope. |
| **P901** | Include | G10 Audit | Cross-project registries. Keep active in scope. |
| **P890** | Closeout| Self | Add explicit closeout rule for when the agentHive2 design audit is complete. |

## Preflight Snapshot
(All listed proposals currently have NO active leases)
- P299 (DEVELOP/new)
- P904 (DRAFT/new)
- P661 (DEVELOP/new)
- P924 (MERGE/new)
- P159 (DEVELOP/new)
- P912 (REVIEW/mature)
- P919 (DEVELOP/new)
- P196 (DEVELOP/new)
- P918 (REVIEW/new)
- P746 (DEVELOP/new)
- P744 (DEVELOP/new)
- P745 (COMPLETE/new)
- P856 (DRAFT/new)
- P855 (COMPLETE/mature)
- P917 (DRAFT/new)
- P902 (DRAFT/new)
- P900 (DRAFT/new)
- P901 (DRAFT/new)
- P890 (DRAFT/new)
- P483 (DEVELOP/new)
- P509 (DEVELOP/new)
- P893 (REVIEW/new)
- P895 (REVIEW/new)
- P477 (DRAFT/new)
- P508 (DEVELOP/new)
`;

  try {
    // 1. Update the proposal design
    console.log("Updating P926 design...");
    await client.callTool({
      name: 'mcp_proposal',
      arguments: {
        action: 'update',
        args: {
          id: 'P926',
          design: design
        }
      }
    });

    // 2. Add Acceptance Criteria
    const acs = [
      "AC-1: Migration of P856 to P924 is completed (ACs transferred) and P856 is marked maturity=obsolete with obsoleted_reason linking to P924.",
      "AC-2: Migration of P907 to P923/P888 is completed (ACs mapped) and P907 is marked maturity=obsolete with obsoleted_reason linking to parents.",
      "AC-3: P744 description is explicitly updated to list P902-A/B/C/D/E as its implementation vehicles.",
      "AC-4: P483 and P509 designs are rewritten to specifically target the new hiveCentral schema, aligning with P893 and P895 respectively.",
      "AC-5: A concrete closeout rule for P890 (agentHive2 design audit) is established and documented.",
      "AC-6: P299, P661, P159, P196, P746, P477, and P508 remain open and untouched by this consolidation effort."
    ];

    for (const ac of acs) {
      console.log(`Adding AC: ${ac.substring(0, 30)}...`);
      await client.callTool({
        name: 'mcp_proposal',
        arguments: {
          action: 'add_acceptance_criteria',
          args: {
            proposal_id: 'P926',
            criteria: ac
          }
        }
      });
    }
    
    console.log("P926 update complete.");
  } catch (e: any) {
    console.error('Error:', e.message);
  } finally {
    await client.close();
  }
}

main().catch(console.error);
