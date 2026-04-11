import type { McpServer } from "../../server.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import type { JsonSchema } from "../../validation/validators.ts";
import { execSync } from "child_process";

export function registerSdbProtocolTools(server: McpServer, projectRoot: string): void {
  server.addTool(createSimpleValidatedTool(
    { name: "protocol_intent", description: "Send negotiation intent", inputSchema: { type: "object", properties: { type: { type: "string", enum: ["claim_request", "handoff", "reject", "accept", "block"] }, proposalId: { type: "string" }, to: { type: "string" }, reason: { type: "string" } }, required: ["type", "proposalId"] } },
    { type: "object", properties: { type: { type: "string" }, proposalId: { type: "string" }, to: { type: "string" }, reason: { type: "string" } }, required: ["type", "proposalId"] },
    async (input) => {
      const args = input as { type: string; proposalId: string; to?: string; reason?: string };
      try {
        execSync(`spacetime call --server local ${process.env.SDB_NAME ?? "roadmap2"} send_message "protocol" "" "" "[${args.type}] ${args.proposalId}: ${args.reason || ''}" "high" "${Date.now()}"`, { encoding: 'utf8', cwd: projectRoot, stdio: 'pipe' });
        return { content: [{ type: "text", text: `✅ Intent sent: ${args.type} on ${args.proposalId}` }] };
      } catch (error) {
        throw new Error(`Failed: ${(error as Error).message}`);
      }
    }
  ));

  console.log('[Protocol] Registered 1 SDB tool');
}
