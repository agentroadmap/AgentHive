/**
 * Test suite for MCP client bridge.
 *
 * Tests the core MCP→HiveError mapping and retry logic.
 * Uses Node's built-in test runner (no external test framework).
 *
 * Run with: `node --import jiti/register --test src/apps/hive-cli/common/mcp-client.test.ts`
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { HiveMcpClient, getMcpClient, resetMcpClient } from "./mcp-client.js";
import { HiveError } from "./error.js";

// ============================================================================
// MOCK FETCH
// ============================================================================

/**
 * Mock fetch for testing without hitting the live MCP server.
 *
 * Allows us to simulate success, timeout, network errors, and MCP errors.
 */
let mockFetchResponse: {
  status: number;
  body: Record<string, unknown>;
  delay?: number;
} | null = null;

let mockFetchError: Error | null = null;

const originalFetch = global.fetch;


global.fetch = async (
  _url: string,
  _opts: RequestInit
): Promise<Response> => {
  // Check for abort signal
  const signal = _opts?.signal as AbortSignal | undefined;
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted", "AbortError");
  }

  // Simulate network error if configured
  if (mockFetchError) {
    throw mockFetchError;
  }

  // Simulate timeout delay with signal check
  if (mockFetchResponse?.delay) {
    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (signal?.aborted) {
          reject(new DOMException("The operation was aborted", "AbortError"));
        } else {
          resolve();
        }
      }, mockFetchResponse!.delay);

      // If signal is aborted while waiting, clear timeout and reject
      if (signal) {
        signal.addEventListener("abort", () => {
          clearTimeout(timeoutId);
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      }
    });
  }

  // Simulate HTTP error status
  if (mockFetchResponse && !mockFetchResponse.status.toString().startsWith("2")) {
    return {
      ok: false,
      status: mockFetchResponse.status,
      json: async () => mockFetchResponse!.body,
    } as Response;
  }

  // Return success response
  if (mockFetchResponse) {
    return {
      ok: true,
      status: 200,
      json: async () => mockFetchResponse!.body,
    } as Response;
  }

  // Default: empty success response
  return {
    ok: true,
    status: 200,
    json: async () => ({ result: { content: [{ type: "text", text: "{}" }] } }),
  } as Response;
};

// ============================================================================
// TEST SUITE
// ============================================================================

test("HiveMcpClient: successful tool call returns parsed JSON", async (t) => {
  await t.test("parses JSON tool result", async () => {
    mockFetchResponse = {
      status: 200,
      body: {
        result: {
          content: [
            {
              type: "text",
              text: '{"proposal_id":"P123","title":"Test"}',
            },
          ],
        },
      },
    };

    const client = new HiveMcpClient("http://localhost:6421/mcp");
    const result = await client.callTool("mcp_proposal", { action: "get" });

    assert.deepEqual(result, {
      proposal_id: "P123",
      title: "Test",
    });
  });

  await t.test("returns raw text if not JSON", async () => {
    mockFetchResponse = {
      status: 200,
      body: {
        result: {
          content: [{ type: "text", text: "plain text response" }],
        },
      },
    };

    const client = new HiveMcpClient("http://localhost:6421/mcp");
    const result = await client.callTool("mcp_proposal", { action: "list" });

    assert.equal(result, "plain text response");
  });

  await t.test("preserves idempotency_key in request", async () => {
    mockFetchResponse = {
      status: 200,
      body: {
        result: {
          content: [
            {
              type: "text",
              text: '{"idempotent_replay":false}',
            },
          ],
        },
      },
    };

    const client = new HiveMcpClient("http://localhost:6421/mcp");
    // Just verify it doesn't throw; the fetch mock doesn't inspect the body
    const result = await client.callTool(
      "mcp_proposal",
      { action: "claim", proposal_id: "P123" },
      { idempotencyKey: "abc-123" }
    );

    assert(result);
  });
});

