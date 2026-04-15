
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");

async function main() {
    const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
    const client = new Client({ name: "a2a-bridge", version: "1.0.0" });
    
    try {
        await client.connect(transport);
        
        // Get details on proposals using id field
        const proposals = ["P199", "P184", "P185", "P170", "P067"];
        for (const p of proposals) {
            const detail = await client.callTool({ name: "prop_get", arguments: { id: p } });
            console.log(`\n=== ${p} DETAIL ===`);
            const text = detail.content?.[0]?.text || JSON.stringify(detail);
            console.log(text.substring(0, 1000));
        }
        
        // Get escalation stats
        const esc = await client.callTool({ name: "escalation_stats", arguments: {} });
        console.log("\n=== ESCALATION STATS ===");
        console.log(esc.content?.[0]?.text || JSON.stringify(esc));
        
        // Get open escalations
        const escList = await client.callTool({ name: "escalation_list", arguments: {} });
        console.log("\n=== ESCALATIONS ===");
        console.log(escList.content?.[0]?.text || JSON.stringify(escList));
        
        await client.close();
    } catch(e) {
        console.error("Error:", e.message);
    }
}
main();
