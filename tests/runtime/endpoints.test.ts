import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	getMcpUrl,
	getDaemonUrl,
	getControlPlanePort,
	AgentHiveConfigError,
	clearEndpointCache,
} from "../../src/shared/runtime/endpoints";

describe("endpoints", () => {
	// Store original env values
	const originalMcpUrl = process.env.AGENTHIVE_MCP_URL;
	const originalDaemonUrl = process.env.AGENTHIVE_DAEMON_URL;

	beforeEach(() => {
		// Clear cache before each test
		clearEndpointCache();
		// Clear env vars before each test
		delete process.env.AGENTHIVE_MCP_URL;
		delete process.env.AGENTHIVE_DAEMON_URL;
	});

	afterEach(() => {
		// Restore original env values
		if (originalMcpUrl !== undefined) {
			process.env.AGENTHIVE_MCP_URL = originalMcpUrl;
		}
		if (originalDaemonUrl !== undefined) {
			process.env.AGENTHIVE_DAEMON_URL = originalDaemonUrl;
		}
		// Clear cache after each test
		clearEndpointCache();
	});

	describe("getMcpUrl", () => {
		it("throws AgentHiveConfigError when env is unset", () => {
			expect(() => getMcpUrl()).toThrow(AgentHiveConfigError);
			expect(() => getMcpUrl()).toThrow(
				/MCP URL not configured.*AGENTHIVE_MCP_URL/,
			);
		});

		it("returns env value when AGENTHIVE_MCP_URL is set", () => {
			const testUrl = "http://example.com:6421/sse";
			process.env.AGENTHIVE_MCP_URL = testUrl;
			clearEndpointCache();

			expect(getMcpUrl()).toBe(testUrl);
		});

		it("trims whitespace from env value", () => {
			const testUrl = "http://example.com:6421/sse";
			process.env.AGENTHIVE_MCP_URL = `  ${testUrl}  `;
			clearEndpointCache();

			expect(getMcpUrl()).toBe(testUrl);
		});

		it("caches resolved URL for subsequent calls", () => {
			process.env.AGENTHIVE_MCP_URL = "http://example.com:6421/sse";
			clearEndpointCache();

			const url1 = getMcpUrl();
			delete process.env.AGENTHIVE_MCP_URL; // Remove env var
			const url2 = getMcpUrl(); // Should still return cached value

			expect(url1).toBe(url2);
			expect(url2).toBe("http://example.com:6421/sse");
		});

		it("accepts common MCP URL formats", () => {
			const urls = [
				"http://127.0.0.1:6421/sse",
				"http://localhost:6421/sse",
				"https://mcp.example.com/sse",
				"http://192.168.1.1:6421",
			];

			urls.forEach((url) => {
				process.env.AGENTHIVE_MCP_URL = url;
				clearEndpointCache();
				expect(getMcpUrl()).toBe(url);
			});
		});
	});

	describe("getDaemonUrl", () => {
		it("throws AgentHiveConfigError when env is unset", () => {
			expect(() => getDaemonUrl()).toThrow(AgentHiveConfigError);
			expect(() => getDaemonUrl()).toThrow(
				/Daemon URL not configured.*AGENTHIVE_DAEMON_URL/,
			);
		});

		it("returns env value when AGENTHIVE_DAEMON_URL is set", () => {
			const testUrl = "http://example.com:6420";
			process.env.AGENTHIVE_DAEMON_URL = testUrl;
			clearEndpointCache();

			expect(getDaemonUrl()).toBe(testUrl);
		});

		it("trims whitespace from env value", () => {
			const testUrl = "http://example.com:6420";
			process.env.AGENTHIVE_DAEMON_URL = `  ${testUrl}  `;
			clearEndpointCache();

			expect(getDaemonUrl()).toBe(testUrl);
		});

		it("caches resolved URL for subsequent calls", () => {
			process.env.AGENTHIVE_DAEMON_URL = "http://example.com:6420";
			clearEndpointCache();

			const url1 = getDaemonUrl();
			delete process.env.AGENTHIVE_DAEMON_URL; // Remove env var
			const url2 = getDaemonUrl(); // Should still return cached value

			expect(url1).toBe(url2);
			expect(url2).toBe("http://example.com:6420");
		});
	});

	describe("getControlPlanePort", () => {
		it("extracts port from standard URL with explicit port", () => {
			process.env.AGENTHIVE_MCP_URL = "http://127.0.0.1:6421/sse";
			clearEndpointCache();

			expect(getControlPlanePort()).toBe(6421);
		});

		it("defaults to port 80 for http URLs without explicit port", () => {
			process.env.AGENTHIVE_MCP_URL = "http://example.com/sse";
			clearEndpointCache();

			expect(getControlPlanePort()).toBe(80);
		});

		it("defaults to port 443 for https URLs without explicit port", () => {
			process.env.AGENTHIVE_MCP_URL = "https://example.com/sse";
			clearEndpointCache();

			expect(getControlPlanePort()).toBe(443);
		});

		it("throws AgentHiveConfigError for invalid URL format", () => {
			process.env.AGENTHIVE_MCP_URL = "not-a-valid-url";
			clearEndpointCache();

			expect(() => getControlPlanePort()).toThrow(AgentHiveConfigError);
			expect(() => getControlPlanePort()).toThrow(/Invalid MCP URL format/);
		});

		it("throws AgentHiveConfigError when getMcpUrl throws", () => {
			// env is already unset from beforeEach
			expect(() => getControlPlanePort()).toThrow(AgentHiveConfigError);
		});
	});

	describe("clearEndpointCache", () => {
		it("clears cached values and forces re-resolution", () => {
			process.env.AGENTHIVE_MCP_URL = "http://first.example.com:6421/sse";
			clearEndpointCache();

			const url1 = getMcpUrl();
			expect(url1).toBe("http://first.example.com:6421/sse");

			// Change env and clear cache
			process.env.AGENTHIVE_MCP_URL = "http://second.example.com:6421/sse";
			clearEndpointCache();

			const url2 = getMcpUrl();
			expect(url2).toBe("http://second.example.com:6421/sse");
			expect(url1).not.toBe(url2);
		});
	});
});
