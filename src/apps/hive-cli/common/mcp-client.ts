/**
 * MCP Client Bridge for hive CLI
 *
 * This module provides a typed client for calling the AgentHive MCP server
 * from the `hive` CLI. All mutating commands route through this client to
 * ensure audit trails (proposal_event outbox) are captured.
 *
 * Implements cli-hive-contract.md §6 (MCP-vs-Control-DB Routing Rules) and §7 (Idempotency Contract).
 *
 * @module common/mcp-client
 */

import { HiveError, Errors } from "./error.js";

/**
 * Options for MCP tool calls.
 *
 * Implements idempotency per contract §7: clients pass `idempotencyKey` through to MCP,
 * and the MCP server is responsible for dedup. The client documents this contract here.
 */
export interface McpCallOptions {
  /**
   * UUID for idempotent retries. Same key + same agency + same project = same result.
   * Per contract §7, scope is `(agency_id, project_id, idempotency_key, command_signature)`.
   * Dedup is server-side (MCP responsibility); client passes through as-is.
   */
  idempotencyKey?: string;

  /**
   * Maximum wall-clock time in milliseconds for the MCP call to complete.
   * Includes network latency and MCP server processing time.
   * Default: 30000 (30 seconds) for most operations.
   */
  timeoutMs?: number;

  /**
   * Retry behavior for transient failures (timeout, network, rate limit).
   * Per contract §6, retriable errors are REMOTE_FAILURE (5), TIMEOUT (9),
   * RATE_LIMITED (10), MCP_UNREACHABLE (12), DB_UNREACHABLE (13).
   */
  retry?: {
    /**
     * Number of retry attempts (default 3).
     * Total attempts = 1 + retries; e.g., retries=2 means up to 3 total attempts.
     */
    attempts: number;

    /**
     * Base backoff in milliseconds between retries (default 500).
     * Actual backoff = backoffMs * (2 ^ attemptNumber) for exponential backoff.
     */
    backoffMs: number;
  };
}

/**
 * Response from MCP server after a tool call.
 *
 * Per MCP protocol, tools return either:
 * - `{ content: [{ type: "text", text: "..." }] }` for success
 * - `{ content: [{ type: "text", text: "..." }], isError: true }` for MCP-level errors
 *
 * This client extracts the text content and maps MCP errors to HiveError codes.
 */
interface McpToolResponse {
  content: Array<{
    type: string;
    text?: string;
  }>;
  isError?: boolean;
}

/**
 * Mapping from MCP error signatures and HTTP status codes to HiveError codes.
 *
 * Per contract §4 (Error Code Catalog), every MCP error must map to one of the
 * stable error codes that the CLI uses for exit codes and JSON envelopes.
 *
 * This table is consulted when:
 * 1. MCP returns an HTTP error (e.g., 408 Timeout → `timeout` error code).
 * 2. MCP returns a tool result with `isError: true` (e.g., "not found" → `not-found` error code).
 * 3. MCP is unreachable (network connection refused → `remote-failure`).
 */
const MCP_ERROR_CODE_MAPPING: Record<string, string> = {
  // HTTP status codes
  "404": "NOT_FOUND", // Not Found
  "408": "TIMEOUT", // Request Timeout
  "429": "RATE_LIMITED", // Too Many Requests
  "503": "REMOTE_FAILURE", // Service Unavailable
  "504": "TIMEOUT", // Gateway Timeout
  "connection-refused": "REMOTE_FAILURE",
  "econnrefused": "REMOTE_FAILURE",
  "enotfound": "REMOTE_FAILURE",
  "etimedout": "TIMEOUT",

  // MCP error strings (case-insensitive substring matches)
  "not_found": "NOT_FOUND",
  "timeout": "TIMEOUT",
  "rate_limit": "RATE_LIMITED",
  "unreachable": "REMOTE_FAILURE",
  "unavailable": "REMOTE_FAILURE",
  "connection": "REMOTE_FAILURE",
};

/**
 * Map an MCP error (HTTP status, error message, or exception) to a stable HiveError code.
 *
 * Implements contract §4 error mapping: MCP errors → HiveError codes → exit codes.
 *
 * @param error - HTTP status code (string), error message, or Error object
 * @returns Stable error code (e.g., "TIMEOUT", "NOT_FOUND", "REMOTE_FAILURE")
 */
