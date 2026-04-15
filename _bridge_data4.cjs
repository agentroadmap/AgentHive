
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");

async function main() {
    const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
    const client = new Client({ name: "a2a-bridge", version: "1.0.0" });
    
    try {
        await client.connect(transport);
        
        // Get details on a few interesting proposals
        const proposals = ["P199", "P184", "P185", "P170", "P067"];
        for (const p of proposals) {
            const detail = await client.callTool({ name: "prop_get", arguments: { proposal_id: p } });
            console.log(`\n=== ${p} DETAIL ===`);
            const text = detail.content?.[0]?.text || JSON.stringify(detail);
            console.log(text.substring(0, 800));
        }
        
        // Get reviews for P184
        try {
            const reviews = await client.callTool({ name: "list_reviews", arguments: { proposal_id: "P184" } });
            console.log("\n=== P184 REVIEWS ===");
            console.log(reviews.content?.[0]?.text || JSON.stringify(reviews));
        } catch(e) {
            console.log("\nNo P184 reviews:", e.message);
        }
        
        // Get reviews for P199
        try {
            const reviews2 = await client.callTool({ name: "list_reviews", arguments: { proposal_id: "P199" } });
            console.log("\n=== P199 REVIEWS ===");
            console.log(reviews2.content?.[0]?.text || JSON.stringify(reviews2));
        } catch(e) {
            console.log("\nNo P199 reviews:", e.message);
        }
        
        await client.close();
    } catch(e) {
        console.error("Error:", e.message);
    }
}
main();
