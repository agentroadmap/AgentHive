import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

async function main() {
  const transport = new SSEClientTransport(new URL('http://127.0.0.1:6421/sse'));
  const client = new Client({ name: 'updater', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  // 1. Delete the bad ACs (AC-1 to AC-6). They are at index 1 to 6.
  // Note: we should delete from the back to front to avoid shifting indices.
  for (let i = 6; i >= 1; i--) {
    try {
      console.log(`Deleting AC ${i}...`);
      await client.callTool({ name: 'mcp_proposal', arguments: { action: 'delete_ac', args: { proposal_id: 'P919', index: i } } });
    } catch (e: any) {
      console.log(`Failed to delete AC ${i}: ${e.message}`);
    }
  }

  // 2. Fetch the current proposal
  const propResult = await client.callTool({ name: 'mcp_proposal', arguments: { action: 'get', args: { display_id: 'P919' } } });
  const prop = JSON.parse((propResult.content as any)[0].text);

  // 3. Update the design to address review findings
  let design = prop.design;
  
  // Add clarification on alias uniqueness and lifecycle
  design += `\n\n## Alias Lifecycle and Uniqueness (Review Fix)\n\n`;
  design += `To prevent UNIQUE collisions when an agent crashes and restarts quickly, the index on \`display_alias\` will be a **partial unique index** covering only active rows: \`CREATE UNIQUE INDEX idx_agent_alias_active ON roadmap_workforce.agent_registry (display_alias) WHERE status = 'active';\`. When a slot crashes, the heartbeat dormancy sweep (from P924) flips the old row to \`inactive\`, freeing the alias for the respawned slot to claim.\n`;
  
  // Add clarification on naming authority
  design += `\n\n## Naming Authority (Review Fix)\n\n`;
  design += `To resolve overlap with P920 and roadmap.agency: \`roadmap.agency.display_name\` is the single authoritative human name for the agency itself. The \`display_alias\` in \`agent_registry\` is strictly for *individual agent instances* (workers, slots) under that agency. P920's \`persona_name\` is hereby deferred; all human-readable labeling for CLI/dashboard display of agents relies exclusively on this \`display_alias\`.\n`;

  // Update the proposal
  console.log("Updating proposal P919...");
  await client.callTool({ 
    name: 'mcp_proposal', 
    arguments: { 
      action: 'update', 
      args: { 
        id: 'P919',
        design: design
      } 
    } 
  });

  // Add the new AC
  console.log("Adding new AC for lifecycle...");
  await client.callTool({
      name: 'mcp_proposal',
      arguments: {
          action: 'add_acceptance_criteria',
          args: {
              proposal_id: 'P919',
              criteria: "AC-10: Alias Uniqueness Lifecycle. The `display_alias` column has a partial unique index `WHERE status = 'active'`. A unit test verifies that when an agent row is marked 'inactive', a new agent row can successfully claim the same `display_alias`."
          }
      }
  });

  console.log("P919 updated.");
  await client.close();
}

main().catch(console.error);