function mapMcpErrorToHiveCode(error: string | number | Error): string {
  const errorStr = String(error).toLowerCase();

  // Check for direct HTTP status code match
  if (typeof error === "number") {
    const mapped = MCP_ERROR_CODE_MAPPING[String(error)];
    if (mapped) return mapped;
  }

  // Check for substring matches in error message
  for (const [key, code] of Object.entries(MCP_ERROR_CODE_MAPPING)) {
    if (key.length > 3 && errorStr.includes(key)) {
      return code;
    }
  }

  // Default to REMOTE_FAILURE for any other MCP error
  return "REMOTE_FAILURE";
}

/**
 * HiveMcpClient handles all communication with the MCP server.
 *
 * Single responsibility: convert CLI tool calls → MCP JSON-RPC → HiveError on failure.
 *
 * Per contract §6, this client is used for MUTATING commands only. Read-only commands
 * may fall back to direct DB queries if MCP is unreachable.
 */
export class HiveMcpClient {
  private readonly mcpUrl: string;
  private readonly defaultTimeoutMs: number = 30000;

  /**
   * Create a new MCP client.
   *
   * @param mcpUrl - URL of the MCP server (e.g., `http://127.0.0.1:6421/mcp`)
   * @throws HiveError if the URL is invalid
   */
  constructor(mcpUrl: string) {
    if (!mcpUrl || typeof mcpUrl !== "string") {
      throw Errors.internal("MCP URL must be a non-empty string", {
        provided: String(mcpUrl),
      });
    }
    this.mcpUrl = mcpUrl;
  }

