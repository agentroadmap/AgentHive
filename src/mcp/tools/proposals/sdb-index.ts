/**
 * SpacetimeDB-backed Proposal Tools
 */

import type { McpServer } from "../../server.ts";
import type { McpToolHandler } from "../../types.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import type { JsonSchema } from "../../validation/validators.ts";
import { SdbProposalHandlers } from "./sdb-handlers.ts";

const proposalListSchema: JsonSchema = {
  type: "object",
  properties: {
    status: { type: "string", description: "Filter by status (active, complete, potential)" },
    assignee: { type: "string", description: "Filter by assignee" },
    limit: { type: "number", description: "Max results" },
  },
  required: [],
};

const proposalGetSchema: JsonSchema = {
  type: "object",
  properties: {
    proposalId: { type: "string", description: "Proposal ID (e.g., STATE-090)" },
  },
  required: ["proposalId"],
};

const proposalCreateSchema: JsonSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "Proposal title" },
    proposal_type: { type: "string", enum: ["DIRECTIVE", "CAPABILITY", "TECHNICAL", "COMPONENT", "OPS_ISSUE"], description: "Proposal type" },
    category: { type: "string", enum: ["FEATURE", "BUG", "RESEARCH", "SECURITY", "INFRA"], description: "Category" },
    domain_id: { type: "string", description: "Business domain (e.g., ENGINE, FINOPS)" },
    description: { type: "string", description: "Detailed description/body" },
    priority: { type: "string", enum: ["Strategic", "High", "Medium", "Low"], description: "Priority level" },
    parent_id: { type: "number", description: "Parent proposal ID (for hierarchy)" },
    budget_limit_usd: { type: "number", description: "Budget limit in USD" },
  },
  required: ["title"],
};

const proposalUpdateSchema: JsonSchema = {
  type: "object",
  properties: {
    proposalId: { type: "string", description: "Proposal ID (e.g., P001)" },
    title: { type: "string", description: "New title" },
    body_markdown: { type: "string", description: "New body content" },
    priority: { type: "string", enum: ["Strategic", "High", "Medium", "Low"], description: "New priority" },
    maturity_level: { type: "number" as const, description: "Maturity: 0=New, 1=Active, 2=Complete, 3=Mature" },
    tags: { type: "string", description: "Comma-separated tags" },
    change_summary: { type: "string", description: "What changed (for version history)" },
  },
  required: ["proposalId", "change_summary"],
};

const proposalTransitionSchema: JsonSchema = {
  type: "object",
  properties: {
    proposalId: { type: "string", description: "Proposal ID (e.g., P001)" },
    new_status: { type: "string", enum: ["New", "Draft", "Review", "Active", "Accepted", "Complete", "Rejected"], description: "New status to transition to" },
    change_summary: { type: "string", description: "Reason for transition" },
  },
  required: ["proposalId", "new_status", "change_summary"],
};

const proposalCompleteSchema: JsonSchema = {
  type: "object",
  properties: {
    proposalId: { type: "string", description: "Proposal ID to complete" },
  },
  required: ["proposalId"],
};

const proposalAcAddSchema: JsonSchema = {
  type: "object",
  properties: {
    proposalId: { type: "string", description: "Proposal ID (e.g., P001)" },
    description: { type: "string", description: "Acceptance criteria description" },
  },
  required: ["proposalId", "description"],
};

const proposalAcCheckSchema: JsonSchema = {
  type: "object",
  properties: {
    proposalId: { type: "string", description: "Proposal ID (e.g., P001)" },
    criteriaId: { type: "number", description: "Criteria ID to mark as verified" },
  },
  required: ["proposalId", "criteriaId"],
};

const proposalAcRemoveSchema: JsonSchema = {
  type: "object",
  properties: {
    criteriaId: { type: "number", description: "Criteria ID to remove" },
  },
  required: ["criteriaId"],
};

const proposalClaimSchema: JsonSchema = {
  type: "object",
  properties: {
    proposalId: { type: "string", description: "Proposal ID (e.g., P001)" },
    agent_identity: { type: "string", description: "Agent identity claiming the proposal" },
    cost_estimate_usd: { type: "number", description: "Estimated cost in USD" },
  },
  required: ["proposalId", "agent_identity", "cost_estimate_usd"],
};

