/**
 * System domain: service and infrastructure operations.
 *
 * Commands:
 * - hive service list [--format text|json|yaml]
 * - hive service status [SERVICE] [--format text|json|yaml]
 * - hive service logs SERVICE [--format text|jsonl]
 * - hive mcp status [--format text|json]
 * - hive mcp tools [--format text|json]
 * - hive db ping [--format text|json]
 * - hive db query --yes <SQL> [--format text|json|jsonl]
 * - hive db explain <SQL> [--format text|json]
 * - hive cubic list [--format text|json|yaml]
 * - hive cubic info CUBIC_ID [--format text|json|yaml]
 *
 * Implements cli-hive-contract.md §1 (service, mcp, db, cubic domains, read-only ops).
 */

import type { Command } from "commander";
import { execSync } from "node:child_process";
import {
  registerDomain,
  Errors,
  type DomainSchema,
  getControlPlaneClient,
  getMcpClient,
} from "../../common/index";

const DOMAIN_NAME = "system";
const DOMAIN_DESCRIPTION = "System and infrastructure operations";

const domainSchema: DomainSchema = {
  name: DOMAIN_NAME,
  aliases: ["service", "mcp", "db", "cubic"],
  description: DOMAIN_DESCRIPTION,
  subcommands: [
    {
      name: "service",
      signature: "hive system service",
      description: "Service operations (status, logs, etc.)",
      subcommands: [
        {
          name: "list",
          signature: "hive system service list",
          description: "List all managed services",
          flags: [
            {
              name: "format",
              type: "enum",
              enum: ["text", "json"],
              default: "text",
            },
          ],
          output: {
            type: "array",
            schema: {
              name: "string",
              status: "string",
              enabled: "boolean",
            },
          },
          idempotency: "idempotent",
          formats_supported: ["text", "json"],
        },
        {
          name: "status",
          signature: "hive system service status [SERVICE]",
          description: "Get service status",
          parameters: [
            {
              name: "SERVICE",
              type: "string",
              required: false,
              description: "Service name (default: all)",
            },
          ],
          flags: [
            {
              name: "format",
              type: "enum",
              enum: ["text", "json"],
              default: "text",
            },
          ],
          output: {
            type: "object",
            schema: {
              name: "string",
              status: "string",
              enabled: "boolean",
            },
          },
          idempotency: "idempotent",
          formats_supported: ["text", "json"],
        },
        {
          name: "logs",
          signature: "hive system service logs SERVICE",
          description: "Show service logs",
          parameters: [
            {
              name: "SERVICE",
              type: "string",
              required: true,
              description: "Service name",
            },
          ],
          flags: [
            {
              name: "format",
              type: "enum",
              enum: ["text", "jsonl"],
              default: "text",
            },
          ],
          output: {
            type: "string",
            schema: "Log lines",
          },
          idempotency: "idempotent",
          formats_supported: ["text", "jsonl"],
        },
      ],
    },
    {
      name: "mcp",
      signature: "hive system mcp",
      description: "MCP server diagnostics",
      subcommands: [
        {
          name: "status",
          signature: "hive system mcp status",
          description: "Check MCP server status",
          flags: [
            {
              name: "format",
              type: "enum",
              enum: ["text", "json"],
              default: "text",
            },
          ],
          output: {
            type: "object",
            schema: {
              status: "string",
              latency_ms: "number",
              url: "string",
            },
          },
          idempotency: "idempotent",
          formats_supported: ["text", "json"],
        },
        {
          name: "tools",
          signature: "hive system mcp tools",
          description: "List MCP tools",
          flags: [
            {
              name: "format",
              type: "enum",
              enum: ["text", "json", "jsonl"],
              default: "text",
            },
          ],
          output: {
            type: "array",
            schema: {
              name: "string",
              description: "string",
            },
          },
          idempotency: "idempotent",
          formats_supported: ["text", "json", "jsonl"],
        },
      ],
    },
    {
      name: "db",
      signature: "hive system db",
      description: "Database diagnostics and admin",
      subcommands: [
        {
          name: "ping",
          signature: "hive system db ping",
          description: "Check database connectivity",
          flags: [
            {
              name: "format",
              type: "enum",
              enum: ["text", "json"],
              default: "text",
            },
          ],
          output: {
            type: "object",
            schema: {
              status: "string",
              latency_ms: "number",
            },
          },
          idempotency: "idempotent",
          formats_supported: ["text", "json"],
        },
        {
          name: "query",
          signature: "hive system db query --yes <SQL>",
          description: "Run read-only SQL query (requires --yes)",
          parameters: [
            {
              name: "SQL",
              type: "string",
              required: true,
              description: "SELECT/WITH/EXPLAIN/SHOW query",
            },
          ],
          flags: [
            {
              name: "yes",
              type: "boolean",
              description: "Required to run query",
            },
            {
              name: "format",
              type: "enum",
              enum: ["text", "json", "jsonl"],
              default: "text",
            },
          ],
          output: {
            type: "array",
            schema: "Query result rows",
          },
          idempotency: "idempotent",
          formats_supported: ["text", "json", "jsonl"],
        },
        {
          name: "explain",
          signature: "hive system db explain <SQL>",
          description: "Show query execution plan",
          parameters: [
            {
              name: "SQL",
              type: "string",
              required: true,
              description: "Query to explain",
            },
          ],
          flags: [
            {
              name: "format",
              type: "enum",
              enum: ["text", "json"],
              default: "text",
            },
          ],
          output: {
            type: "string",
            schema: "EXPLAIN output",
          },
          idempotency: "idempotent",
          formats_supported: ["text", "json"],
        },
      ],
    },
    {
      name: "cubic",
      signature: "hive system cubic",
      description: "Cubic (worktree) operations",
      subcommands: [
        {
          name: "list",
          signature: "hive system cubic list",
          description: "List all cubics",
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
              cubic_id: "string",
              proposal_id: "string",
              agency_id: "string",
              status: "string",
            },
          },
          idempotency: "idempotent",
          formats_supported: ["text", "json", "jsonl", "yaml"],
        },
        {
          name: "info",
          signature: "hive system cubic info CUBIC_ID",
          description: "Get cubic details",
          parameters: [
            {
              name: "CUBIC_ID",
              type: "string",
              required: true,
              description: "Cubic ID",
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
              cubic_id: "string",
              proposal_id: "string",
              agency_id: "string",
              status: "string",
              worktree_root: "string",
            },
          },
          idempotency: "idempotent",
          formats_supported: ["text", "json", "yaml"],
        },
      ],
    },
  ],
};

