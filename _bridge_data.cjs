
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");

async function main() {
    const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
    const client = new Client({ name: "a2a-bridge", version: "1.0.0" });
    
    try {
        await client.connect(transport);
        console.log("Connected");
        
        // Get channels
        const channels = await client.callTool({ name: "chan_list", arguments: {} });
        console.log("=== CHANNELS ===");
        console.log(channels.content?.[0]?.text || JSON.stringify(channels));
        
        // Get recent messages  
        const msgs = await client.callTool({ name: "msg_read", arguments: { limit: 20 } });
        console.log("\n=== MESSAGES ===");
        console.log(msgs.content?.[0]?.text || JSON.stringify(msgs));
        
        // Get agent list
        const agents = await client.callTool({ name: "agent_list", arguments: {} });
        console.log("\n=== AGENTS ===");
        console.log(agents.content?.[0]?.text || JSON.stringify(agents));
        
        // Get proposals list
        const proposals = await client.callTool({ name: "prop_list", arguments: {} });
        console.log("\n=== PROPOSALS ===");
        console.log(proposals.content?.[0]?.text || JSON.stringify(proposals));
        
        // Get notifications
        try {
            const notifs = await client.callTool({ name: "protocol_notifications", arguments: {} });
            console.log("\n=== NOTIFICATIONS ===");
            console.log(notifs.content?.[0]?.text || JSON.stringify(notifs));
        } catch(e) {
            console.log("\nNo notifications:", e.message);
        }
        
        // Get pulse/fleet status
        try {
            const pulse = await client.callTool({ name: "pulse_fleet", arguments: {} });
            console.log("\n=== FLEET STATUS ===");
            console.log(pulse.content?.[0]?.text || JSON.stringify(pulse));
        } catch(e) {
            console.log("\nNo pulse:", e.message);
        }
        
        // Get federation stats
        try {
            const fed = await client.callTool({ name: "federation_stats", arguments: {} });
            console.log("\n=== FEDERATION STATS ===");
            console.log(fed.content?.[0]?.text || JSON.stringify(fed));
        } catch(e) {
            console.log("\nNo federation:", e.message);
        }
        
        await client.close();
    } catch(e) {
        console.error("Error:", e.message, e.stack);
    }
}
main();
