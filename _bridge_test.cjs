
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");

async function main() {
    const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
    const client = new Client({ name: "a2a-bridge", version: "1.0.0" });
    
    try {
        await client.connect(transport);
        console.log("Connected to MCP server");
        
        // List tools
        const toolsResult = await client.listTools();
        const toolNames = toolsResult.tools.map(t => t.name);
        console.log("Tools available:", JSON.stringify(toolNames));
        
        // Try A2A-related tools
        for (const toolName of toolNames) {
            if (toolName.toLowerCase().includes('channel') || 
                toolName.toLowerCase().includes('message') || 
                toolName.toLowerCase().includes('a2a') ||
                toolName.toLowerCase().includes('proposal') ||
                toolName.toLowerCase().includes('activity') ||
                toolName.toLowerCase().includes('agent')) {
                try {
                    const result = await client.callTool({ name: toolName, arguments: {} });
                    const text = result.content?.[0]?.text || JSON.stringify(result);
                    console.log(`\n=== ${toolName} ===`);
                    console.log(text.substring(0, 2000));
                } catch(e) {
                    console.log(`${toolName}: ${e.message}`);
                }
            }
        }
        
        await client.close();
    } catch(e) {
        console.error("Error:", e.message);
    }
}
main();
