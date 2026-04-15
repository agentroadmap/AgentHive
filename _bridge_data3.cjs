
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");

async function main() {
    const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
    const client = new Client({ name: "a2a-bridge", version: "1.0.0" });
    
    try {
        await client.connect(transport);
        
        // Get REVIEW proposals
        const review = await client.callTool({ name: "prop_list", arguments: { status: "REVIEW" } });
        console.log("=== REVIEW PROPOSALS ===");
        console.log(review.content?.[0]?.text || JSON.stringify(review));
        
        // Get MERGE proposals
        const merge = await client.callTool({ name: "prop_list", arguments: { status: "MERGE" } });
        console.log("\n=== MERGE PROPOSALS ===");
        console.log(merge.content?.[0]?.text || JSON.stringify(merge));
        
        // Get DRAFT proposals
        const draft = await client.callTool({ name: "prop_list", arguments: { status: "DRAFT" } });
        console.log("\n=== DRAFT PROPOSALS ===");
        console.log(draft.content?.[0]?.text || JSON.stringify(draft));
        
        // Get active leases
        const leases = await client.callTool({ name: "prop_leases", arguments: {} });
        console.log("\n=== ACTIVE LEASES ===");
        console.log(leases.content?.[0]?.text || JSON.stringify(leases));
        
        // Read messages from broadcast channel
        const broadcast = await client.callTool({ name: "msg_read", arguments: { channel: "broadcast", limit: 10 } });
        console.log("\n=== BROADCAST MESSAGES ===");
        console.log(broadcast.content?.[0]?.text || JSON.stringify(broadcast));
        
        // Read messages from direct channel
        const direct = await client.callTool({ name: "msg_read", arguments: { channel: "direct", limit: 10 } });
        console.log("\n=== DIRECT MESSAGES ===");
        console.log(direct.content?.[0]?.text || JSON.stringify(direct));
        
        await client.close();
    } catch(e) {
        console.error("Error:", e.message);
    }
}
main();