  /**
   * Call a tool on the MCP server.
   *
   * Implements contract §6 (MCP-vs-Control-DB Routing): this method is used for
   * mutations. If MCP is unreachable, the caller (in the domain handler) must refuse
   * the mutation and return error code 12 (MCP_UNREACHABLE).
   *
   * Idempotency (contract §7): `idempotencyKey` is passed through to MCP; the server
   * deduplicates requests. The client returns the MCP result as-is, including the
   * `idempotent_replay` flag in the data payload.
   *
   * @param toolName - Name of the MCP tool (e.g., `mcp_proposal`, `mcp_message`)
   * @param args - Tool arguments (e.g., `{ action: "claim", proposal_id: "P123" }`)
   * @param opts - Call options (idempotency key, timeout, retry config)
   * @returns Parsed result from MCP (tool response content)
   * @throws HiveError on MCP failure, timeout, or network error
   *
   * @example
   * ```ts
   * const client = getMcpClient();
   * const result = await client.callTool(
   *   "mcp_proposal",
   *   { action: "claim", proposal_id: "P123" },
   *   { idempotencyKey: "abc-123", timeoutMs: 10000 }
   * );
   * // result is the parsed JSON content from MCP, typically { proposal_id: "P123", lease_id: "..." }
   * ```
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    opts?: McpCallOptions
  ): Promise<unknown> {
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    const maxAttempts = (opts?.retry?.attempts ?? 3) + 1; // +1 for initial attempt
    const backoffMs = opts?.retry?.backoffMs ?? 500;

    let lastError: HiveError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.callToolOnce(toolName, args, opts, timeoutMs);
      } catch (err) {
        lastError = err instanceof HiveError ? err : this.wrapError(err);

        // Don't retry non-retriable errors
        if (!lastError.retriable) {
          throw lastError;
        }

        // Don't retry after final attempt
        if (attempt === maxAttempts) {
          throw lastError;
        }

        // Wait before retrying (exponential backoff)
        const delay = backoffMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // Should not reach here, but type-check requires it
    throw lastError || Errors.internal("MCP call failed with unknown error");
  }

  /**
   * Call a tool once (no retry logic).
   *
   * @private
   */
  private async callToolOnce(
    toolName: string,
    args: Record<string, unknown>,
    opts: McpCallOptions | undefined,
    timeoutMs: number
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Prepare the JSON-RPC request body
      const body = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: toolName,
          arguments: {
            ...args,
            // Pass idempotency key through to MCP if provided
            ...(opts?.idempotencyKey && {
              idempotency_key: opts.idempotencyKey,
            }),
          },
        },
      };

      // POST to MCP server
      const response = await fetch(this.mcpUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // Check HTTP status
      if (!response.ok) {
        const errorCode = mapMcpErrorToHiveCode(response.status);
        throw new HiveError(
          errorCode,
          `MCP server returned HTTP ${response.status}`,
          {
            status: response.status,
            url: this.mcpUrl,
          }
        );
      }

      // Parse JSON-RPC response
      const json = await response.json();

      // Check for JSON-RPC error
      if (json.error) {
        const errorCode = mapMcpErrorToHiveCode(json.error.message || "MCP error");
        throw new HiveError(errorCode, json.error.message || "MCP error", {
          detail: json.error,
        });
      }

      // Check for tool result with isError flag
      if (json.result) {
        const toolResult: McpToolResponse = json.result;
        if (toolResult.isError) {
          const message =
            toolResult.content?.[0]?.text || "MCP tool returned an error";
          const errorCode = mapMcpErrorToHiveCode(message);
          throw new HiveError(errorCode, message);
        }

        // Extract text content and try to parse as JSON
        const textContent = toolResult.content?.[0]?.text;
        if (!textContent) {
          throw Errors.internal("MCP tool returned empty content");
        }

        // Try to parse as JSON; if it fails, return as raw text
        try {
          return JSON.parse(textContent);
        } catch {
          // Not JSON; return as string
          return textContent;
        }
      }

      // No result or error; this shouldn't happen
      throw Errors.internal("MCP returned invalid response", { json });
    } catch (err) {
      // Handle AbortError (timeout)
      if (err instanceof Error && err.name === "AbortError") {
        throw new HiveError(
          "TIMEOUT",
          `MCP call timed out after ${timeoutMs}ms`,
          {
            timeout_ms: timeoutMs,
            tool: toolName,
          }
        );
      }

      // Handle network errors
      if (err instanceof TypeError) {
        const errorCode = mapMcpErrorToHiveCode(err.message);
        throw new HiveError(
          errorCode,
          `Cannot reach MCP server: ${err.message}`,
          {
            url: this.mcpUrl,
            detail: { original_error: err.message },
          }
        );
      }

      // Re-throw HiveError as-is
      if (err instanceof HiveError) {
        throw err;
      }

      // Wrap any other error
      throw this.wrapError(err);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * Wrap an unknown error as a HiveError.
   *
   * @private
   */
  private wrapError(err: unknown): HiveError {
    if (err instanceof HiveError) {
      return err;
    }

    const message = err instanceof Error ? err.message : String(err);
    const errorCode = mapMcpErrorToHiveCode(message);

    return new HiveError(errorCode, message, {
      detail: {
        original_error: String(err),
      },
    });
  }
}

/**
 * Global MCP client instance (singleton pattern).
 *
 * Lazily initialized on first call to `getMcpClient()`.
 */
let globalMcpClient: HiveMcpClient | null = null;

/**
 * Get or create the process-wide MCP client.
 *
 * The MCP URL is resolved from:
 * 1. Environment variable `AGENTHIVE_MCP_URL`
 * 2. Environment variable `HIVE_MCP_URL`
 * 3. Default: `http://127.0.0.1:6421/mcp` (local development)
 *
 * Per contract §7.2, MCP reachability uses this order:
 * - `HIVE_MCP_URL` env variable (if set)
 * - Control-plane lookup (not yet implemented; fallback to default)
 *
 * The client is reused across all CLI invocations in the same process.
 *
 * @param overrideMcpUrl - Optional override for the MCP URL (for testing)
 * @returns Singleton MCP client instance
 * @throws HiveError if the MCP URL is invalid
 */
export function getMcpClient(overrideMcpUrl?: string): HiveMcpClient {
  if (globalMcpClient && !overrideMcpUrl) {
    return globalMcpClient;
  }

  const mcpUrl =
    overrideMcpUrl ||
    process.env.AGENTHIVE_MCP_URL ||
    process.env.HIVE_MCP_URL ||
    "http://127.0.0.1:6421/mcp";

  globalMcpClient = new HiveMcpClient(mcpUrl);
  return globalMcpClient;
}

/**
 * Reset the global MCP client (for testing).
 *
 * @private
 */
export function resetMcpClient(): void {
  globalMcpClient = null;
}
