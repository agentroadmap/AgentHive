/**
 * Domain template for Round 3 implementers.
 *
 * Copy this file to domains/DOMAIN_NAME/index.ts and fill in:
 * 1. Domain name and description
 * 2. Subcommand functions
 * 3. Schema descriptor
 * 4. Command registration with Commander
 *
 * Pattern:
 * - Each domain exports a single `register(program)` function
 * - The function creates subcommands under a domain prefix (e.g., "hive proposal <action>")
 * - Global flags (--format, --quiet, --yes, etc.) are automatically inherited
 * - Domain modules DO NOT modify global flags or exit the process
 * - Return command results; let the framework handle output + exit codes
 */

import type { Command } from "commander";
import {
  registerDomain,
  registerRecipe,
  Errors,
  type DomainSchema,
  type Recipe,
} from "../common/index";

/**
 * Domain name (singular noun, lowercase).
 * Examples: "proposal", "workflow", "agency", "dispatch"
 */
const DOMAIN_NAME = "example";

/**
 * Domain description for help text.
 */
const DOMAIN_DESCRIPTION = "Example domain (copy this template for new domains)";

/**
 * Schema descriptor for discovery (`hive --schema`, `hive example --schema`).
 *
 * Keep this synchronized with the actual commands defined below.
 * Include all parameters, flags, and output schema per contract §8.
 */
const domainSchema: DomainSchema = {
  name: DOMAIN_NAME,
  aliases: [],
  description: DOMAIN_DESCRIPTION,
  subcommands: [
    {
      name: "list",
      signature: `hive ${DOMAIN_NAME} list`,
      description: "List all items in this domain",
      flags: [
        {
          name: "format",
          type: "enum",
          enum: ["text", "json", "jsonl", "yaml"],
          default: "text",
          description: "Output format",
        },
        {
          name: "limit",
          type: "number",
          default: 20,
          description: "Maximum items to return",
        },
        {
          name: "cursor",
          type: "string",
          description: "Pagination cursor for next page",
        },
      ],
      output: {
        type: "array",
        schema: {
          id: "string",
          title: "string",
          created_at: "string",
        },
      },
      idempotency: "idempotent",
      formats_supported: ["text", "json", "jsonl", "yaml"],
    },
    {
      name: "get",
      signature: `hive ${DOMAIN_NAME} get <id>`,
      description: "Get a single item by ID",
      parameters: [
        {
          name: "id",
          type: "string",
          required: true,
          description: "Item ID",
          example: "ex-123",
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
          title: "string",
          created_at: "string",
        },
      },
      idempotency: "idempotent",
      formats_supported: ["text", "json", "yaml"],
    },
  ],
};

/**
 * Example recipe (optional; can stub with empty array initially).
 *
 * Recipes are curated multi-step workflows shown via `hive --recipes`.
 * Include them if your domain has common patterns.
 */
const exampleRecipe: Recipe = {
  id: "example-workflow",
  title: "Example multi-step workflow",
  when_to_use: "When you need to do X, Y, then Z",
  steps: [
    {
      cmd: `hive ${DOMAIN_NAME} list --format json`,
      reads: ["items"],
      description: "List available items",
    },
    {
      cmd: `hive ${DOMAIN_NAME} get <item-id>`,
      reads: ["item-id"],
      description: "Fetch details",
    },
  ],
  terminal_state: "Item details retrieved",
};

/**
 * Command handler for "list".
 *
 * Round 3 implementers: Replace this with actual MCP/DB queries.
 * For now, stub returns mock data.
 */
async function handleList(options: Record<string, unknown>) {
  // TODO (Round 3 implementer): Call MCP or control-plane DB
  // For now, return stub data
  return {
    items: [
      { id: "ex-001", title: "Example item 1", created_at: new Date().toISOString() },
      { id: "ex-002", title: "Example item 2", created_at: new Date().toISOString() },
    ],
    next_cursor: null,
  };
}

/**
 * Command handler for "get".
 *
 * Round 3 implementers: Replace with actual lookup logic.
 */
async function handleGet(id: string, options: Record<string, unknown>) {
  if (!id) {
    throw Errors.usage(`Missing required argument: id`);
  }
  // TODO (Round 3 implementer): Fetch from MCP or DB
  return {
    id,
    title: `Item ${id}`,
    created_at: new Date().toISOString(),
  };
}

/**
 * Register this domain with the CLI program.
 *
 * Called from hive-cli/index.ts after Commander setup.
 * This is where subcommands are wired up.
 */
export function register(program: Command): void {
  // Register domain schema for discovery
  registerDomain(domainSchema);
  registerRecipe(exampleRecipe);

  // Create domain subcommand group
  const domainCmd = program
    .command(DOMAIN_NAME)
    .description(DOMAIN_DESCRIPTION)
    .addHelpCommand(false); // Disable auto --help; we provide custom help

  // Add "list" subcommand
  domainCmd
    .command("list")
    .description("List all items")
    .option("-l, --limit <number>", "Maximum items (default: 20)", "20")
    .option("-c, --cursor <token>", "Pagination cursor")
    .action(async (options) => {
      try {
        const result = await handleList(options);
        // Output is handled by framework; just return
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } catch (err) {
        if (err instanceof Error) {
          process.stderr.write(`Error: ${err.message}\n`);
          process.exit(1);
        }
        throw err;
      }
    });

  // Add "get" subcommand
  domainCmd
    .command("get <id>")
    .description("Get a single item")
    .action(async (id: string, options) => {
      try {
        const result = await handleGet(id, options);
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } catch (err) {
        if (err instanceof Error) {
          process.stderr.write(`Error: ${err.message}\n`);
          process.exit(1);
        }
        throw err;
      }
    });
}
