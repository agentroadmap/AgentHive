
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");

async function main() {
    const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
    const client = new Client({ name: "a2a-bridge", version: "1.0.0" });
    
    try {
        await client.connect(transport);
        
        // Get proposals in various active states
        for (const state of ["Review", "Draft"]) {
            const props = await client.callTool({ name: "prop_list", arguments: { state } });
            console.log(`=== ${state.toUpperCase()} PROPOSALS ===`);
            console.log(props.content?.[0]?.text || JSON.stringify(props));
            console.log();
        }
        
        // Get subscriptions
        const subs = await client.callTool({ name: "chan_subscriptions", arguments: {} });
        console.log("=== SUBSCRIPTIONS ===");
        console.log(subs.content?.[0]?.text || JSON.stringify(subs));
        
    } catch(e) {
        console.error("Connection error:", e.message);
    } finally {
        await client.close();
    }
}

main();
