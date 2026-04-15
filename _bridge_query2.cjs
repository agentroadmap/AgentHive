
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");

async function main() {
    const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
    const client = new Client({ name: "a2a-bridge", version: "1.0.0" });
    
    try {
        await client.connect(transport);
        
        // Get all recent messages
        const msgs = await client.callTool({ name: "msg_read", arguments: { limit: 50 } });
        console.log("=== ALL MESSAGES ===");
        console.log(msgs.content?.[0]?.text || JSON.stringify(msgs));
        
        // List channels
        try {
            const ch = await client.callTool({ name: "chan_list", arguments: {} });
            console.log("\n=== CHANNELS ===");
            console.log(ch.content?.[0]?.text || JSON.stringify(ch));
        } catch(e) {
            console.log("chan_list error:", e.message);
        }
        
        // List agents
        try {
            const agents = await client.callTool({ name: "agent_list", arguments: {} });
            console.log("\n=== AGENTS ===");
            console.log(agents.content?.[0]?.text || JSON.stringify(agents));
        } catch(e) {
            console.log("agent_list error:", e.message);
        }
        
        // List proposals in active states
        try {
            const props = await client.callTool({ name: "prop_list", arguments: { state: "Develop" } });
            console.log("\n=== DEVELOP PROPOSALS ===");
            console.log(props.content?.[0]?.text || JSON.stringify(props));
        } catch(e) {
            console.log("prop_list error:", e.message);
        }
        
    } catch(e) {
        console.error("Connection error:", e.message);
    } finally {
        await client.close();
    }
}

main();
