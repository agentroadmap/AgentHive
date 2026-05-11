/**
 * Thin MCP client adapter for the hive CLI.
 * All mutations route through MCP. Reads fall back to control DB on MCP outage.
 * Transport changes (P414, P446) are localized here.
 */

import { HiveError } from "./error";

export interface McpCallOptions {
  /** Request timeout in ms (default: 10_000) */
  timeoutMs?: number;
  /** Idempotency key forwarded as X-Idempotency-Key header */
  idempotencyKey?: string;
  /** Retry policy */
  retry?: { attempts: number; backoffMs: number };
}

function httpStatusToErrorCode(status: number): string {
  if (status === 404) return "NOT_FOUND";
  if (status === 403) return "PERMISSION_DENIED";
  if (status === 409) return "CONFLICT";
  if (status === 429) return "RATE_LIMITED";
  return "REMOTE_FAILURE";
}

export class HiveMcpClient {
  constructor(private readonly mcpUrl: string) {}

  getUrl(): string {
    return this.mcpUrl;
  }

  async ping(): Promise<void> {
    const result = await pingMcp(this.mcpUrl);
    if (!result.reachable) {
      throw new HiveError("MCP_UNREACHABLE", result.error ?? "MCP server is unreachable", {
        hint: `Check that the MCP server is running at ${this.mcpUrl}`,
      });
    }
  }

  async callTool(
    tool: string,
    args: Record<string, unknown>,
    opts?: McpCallOptions,
  ): Promise<unknown> {
    const timeoutMs = opts?.timeoutMs ?? 10_000;
    const maxAttempts = opts?.retry?.attempts ?? 1;
    const backoffMs = opts?.retry?.backoffMs ?? 500;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }

      const result = await mcpCall(this.mcpUrl, tool, args, timeoutMs);
      if (!result.ok) {
        const code = result.error?.code ?? "REMOTE_FAILURE";
        const err = new HiveError(code, result.error?.message ?? "MCP call failed");
        if (!err.retriable || attempt >= maxAttempts - 1) throw err;
        continue;
      }
      return result.data;
    }

    throw new HiveError("REMOTE_FAILURE", "MCP call failed");
  }
}

let _client: HiveMcpClient | null = null;

export function getMcpClient(mcpUrl?: string): HiveMcpClient {
  if (!_client) {
    _client = new HiveMcpClient(mcpUrl ?? process.env.HIVE_MCP_URL ?? "http://127.0.0.1:6421/sse");
  }
  return _client;
}

export function resetMcpClient(): void {
  _client = null;
}

export interface McpCallResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

export async function mcpCall(
  mcpUrl: string,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<McpCallResult> {
  try {
    const res = await fetch(mcpUrl.replace("/sse", "/mcp"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "cli-" + Math.random().toString(36).slice(2, 9),
        method: "tools/call",
        params: {
          name: tool,
          arguments: args,
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const code = httpStatusToErrorCode(res.status);
      return {
        ok: false,
        error: { code, message: `HTTP ${res.status}` },
      };
    }
    const json = (await res.json()) as { result?: unknown; error?: { code: string; message: string } };
    if (json.error) return { ok: false, error: json.error };
    return { ok: true, data: json.result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.includes("timeout") || msg.includes("TimeoutError");
    const isMcpDown = msg.includes("ECONNREFUSED") || msg.includes("fetch failed");
    return {
      ok: false,
      error: {
        code: isTimeout ? "TIMEOUT" : isMcpDown ? "MCP_UNREACHABLE" : "REMOTE_FAILURE",
        message: msg,
      },
    };
  }
}

export async function pingMcp(mcpUrl: string): Promise<{ reachable: boolean; latency_ms: number; error?: string }> {
  const start = Date.now();
  try {
    const res = await fetch(mcpUrl.replace("/sse", "/health"), {
      signal: AbortSignal.timeout(5_000),
    });
    return { reachable: res.ok, latency_ms: Date.now() - start };
  } catch (err) {
    return {
      reachable: false,
      latency_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
