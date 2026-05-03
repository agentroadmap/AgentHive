import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	AgentHiveConfigError,
	clearEndpointCache,
	configureEndpointResolverForTests,
	getControlPlanePort,
	getControlPlanePortAsync,
	getDaemonUrl,
	getMcpUrl,
	getMcpUrlAsync,
} from "../../src/shared/runtime/endpoints.ts";

type NotificationHandler = (message: {
	channel: string;
	payload?: string;
}) => void;

class MockListener {
	notificationHandler: NotificationHandler | null = null;
	errorHandler: ((error: Error) => void) | null = null;
	released = false;

	async query(text: string): Promise<{ rows: unknown[] }> {
		assert.equal(text, "LISTEN runtime_endpoint_changed");
		return { rows: [] };
	}

	on(
		event: string,
		handler: NotificationHandler | ((error: Error) => void),
	): void {
		if (event === "notification") {
			this.notificationHandler = handler as NotificationHandler;
		}
		if (event === "error") {
			this.errorHandler = handler as (error: Error) => void;
		}
	}

	release(): void {
		this.released = true;
	}
}

describe("endpoints", () => {
	const originalMcpUrl = process.env.AGENTHIVE_MCP_URL;
	const originalDaemonUrl = process.env.AGENTHIVE_DAEMON_URL;
	const originalLegacyMcpUrl = process.env.MCP_URL;
	const originalLegacyDaemonUrl = process.env.DAEMON_URL;

	beforeEach(() => {
		delete process.env.AGENTHIVE_MCP_URL;
		delete process.env.AGENTHIVE_DAEMON_URL;
		delete process.env.MCP_URL;
		delete process.env.DAEMON_URL;
		configureEndpointResolverForTests({
			queryFn: async () => ({ rows: [] }) as never,
			connectListener: async () => new MockListener() as never,
		});
	});

	afterEach(() => {
		if (originalMcpUrl !== undefined) {
			process.env.AGENTHIVE_MCP_URL = originalMcpUrl;
		} else {
			delete process.env.AGENTHIVE_MCP_URL;
		}
		if (originalDaemonUrl !== undefined) {
			process.env.AGENTHIVE_DAEMON_URL = originalDaemonUrl;
		} else {
			delete process.env.AGENTHIVE_DAEMON_URL;
		}
		if (originalLegacyMcpUrl !== undefined) {
			process.env.MCP_URL = originalLegacyMcpUrl;
		} else {
			delete process.env.MCP_URL;
		}
		if (originalLegacyDaemonUrl !== undefined) {
			process.env.DAEMON_URL = originalLegacyDaemonUrl;
		} else {
			delete process.env.DAEMON_URL;
		}
		configureEndpointResolverForTests();
		clearEndpointCache();
	});

	describe("getMcpUrl", () => {
		it("throws AgentHiveConfigError when env is unset", () => {
			assert.throws(() => getMcpUrl(), AgentHiveConfigError);
			assert.throws(
				() => getMcpUrl(),
				/MCP URL not configured.*AGENTHIVE_MCP_URL/,
			);
		});

		it("returns env value when AGENTHIVE_MCP_URL is set", () => {
			const testUrl = "http://example.com:6421/sse";
			process.env.AGENTHIVE_MCP_URL = testUrl;
			clearEndpointCache();

			assert.equal(getMcpUrl(), testUrl);
		});

		it("trims whitespace from env value", () => {
			const testUrl = "http://example.com:6421/sse";
			process.env.AGENTHIVE_MCP_URL = `  ${testUrl}  `;
			clearEndpointCache();

			assert.equal(getMcpUrl(), testUrl);
		});

		it("caches resolved URL for subsequent calls", () => {
			process.env.AGENTHIVE_MCP_URL = "http://example.com:6421/sse";
			clearEndpointCache();

			const url1 = getMcpUrl();
			delete process.env.AGENTHIVE_MCP_URL;
			const url2 = getMcpUrl();

			assert.equal(url1, url2);
			assert.equal(url2, "http://example.com:6421/sse");
		});
	});

	describe("getMcpUrlAsync", () => {
		it("keeps env override above DB rows", async () => {
			process.env.MCP_URL = "http://env.example.com:6421/sse";
			let queryCount = 0;
			configureEndpointResolverForTests({
				queryFn: async () => {
					queryCount += 1;
					return {
						rows: [{ endpoint_url: "http://db.example.com:6421/sse" }],
					} as never;
				},
				connectListener: async () => new MockListener() as never,
			});

			assert.equal(await getMcpUrlAsync(), "http://env.example.com:6421/sse");
			assert.equal(queryCount, 0);
		});

		it("resolves from control_runtime.service when env is unset", async () => {
			let paramsSeen: unknown[] | undefined;
			configureEndpointResolverForTests({
				queryFn: async (_text, params) => {
					paramsSeen = params;
					return {
						rows: [{ endpoint_url: "http://db.example.com:6421/sse" }],
					} as never;
				},
				connectListener: async () => new MockListener() as never,
			});

			assert.equal(await getMcpUrlAsync(), "http://db.example.com:6421/sse");
			assert.deepEqual(paramsSeen, ["mcp"]);
		});

		it("throws a clear error when neither env nor DB has an endpoint", async () => {
			await assert.rejects(
				() => getMcpUrlAsync(),
				/MCP URL not configured.*roadmap\.control_runtime_service.*service_key='mcp'/,
			);
		});

		it("clears cached DB endpoint on runtime_endpoint_changed", async () => {
			const listener = new MockListener();
			let endpoint = "http://first.example.com:6421/sse";
			configureEndpointResolverForTests({
				queryFn: async () => ({ rows: [{ endpoint_url: endpoint }] }) as never,
				connectListener: async () => listener as never,
			});

			assert.equal(await getMcpUrlAsync(), "http://first.example.com:6421/sse");
			endpoint = "http://second.example.com:6421/sse";
			assert.equal(await getMcpUrlAsync(), "http://first.example.com:6421/sse");

			listener.notificationHandler?.({ channel: "runtime_endpoint_changed" });

			assert.equal(
				await getMcpUrlAsync(),
				"http://second.example.com:6421/sse",
			);
		});
	});

	describe("getDaemonUrl", () => {
		it("throws AgentHiveConfigError when env is unset", () => {
			assert.throws(() => getDaemonUrl(), AgentHiveConfigError);
			assert.throws(
				() => getDaemonUrl(),
				/Daemon URL not configured.*AGENTHIVE_DAEMON_URL/,
			);
		});

		it("returns env value when AGENTHIVE_DAEMON_URL is set", () => {
			const testUrl = "http://example.com:6420";
			process.env.AGENTHIVE_DAEMON_URL = testUrl;
			clearEndpointCache();

			assert.equal(getDaemonUrl(), testUrl);
		});
	});

	describe("getControlPlanePort", () => {
		it("extracts port from standard URL with explicit port", () => {
			process.env.AGENTHIVE_MCP_URL = "http://127.0.0.1:6421/sse";
			clearEndpointCache();

			assert.equal(getControlPlanePort(), 6421);
		});

		it("extracts port from async DB fallback", async () => {
			configureEndpointResolverForTests({
				queryFn: async () =>
					({
						rows: [{ endpoint_url: "https://mcp.example.com/sse" }],
					}) as never,
				connectListener: async () => new MockListener() as never,
			});

			assert.equal(await getControlPlanePortAsync(), 443);
		});

		it("throws AgentHiveConfigError for invalid URL format", () => {
			process.env.AGENTHIVE_MCP_URL = "not-a-valid-url";
			clearEndpointCache();

			assert.throws(() => getControlPlanePort(), AgentHiveConfigError);
			assert.throws(() => getControlPlanePort(), /Invalid MCP URL format/);
		});
	});
});
