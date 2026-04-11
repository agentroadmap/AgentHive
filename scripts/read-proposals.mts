import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
const transport = new SSEClientTransport(new URL('http://127.0.0.1:6421/sse'));
const client = new Client({ name: 'reader', version: '1.0.0' });
await client.connect(transport);

const ids = ['P050', 'P054', 'P051', 'P055'];
for (const id of ids) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`PROPOSAL ${id}`);
  console.log('='.repeat(80));
  try {
    const prop = await client.callTool({ name: 'prop_get', arguments: { id } });
    console.log(prop.content[0].text);
  } catch(e: any) { console.log('Error:', e.message); }
  console.log(`\n--- ACCEPTANCE CRITERIA ---`);
  try {
    const ac = await client.callTool({ name: 'list_ac', arguments: { proposalId: id } });
    console.log(ac.content[0].text);
  } catch(e: any) { console.log('Error:', e.message); }
}
await client.close();
