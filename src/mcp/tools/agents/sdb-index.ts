import type { McpServer } from "../../server.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import type { JsonSchema } from "../../validation/validators.ts";
import { SdbAgentHandlers } from "./sdb-handlers.ts";

const agentRegisterSchema: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Agent ID (e.g., 'andy', 'carter')" },
    agentType: { type: "string", enum: ["human", "agent", "manager", "worker"], description: "Agent type" },
    name: { type: "string", description: "Display name" },
    reportsTo: { type: "string", description: "Manager's agent ID (optional)" }
  },
  required: ["id", "agentType", "name"]
};

const agentGetSchema: JsonSchema = {
  type: "object",
  properties: {
    agentId: { type: "string", description: "Agent ID" }
  },
  required: ["agentId"]
};

export function registerSdbAgentTools(server: McpServer, projectRoot: string): void {
  const handlers = new SdbAgentHandlers(server, projectRoot);

  server.addTool(createSimpleValidatedTool(
    { name: "agent_register", description: "Register a new agent", inputSchema: agentRegisterSchema },
    agentRegisterSchema,
    (input) => handlers.registerAgent(input as any),
  ));

  server.addTool(createSimpleValidatedTool(
    { name: "agent_get", description: "Get agent details", inputSchema: agentGetSchema },
    agentGetSchema,
    (input) => handlers.listAgents(input as any), // listAgents is the closest in handlers.ts
  ));

  server.addTool(createSimpleValidatedTool(
    { name: "agent_workload", description: "Get agent workload (active claims)", inputSchema: agentGetSchema },
    agentGetSchema,
    (input) => handlers.getWorkload(input as { agentId: string }),
  ));

  console.log('[Agents] Registered SDB agent tools: agent_register, agent_get, agent_workload');
}