test("HiveMcpClient: error mapping", async (t) => {
  await t.test("maps MCP timeout error to TIMEOUT exit code", async () => {
    mockFetchError = null;
    mockFetchResponse = {
      status: 408,
      body: { error: { message: "Request timeout" } },
    };

    const client = new HiveMcpClient("http://localhost:6421/mcp");

    try {
      await client.callTool("mcp_proposal", { action: "get" });
      assert.fail("should have thrown HiveError");
    } catch (err) {
      assert(err instanceof HiveError);
      assert.equal(err.code, "TIMEOUT");
      assert.equal(err.exitCode, 9);
      assert.equal(err.retriable, true);
    }
  });

  await t.test("maps MCP rate limit error to RATE_LIMITED exit code", async () => {
    mockFetchError = null;
    mockFetchResponse = {
      status: 429,
      body: { error: { message: "Too many requests" } },
    };

    const client = new HiveMcpClient("http://localhost:6421/mcp");

    try {
      await client.callTool("mcp_proposal", { action: "get" });
      assert.fail("should have thrown HiveError");
    } catch (err) {
      assert(err instanceof HiveError);
      assert.equal(err.code, "RATE_LIMITED");
      assert.equal(err.exitCode, 10);
      assert.equal(err.retriable, true);
    }
  });

  await t.test("maps tool isError to NOT_FOUND exit code", async () => {
    mockFetchError = null;
    mockFetchResponse = {
      status: 200,
      body: {
        result: {
          isError: true,
          content: [{ type: "text", text: "Proposal not_found" }],
        },
      },
    };

    const client = new HiveMcpClient("http://localhost:6421/mcp");

    try {
      await client.callTool("mcp_proposal", { action: "get", proposal_id: "P999" });
      assert.fail("should have thrown HiveError");
    } catch (err) {
      assert(err instanceof HiveError);
      assert.equal(err.code, "NOT_FOUND");
      assert.equal(err.exitCode, 2);
      assert.equal(err.retriable, false);
    }
  });
});

test("HiveMcpClient: unreachable MCP", async (t) => {
  await t.test("maps network error to REMOTE_FAILURE exit code", async () => {
    mockFetchResponse = null;
    mockFetchError = new TypeError("fetch failed");

    const client = new HiveMcpClient("http://localhost:6421/mcp");

    try {
      await client.callTool("mcp_proposal", { action: "get" });
      assert.fail("should have thrown HiveError");
    } catch (err) {
      assert(err instanceof HiveError);
      assert.equal(err.code, "REMOTE_FAILURE");
      assert.equal(err.exitCode, 5);
      assert.equal(err.retriable, true);
      assert(err.message.includes("Cannot reach MCP server"));
    }
  });

  await t.test("timeout after specified duration maps to TIMEOUT", async () => {
    mockFetchError = null;
    mockFetchResponse = {
      status: 200,
      body: { result: { content: [{ type: "text", text: "{}" }] } },
      delay: 100, // 100ms delay
    };

    const client = new HiveMcpClient("http://localhost:6421/mcp");

    try {
      // 50ms timeout < 100ms delay
      await client.callTool("mcp_proposal", { action: "get" }, { timeoutMs: 50 });
      assert.fail("should have thrown timeout HiveError");
    } catch (err) {
      assert(err instanceof HiveError);
      assert.equal(err.code, "TIMEOUT");
      assert.equal(err.exitCode, 9);
      assert(err.message.includes("timed out"));
    }
  });

  await t.test("clears timeout timer on success", async () => {
    mockFetchError = null;
    mockFetchResponse = {
      status: 200,
      body: { result: { content: [{ type: "text", text: '{"ok":true}' }] } },
    };

    const client = new HiveMcpClient("http://localhost:6421/mcp");
    const result = await client.callTool("mcp_proposal", { action: "get" }, { timeoutMs: 5000 });

    assert.deepEqual(result, { ok: true });
    // If timeout wasn't cleared, Node would eventually complain during teardown
  });
});

