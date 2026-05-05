/**
 * Worker domain: agent registry and lifecycle.
 *
 * Per contract §1, "worker" maps to agent_registry (roadmap_workforce.agent_registry).
 *
 * Commands:
 * - hive worker list [--format text|json|yaml]
 * - hive worker info WORKER_ID [--format text|json|yaml]
 *
 * Implements cli-hive-contract.md §1 (worker domain, read-only).
 */

import type { Command } from "commander";
import {
  registerDomain,
  Errors,
  type DomainSchema,
  getControlPlaneClient,
  resolveContext,
} from "../../common/index";

const DOMAIN_NAME = "worker";
const DOMAIN_DESCRIPTION = "Agent registry and workforce management";

const domainSchema: DomainSchema = {
  name: DOMAIN_NAME,
  aliases: ["agent"],
  description: DOMAIN_DESCRIPTION,
  subcommands: [
    {
      name: "list",
      signature: "hive worker list",
      description: "List all agents in current project",
      flags: [
        {
          name: "format",
          type: "enum",
          enum: ["text", "json", "jsonl", "yaml"],
          default: "text",
        },
      ],
      output: {
        type: "array",
        schema: {
          id: "string",
          agent_identity: "string",
          role: "string",
          status: "string",
          created_at: "string",
        },
      },
      idempotency: "idempotent",
      formats_supported: ["text", "json", "jsonl", "yaml"],
    },
    {
      name: "info",
      signature: "hive worker info WORKER_ID",
      description: "Get agent info",
      parameters: [
        {
          name: "WORKER_ID",
          type: "string",
          required: true,
          description: "Agent ID",
        },
      ],
      flags: [
        {
          name: "format",
          type: "enum",
          enum: ["text", "json", "yaml"],
          default: "text",
        },
      ],
      output: {
        type: "object",
        schema: {
          id: "string",
          agent_identity: "string",
          role: "string",
          skills: ["string"],
          status: "string",
          created_at: "string",
        },
      },
      idempotency: "idempotent",
      formats_supported: ["text", "json", "yaml"],
    },
  ],
};

async function handleList(options: Record<string, unknown>) {
  const client = getControlPlaneClient();
  const ctx = await resolveContext(options as { project?: string; agency?: string });

  if (!ctx.project) {
    throw Errors.notFound(
      "Cannot resolve project context for worker list.",
      { hint: "Set --project flag or HIVE_PROJECT environment variable" }
    );
  }

  const projectRow = await client.getProject(ctx.project);
  if (!projectRow) {
    throw Errors.notFound(`Project '${ctx.project}' not found.`);
  }

  return client.listAgents(projectRow.project_id);
}

async function handleInfo(workerId: string, options: Record<string, unknown>) {
  const client = getControlPlaneClient();
  const ctx = await resolveContext(options as { project?: string; agency?: string });

  if (!ctx.project) {
    throw Errors.notFound(
      "Cannot resolve project context for worker info.",
      { hint: "Set --project flag or HIVE_PROJECT environment variable" }
    );
  }

  const projectRow = await client.getProject(ctx.project);
  if (!projectRow) {
    throw Errors.notFound(`Project '${ctx.project}' not found.`);
  }

  const agents = await client.listAgents(projectRow.project_id);
  const agent = agents.find((a) => a.id === workerId);

  if (!agent) {
    throw Errors.notFound(`Agent '${workerId}' not found in project`, {
      agent_id: workerId,
      project_slug: ctx.project,
    });
  }

  return agent;
}

export function register(program: Command): void {
  registerDomain(domainSchema);

  const domainCmd = program
    .command(DOMAIN_NAME)
    .description(DOMAIN_DESCRIPTION)
    .addHelpCommand(false);

  domainCmd
    .command("list")
    .description("List all agents in project")
    .action(async (options) => {
      const result = await handleList(options);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    });

  domainCmd
    .command("info <WORKER_ID>")
    .description("Get agent info")
    .action(async (workerId: string, options) => {
      const result = await handleInfo(workerId, options);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    });
}
