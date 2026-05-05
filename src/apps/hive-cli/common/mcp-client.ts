/**
 * Thin MCP client adapter for the hive CLI.
 * All mutations route through MCP. Reads fall back to control DB on MCP outage.
 * Transport changes (P414, P446) are localized here.
 */

export interface McpCallResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

export async function mcpCall(
  mcpUrl: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  try {
    const res = await fetch(mcpUrl.replace("/sse", "/call"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, args }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return {
        ok: false,
        error: { code: "REMOTE_FAILURE", message: `HTTP ${res.status}` },
      };
    }
    const json = (await res.json()) as { result?: unknown; error?: { code: string; message: string } };
    if (json.error) return { ok: false, error: json.error };
    return { ok: true, data: json.result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isMcpDown = msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("timeout");
    return {
      ok: false,
      error: {
        code: isMcpDown ? "MCP_UNREACHABLE" : "REMOTE_FAILURE",
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
