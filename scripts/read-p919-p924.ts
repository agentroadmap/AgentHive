import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

function mcpText(result: any): string {
  return (result.content as any)?.[0]?.text || JSON.stringify(result, null, 2);
}

async function main() {
  const transport = new SSEClientTransport(new URL('http://127.0.0.1:6421/sse'));
  const client = new Client({ name: 'reader', version: '1.0.0' });
  await client.connect(transport);

  const ids = ['P919', 'P920', 'P921', 'P922', 'P923', 'P924'];
  for (const id of ids) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`PROPOSAL ${id}`);
    console.log('='.repeat(80));
    try {
      const prop = await client.callTool({ name: 'prop_get', arguments: { id } });
      console.log(mcpText(prop));
    } catch(e: any) { console.log('Error:', e.message); }
    
    console.log(`\n--- MATURITY ---`);
    try {
        const projection = await client.callTool({ name: 'mcp_get_proposal_projection', arguments: { id } });
        console.log(mcpText(projection));
    } catch(e: any) { console.log('Error:', e.message); }

    console.log(`\n--- REVIEWS ---`);
    try {
      const reviews = await client.callTool({ name: 'list_reviews', arguments: { proposal_id: id } });
      console.log(mcpText(reviews));
    } catch(e: any) { console.log('Error:', e.message); }
  }
  await client.close();
}

main().catch(console.error);
