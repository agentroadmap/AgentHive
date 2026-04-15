
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");

async function main() {
    const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
    const client = new Client({ name: "a2a-bridge", version: "1.0.0" });
    
    try {
        await client.connect(transport);
        
        // Get protocol threads
        const threads = await client.callTool({ name: "protocol_thread_list", arguments: {} });
        console.log("=== PROTOCOL THREADS ===");
        console.log(threads.content?.[0]?.text || JSON.stringify(threads));
        
        // Get protocol mentions
        const mentions = await client.callTool({ name: "protocol_notifications", arguments: {} });
        console.log("\n=== PROTOCOL NOTIFICATIONS ===");
        console.log(mentions.content?.[0]?.text || JSON.stringify(mentions));
        
        // Get pulse fleet
        const fleet = await client.callTool({ name: "pulse_fleet", arguments: {} });
        console.log("\n=== FLEET STATUS ===");
        console.log(fleet.content?.[0]?.text || JSON.stringify(fleet));
        
        // Get proposals in active states
        const proposals = await client.callTool({ name: "prop_list", arguments: { status: "DEVELOP" } });
        console.log("\n=== ACTIVE DEVELOP PROPOSALS ===");
        console.log(proposals.content?.[0]?.text || JSON.stringify(proposals));
        
        // Get workflow overview
        const workflow = await client.callTool({ name: "get_workflow_overview", arguments: {} });
        console.log("\n=== WORKFLOW ===");
        console.log(workflow.content?.[0]?.text?.substring(0, 1000) || JSON.stringify(workflow).substring(0, 1000));
        
        await client.close();
    } catch(e) {
        console.error("Error:", e.message);
    }
}
main();
