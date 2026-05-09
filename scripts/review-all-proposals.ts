import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

async function main() {
  const transport = new SSEClientTransport(new URL('http://127.0.0.1:6421/sse'));
  const client = new Client({ name: 'reader', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  try {
    const listResult = await client.callTool({ name: 'mcp_proposal', arguments: { action: 'list' } });
    const response = JSON.parse((listResult.content as any)[0].text);
    const proposals = response.items;
    
    for (const p of proposals) {
       console.log(`${p.display_id} | Status: ${p.status} | Maturity: ${p.maturity} | Type: ${p.type}`);
       console.log(`Title: ${p.title}`);
       // Get detail to see summary/motivation
       try {
           const detailResult = await client.callTool({ name: 'mcp_proposal', arguments: { action: 'get', args: { display_id: p.display_id } } });
           const detail = JSON.parse((detailResult.content as any)[0].text);
           console.log(`Summary: ${detail.summary}\n`);
       } catch (e: any) {
           console.log(`Summary: Error fetching detail (${e.message})\n`);
       }
    }
  } catch (e: any) {
    console.error('Error:', e);
  } finally {
    await client.close();
  }
}

main().catch(console.error);
