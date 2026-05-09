import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

async function main() {
  const transport = new SSEClientTransport(new URL('http://127.0.0.1:6421/sse'));
  const client = new Client({ name: 'snapshot', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  const targets = ['P299', 'P904', 'P661', 'P924', 'P159', 'P912', 'P919', 'P196', 'P918', 'P746', 'P744', 'P745', 'P856', 'P855', 'P917', 'P902', 'P900', 'P901', 'P890', 'P483', 'P509', 'P893', 'P895', 'P477', 'P508'];

  console.log("Preflight Snapshot:");
  console.log("ID | Status | Maturity | Lease | Dependencies");

  for (const id of targets) {
    try {
      const getRes = await client.callTool({ name: 'mcp_proposal', arguments: { action: 'get', args: { display_id: id } } });
      const prop = JSON.parse((getRes.content as any)[0].text);
      
      let lease = 'None';
      if (prop.claim_expires_at) {
        lease = `Claimed by ${prop.agent_identity} until ${prop.claim_expires_at}`;
      }

      let deps = 'None';
      try {
        const depRes = await client.callTool({ name: 'mcp_proposal', arguments: { action: 'get_dependencies', args: { id: id } } });
        const depText = (depRes.content as any)[0].text;
        // Simple extraction logic or just print the raw text if it's brief
        deps = depText.replace(/\n/g, ' ').substring(0, 100);
      } catch (e) {}

      console.log(`${id} | ${prop.status} | ${prop.maturity} | ${lease} | ${deps}`);
    } catch (e: any) {
      console.log(`${id} | Not Found / Error`);
    }
  }

  await client.close();
}

main().catch(console.error);
