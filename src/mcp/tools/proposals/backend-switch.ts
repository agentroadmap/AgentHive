/**
 * AgentHive MCP Server Bootstrap
 *
 * Chooses between SpacetimeDB and Postgres storage backends based on config.yaml.
 * This allows gradual migration from SDB → Postgres without breaking existing flows.
 */
import type { McpServer } from "../server.ts";
import { PgProposalHandlers } from "./pg-handlers.ts";
import { SdbProposalHandlers } from "./sdb-handlers.ts";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig(projectRoot: string): Record<string, any> | null {
  const cfgPath = resolve(projectRoot, "config.yaml");
  try {
    const raw = readFileSync(cfgPath, "utf-8");
    return yaml.load(raw) as Record<string, any>;
  } catch {
    return null;
  }
}

/**
 * Register proposal tools using the configured storage backend.
 * Postgres is preferred when `database.provider = Postgres` and the
 * connection pool can be initialized.
 */
export function registerProposalTools(
  server: McpServer,
  projectRoot: string,
): void {
  const config = loadConfig(projectRoot);
  const usePostgres = config?.database?.provider === "Postgres";

  if (usePostgres) {
    const handlers = new PgProposalHandlers(server, projectRoot);
    server.addTool({
      name: "prop_list",
      description: "List proposals from AgentHive Postgres database",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter by status" },
          type: { type: "string", description: "Filter by proposal type" },
          domain_id: { type: "string", description: "Filter by domain" },
          maturity_min: { type: "number", description: "Minimum maturity level" },
        },
      },
      handler: (args: any) => handlers.listProposals(args),
    });
    server.addTool({
      name: "prop_get",
      description: "Get a proposal by ID",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      handler: (args: any) => handlers.getProposal(args),
    });
    server.addTool({
      name: "prop_create",
      description: "Create a new proposal",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          proposal_type: { type: "string" },
          category: { type: "string" },
          domain_id: { type: "string" },
          display_id: { type: "string" },
          body_markdown: { type: "string" },
          status: { type: "string" },
          tags: { type: "string", description: "JSON string" },
        },
        required: ["title", "proposal_type"],
      },
      handler: (args: any) => handlers.createProposal(args),
    });
    server.addTool({
      name: "prop_update",
      description: "Update an existing proposal",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          status: { type: "string" },
          category: { type: "string" },
          body_markdown: { type: "string" },
          tags: { type: "string", description: "JSON string" },
        },
        required: ["id"],
      },
      handler: (args: any) => handlers.updateProposal(args),
    });
    server.addTool({
      name: "prop_transition",
      description: "Transition proposal to a new status",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string" },
          author: { type: "string" },
          summary: { type: "string" },
        },
        required: ["id", "status"],
      },
      handler: (args: any) => handlers.transitionProposal(args),
    });
    server.addTool({
      name: "prop_delete",
      description: "Delete a proposal",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      handler: (args: any) => handlers.deleteProposal(args),
    });

    // eslint-disable-next-line no-console
    console.log("[MCP] Using Postgres proposal handlers (AgentHive)");
  } else {
    // Fallback to SDB for backward compatibility
    const handlers = new SdbProposalHandlers(server, projectRoot);
    server.addTool({
      name: "prop_list",
      description: "List proposals from SpacetimeDB",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string" },
        },
      },
      handler: (args: any) => handlers.listProposals(args),
    });
    server.addTool({
      name: "prop_get",
      description: "Get a proposal",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      handler: (args: any) => handlers.getProposal(args),
    });

    // eslint-disable-next-line no-console
    console.log("[MCP] Using SDB proposal handlers (fallback)");
  }
}
