
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");

async function main() {
    const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
    const client = new Client({ name: "a2a-bridge", version: "1.0.0" });
    
    try {
        await client.connect(transport);
        
        // List available tools
        const tools = await client.listTools();
        console.log("=== AVAILABLE TOOLS ===");
        console.log(JSON.stringify(tools.tools.map(t => t.name)));
        
        // Get recent messages
        try {
            const msgs = await client.callTool({ name: "msg_read", arguments: { limit: 20 } });
            console.log("\n=== RECENT MESSAGES ===");
            console.log(msgs.content?.[0]?.text || JSON.stringify(msgs));
        } catch(e) {
            console.log("msg_read error:", e.message);
        }
        
        // List channels/subscriptions
        try {
            const subs = await client.callTool({ name: "chan_subscriptions", arguments: {} });
            console.log("\n=== CHANNEL SUBSCRIPTIONS ===");
            console.log(subs.content?.[0]?.text || JSON.stringify(subs));
        } catch(e) {
            console.log("chan_subscriptions error:", e.message);
        }
        
    } catch(e) {
        console.error("Connection error:", e.message);
    } finally {
        await client.close();
    }
}

main();