const proposalReleaseSchema: JsonSchema = {
  type: "object",
  properties: {
    proposalId: { type: "string", description: "Proposal ID (e.g., P001)" },
  },
  required: ["proposalId"],
};

export function registerSdbProposalTools(server: McpServer, projectRoot: string): void {
  const handlers = new SdbProposalHandlers(server, projectRoot);

  server.addTool(createSimpleValidatedTool(
    { name: "prop_list", description: "List proposals from SpacetimeDB", inputSchema: proposalListSchema },
    proposalListSchema,
    (input) => handlers.listProposals(input as { status?: string; assignee?: string; limit?: number }),
  ));

  server.addTool(createSimpleValidatedTool(
    { name: "prop_get", description: "Get a proposal by ID", inputSchema: proposalGetSchema },
    proposalGetSchema,
    (input) => handlers.getProposal(input as { proposalId: string }),
  ));

  server.addTool(createSimpleValidatedTool(
    { name: "prop_create", description: "Create a new proposal", inputSchema: proposalCreateSchema },
    proposalCreateSchema,
    (input) => handlers.createProposal(input as { title: string; description?: string; status?: string; assignee?: string; priority?: string; labels?: string[] }),
  ));

  server.addTool(createSimpleValidatedTool(
    { name: "prop_update", description: "Update a proposal (title, body, maturity, priority)", inputSchema: proposalUpdateSchema },
    proposalUpdateSchema,
    (input) => handlers.updateProposal(input as { proposalId: string; title?: string; body_markdown?: string; priority?: string; maturity_level?: number; tags?: string; change_summary: string }),
  ));

  server.addTool(createSimpleValidatedTool(
    { name: "prop_transition", description: "Transition proposal status (New→Draft→Review→Active→Complete)", inputSchema: proposalTransitionSchema },
    proposalTransitionSchema,
    (input) => handlers.transitionProposal(input as { proposalId: string; new_status: string; change_summary: string }),
  ));

  server.addTool(createSimpleValidatedTool(
    { name: "prop_complete", description: "Mark a proposal as complete", inputSchema: proposalCompleteSchema },
    proposalCompleteSchema,
    (input) => handlers.completeProposal(input as { proposalId: string }),
  ));

  server.addTool(createSimpleValidatedTool(
    { name: "prop_ac_add", description: "Add acceptance criteria to a proposal", inputSchema: proposalAcAddSchema },
    proposalAcAddSchema,
    (input) => handlers.addCriteria(input as { proposalId: string; description: string }),
  ));

  server.addTool(createSimpleValidatedTool(
    { name: "prop_ac_check", description: "Mark acceptance criteria as verified", inputSchema: proposalAcCheckSchema },
    proposalAcCheckSchema,
    (input) => handlers.checkCriteria(input as { proposalId: string; criteriaId: number }),
  ));

  server.addTool(createSimpleValidatedTool(
    { name: "prop_ac_remove", description: "Remove acceptance criteria", inputSchema: proposalAcRemoveSchema },
    proposalAcRemoveSchema,
    (input) => handlers.removeCriteria(input as { criteriaId: number }),
  ));

  server.addTool(createSimpleValidatedTool(
    { name: "prop_claim", description: "Claim a proposal to work on (sets status to Active)", inputSchema: proposalClaimSchema },
    proposalClaimSchema,
    (input) => handlers.claimProposal(input as { proposalId: string; agent_identity: string; cost_estimate_usd: number }),
  ));

  server.addTool(createSimpleValidatedTool(
    { name: "prop_release", description: "Release a proposal (sets status back to New)", inputSchema: proposalReleaseSchema },
    proposalReleaseSchema,
    (input) => handlers.releaseProposal(input as { proposalId: string }),
  ));

  server.addTool(createSimpleValidatedTool(
    { name: "prop_delete", description: "Delete a test proposal", inputSchema: proposalDeleteSchema },
    proposalDeleteSchema,
    (input) => handlers.deleteProposal(input as { proposalId: string }),
  ));

  console.log('[Proposals] Registered 12 SDB tools: prop_list, prop_get, prop_create, prop_update, prop_transition, prop_complete, prop_ac_add, prop_ac_check, prop_ac_remove, prop_claim, prop_release, prop_delete');
}

const proposalDeleteSchema: JsonSchema = {
  type: "object",
  properties: {
    proposalId: { type: "string", description: "Proposal ID to delete" },
  },
  required: ["proposalId"],
};
