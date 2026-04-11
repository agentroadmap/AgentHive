import type { McpServer } from "../../server.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import type { JsonSchema } from "../../validation/validators.ts";
import { SdbWorkflowHandlers } from "./sdb-handlers.ts";

const claimSchema: JsonSchema = {
  type: "object",
  properties: {
    stepId: { type: "string", description: "Step ID to claim" },
    agentId: { type: "string", description: "Agent claiming" },
  },
  required: ["stepId", "agentId"],
};

const transitionSchema: JsonSchema = {
  type: "object",
  properties: {
    stepId: { type: "string", description: "Step ID" },
    toStatus: { type: "string", description: "Target status" },
    reason: { type: "string", description: "Reason for transition" },
  },
  required: ["stepId", "toStatus"],
};

const reviewSchema: JsonSchema = {
  type: "object",
  properties: {
    stepId: { type: "string", description: "Step ID" },
    outcome: { type: "string", enum: ["accepted", "rejected", "needs-revision"], description: "Review outcome" },
  },
  required: ["stepId", "outcome"],
};

const readyWorkSchema: JsonSchema = { type: "object", properties: {}, required: [] };

export function registerSdbWorkflowTools(server: McpServer, projectRoot: string): void {
  const handlers = new SdbWorkflowHandlers(server, projectRoot);
  
  server.addTool(createSimpleValidatedTool({ name: "workflow_claim", description: "Claim a step", inputSchema: claimSchema }, claimSchema, (input) => handlers.claimStep(input as { stepId: string; agentId: string })));
  server.addTool(createSimpleValidatedTool({ name: "workflow_transition", description: "Transition step status", inputSchema: transitionSchema }, transitionSchema, (input) => handlers.transitionStep(input as { stepId: string; toStatus: string; reason?: string })));
  server.addTool(createSimpleValidatedTool({ name: "workflow_review", description: "Review a step", inputSchema: reviewSchema }, reviewSchema, (input) => handlers.reviewStep(input as { stepId: string; outcome: string })));
  server.addTool(createSimpleValidatedTool({ name: "workflow_ready", description: "Get ready-to-work items", inputSchema: readyWorkSchema }, readyWorkSchema, () => handlers.getReadyWork({})));
  
  console.log('[Workflow] Registered 4 SDB tools: claim, transition, review, ready');
}