// Service helpers
const MANAGED_SERVICES = [
  "agenthive-mcp",
  "agenthive-board",
  "agenthive-ws-bridge",
  "agenthive-orchestrator",
  "agenthive-a2a",
  "agenthive-copilot-agency",
  "agenthive-claude-agency",
  "agenthive-state-feed",
  "agenthive-discord-bridge",
];

async function handleServiceList(options: Record<string, unknown>) {
  return MANAGED_SERVICES.map((name) => {
    try {
      execSync(`systemctl is-active --quiet ${name}`, {
        stdio: "pipe",
      });
      return { name, status: "active", enabled: true };
    } catch {
      return { name, status: "inactive", enabled: false };
    }
  });
}

async function handleServiceStatus(
  service: string | undefined,
  options: Record<string, unknown>
) {
  if (!service) {
    // Return status for all services
    return await handleServiceList(options);
  }

  // Return status for specific service
  const fullName = service.includes("agenthive-") ? service : `agenthive-${service}`;
  try {
    execSync(`systemctl is-active --quiet ${fullName}`, { stdio: "pipe" });
    return { name: fullName, status: "active", enabled: true };
  } catch {
    return { name: fullName, status: "inactive", enabled: false };
  }
}

async function handleServiceLogs(service: string, options: Record<string, unknown>) {
  const fullName = service.includes("agenthive-") ? service : `agenthive-${service}`;
  try {
    const logs = execSync(
      `journalctl -u ${fullName} --since "1 hour ago" --no-pager`,
      { encoding: "utf-8", stdio: "pipe" }
    );
    return logs;
  } catch (err) {
    throw Errors.remoteFailure(`Failed to fetch logs for ${fullName}`, {
      service: fullName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleMcpStatus(options: Record<string, unknown>) {
  const client = getMcpClient();
  const start = Date.now();
  try {
    // Try a no-op call to check connectivity
    await client.ping();
    const latency = Date.now() - start;
    return {
      status: "ok",
      latency_ms: latency,
      url: client.getUrl(),
    };
  } catch (err) {
    throw Errors.remoteFailure(
      `MCP server is not reachable: ${err instanceof Error ? err.message : String(err)}`,
      { url: client.getUrl() }
    );
  }
}

async function handleMcpTools(options: Record<string, unknown>) {
  const client = getMcpClient();
  try {
    // TODO: Call MCP to enumerate tools
    // For now, return a stub
    return [
      { name: "TODO: enumerate MCP tools", description: "Stub implementation" },
    ];
  } catch (err) {
    throw Errors.remoteFailure(
      `Failed to enumerate MCP tools: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function handleDbPing(options: Record<string, unknown>) {
  const client = getControlPlaneClient();
  const start = Date.now();
  try {
    await client.ping();
    const latency = Date.now() - start;
    return {
      status: "ok",
      latency_ms: latency,
    };
  } catch (err) {
    throw Errors.remoteFailure(
      `Database is not reachable: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function handleDbQuery(sql: string, options: Record<string, unknown>) {
  if (!options.yes) {
    throw Errors.conflict(
      "Database query requires --yes flag for safety",
      { hint: "Run again with --yes to execute" }
    );
  }

  // Validate: only SELECT, WITH, EXPLAIN, SHOW allowed
  const normalized = sql.trim().toUpperCase();
  if (
    !normalized.startsWith("SELECT") &&
    !normalized.startsWith("WITH") &&
    !normalized.startsWith("EXPLAIN") &&
    !normalized.startsWith("SHOW")
  ) {
    throw Errors.usage(
      "Only read-only queries allowed (SELECT, WITH, EXPLAIN, SHOW)",
      `provided=${sql.substring(0, 50)}`,
    );
  }

  const client = getControlPlaneClient();
  try {
    const result = await client.query(sql);
    return result;
  } catch (err) {
    throw Errors.remoteFailure(
      `Query failed: ${err instanceof Error ? err.message : String(err)}`,
      { sql: sql.substring(0, 100) }
    );
  }
}

async function handleDbExplain(sql: string, options: Record<string, unknown>) {
  const client = getControlPlaneClient();
  try {
    const explainSql = `EXPLAIN ${sql}`;
    const result = await client.query(explainSql);
    return result.map((r) => r["QUERY PLAN"] || r).join("\n");
  } catch (err) {
    throw Errors.remoteFailure(
      `EXPLAIN failed: ${err instanceof Error ? err.message : String(err)}`,
      { sql: sql.substring(0, 100) }
    );
  }
}

async function handleCubicList(options: Record<string, unknown>) {
  const client = getControlPlaneClient();
  // TODO: Implement listCubics on ControlPlaneClient
  // Query control_runtime.cubic
  return [];
}

async function handleCubicInfo(cubicId: string, options: Record<string, unknown>) {
  // TODO: Implement getCubic on ControlPlaneClient
  throw Errors.notFound(`Cubic '${cubicId}' not found (stub)`, {
    cubic_id: cubicId,
  });
}

export function register(program: Command): void {
  registerDomain(domainSchema);

  // Create system command group
  const systemCmd = program
    .command("system")
    .description(DOMAIN_DESCRIPTION)
    .addHelpCommand(false);

  // Service subcommands
  const serviceCmd = systemCmd
    .command("service")
    .description("Service operations")
    .addHelpCommand(false);

  serviceCmd
    .command("list")
    .description("List all managed services")
    .action(async (options) => {
      const result = await handleServiceList(options);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    });

  serviceCmd
    .command("status [SERVICE]")
    .description("Get service status")
    .action(async (service: string | undefined, options) => {
      const result = await handleServiceStatus(service, options);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    });

  serviceCmd
    .command("logs <SERVICE>")
    .description("Show service logs")
    .action(async (service: string, options) => {
      const result = await handleServiceLogs(service, options);
      process.stdout.write(result);
    });

  // MCP subcommands
  const mcpCmd = systemCmd
    .command("mcp")
    .description("MCP server diagnostics")
    .addHelpCommand(false);

  mcpCmd
    .command("status")
    .description("Check MCP server status")
    .action(async (options) => {
      const result = await handleMcpStatus(options);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    });

  mcpCmd
    .command("tools")
    .description("List MCP tools")
    .action(async (options) => {
      const result = await handleMcpTools(options);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    });

  // DB subcommands
  const dbCmd = systemCmd
    .command("db")
    .description("Database diagnostics and admin")
    .addHelpCommand(false);

  dbCmd
    .command("ping")
    .description("Check database connectivity")
    .action(async (options) => {
      const result = await handleDbPing(options);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    });

  dbCmd
    .command("query <SQL>")
    .description("Run read-only SQL query")
    .action(async (sql: string, options) => {
      const result = await handleDbQuery(sql, options);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    });

  dbCmd
    .command("explain <SQL>")
    .description("Show query execution plan")
    .action(async (sql: string, options) => {
      const result = await handleDbExplain(sql, options);
      process.stdout.write(result + "\n");
    });

  // Cubic subcommands
  const cubicCmd = systemCmd
    .command("cubic")
    .description("Cubic (worktree) operations")
    .addHelpCommand(false);

  cubicCmd
    .command("list")
    .description("List all cubics")
    .action(async (options) => {
      const result = await handleCubicList(options);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    });

  cubicCmd
    .command("info <CUBIC_ID>")
    .description("Get cubic details")
    .action(async (cubicId: string, options) => {
      const result = await handleCubicInfo(cubicId, options);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    });
}