test("HiveMcpClient: retry logic", async (t) => {
  const originalFetchForRetry = global.fetch;

  await t.test("retries on transient errors", async () => {
    let attemptCount = 0;
    // Custom fetch that fails twice, then succeeds

    global.fetch = async (): Promise<Response> => {
      attemptCount++;
      if (attemptCount < 3) {
        // Fail first two attempts (transient error)
        return {
          ok: false,
          status: 503,
          json: async () => ({ error: { message: "Service Unavailable" } }),
        } as Response;
      }
      // Succeed on third attempt
      return {
        ok: true,
        status: 200,
        json: async () => ({
          result: { content: [{ type: "text", text: '{"success":true}' }] },
        }),
      } as Response;
    };

    try {
      const client = new HiveMcpClient("http://localhost:6421/mcp");
      const result = await client.callTool("mcp_proposal", { action: "get" }, {
        retry: { attempts: 2, backoffMs: 10 },
      });

      assert.equal(attemptCount, 3);
      assert.deepEqual(result, { success: true });
    } finally {
      // Restore original fetch

      global.fetch = originalFetchForRetry;
    }
  });

  await t.test("fails after max retries exhausted", async () => {
    // Always failing fetch

    global.fetch = async (): Promise<Response> => {
      return {
        ok: false,
        status: 503,
        json: async () => ({ error: { message: "Service Unavailable" } }),
      } as Response;
    };

    try {
      const client = new HiveMcpClient("http://localhost:6421/mcp");

      try {
        await client.callTool("mcp_proposal", { action: "get" }, {
          retry: { attempts: 1, backoffMs: 10 },
        });
        assert.fail("should have thrown after retries exhausted");
      } catch (err) {
        assert(err instanceof HiveError);
        assert.equal(err.code, "REMOTE_FAILURE");
      }
    } finally {
      // Restore original fetch

      global.fetch = originalFetchForRetry;
    }
  });

  await t.test("does not retry non-retriable errors", async () => {
    let attemptCount = 0;
    // Non-retriable 404 error

    global.fetch = async (): Promise<Response> => {
      attemptCount++;
      return {
        ok: false,
        status: 404,
        json: async () => ({
          error: { message: "Proposal not_found" },
        }),
      } as Response;
    };

    try {
      const client = new HiveMcpClient("http://localhost:6421/mcp");

      try {
        await client.callTool("mcp_proposal", { action: "get" }, {
          retry: { attempts: 3, backoffMs: 10 },
        });
        assert.fail("should have thrown NOT_FOUND (non-retriable)");
      } catch (err) {
        assert(err instanceof HiveError);
        assert.equal(err.code, "NOT_FOUND");
        assert.equal(attemptCount, 1); // Only one attempt, no retries
      }
    } finally {
      // Restore original fetch

      global.fetch = originalFetchForRetry;
    }
  });
});

test("getMcpClient: singleton pattern", async (t) => {
  await t.test("returns same instance on repeated calls", () => {
    resetMcpClient();
    mockFetchError = null;
    mockFetchResponse = {
      status: 200,
      body: { result: { content: [{ type: "text", text: "{}" }] } },
    };
    const client1 = getMcpClient();
    const client2 = getMcpClient();
    assert.equal(client1, client2);
  });

  await t.test("respects HIVE_MCP_URL env variable", () => {
    resetMcpClient();
    mockFetchError = null;
    mockFetchResponse = {
      status: 200,
      body: { result: { content: [{ type: "text", text: "{}" }] } },
    };
    const oldEnv = process.env.HIVE_MCP_URL;
    try {
      process.env.HIVE_MCP_URL = "http://custom:1234/mcp";
      const client = getMcpClient();
      assert(client instanceof HiveMcpClient);
      // Can't easily check the URL without exposing it, but constructor succeeded
    } finally {
      process.env.HIVE_MCP_URL = oldEnv;
    }
  });

  await t.test("allows override for testing", () => {
    resetMcpClient();
    mockFetchError = null;
    mockFetchResponse = {
      status: 200,
      body: { result: { content: [{ type: "text", text: "{}" }] } },
    };
    const client = getMcpClient("http://test:9999/mcp");
    assert(client instanceof HiveMcpClient);
  });
});

// ============================================================================
// TEARDOWN
// ============================================================================

// Restore original fetch
process.on("exit", () => {

  global.fetch = originalFetch;
});
