import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { MCP_INIT_REQUIRED_GUIDE } from "../../src/guidelines/mcp/index.ts";
import { createMcpServer } from "../../src/mcp/server.ts";
import { expect } from "../support/test-utils.ts";

// Helper to extract text from MCP contents (handles union types)
const getContentsText = (
	contents: unknown[] | undefined,
	index = 0,
): string => {
	const item = contents?.[index] as { text?: string } | undefined;
	return item?.text ?? "";
};

describe("MCP Server Fallback Mode", () => {
	let tempDir: string;

	beforeEach(() => {
		// Create a temporary directory without roadmap initialization
		tempDir = mkdtempSync(join(tmpdir(), "mcp-fallback-test-"));
	});

	afterEach(() => {
		// Clean up temp directory
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("should start successfully in non-roadmap directory", async () => {
		// Should not throw an error
		const server = await createMcpServer(tempDir, { debug: false });

		assert.notStrictEqual(server, undefined);
		expect(server.getServer()).toBeDefined();
	});

	test("should provide roadmap://init-required resource in fallback mode", async () => {
		const server = await createMcpServer(tempDir, { debug: false });

		const resources = await server.testInterface.listResources();

		assert.strictEqual(resources.resources.length, 1);
		assert.strictEqual(resources.resources[0]?.uri, "roadmap://init-required");
		assert.strictEqual(
			resources.resources[0]?.name,
			"Roadmap.md Not Initialized",
		);
	});

	test("should be able to read roadmap://init-required resource", async () => {
		const server = await createMcpServer(tempDir, { debug: false });

		const result = await server.testInterface.readResource({
			params: { uri: "roadmap://init-required" },
		});

		assert.strictEqual(result.contents.length, 1);
		assert.strictEqual(result.contents[0]?.uri, "roadmap://init-required");
		expect(getContentsText(result.contents)).toBe(MCP_INIT_REQUIRED_GUIDE);
	});

	test("should not provide proposal tools in fallback mode", async () => {
		const server = await createMcpServer(tempDir, { debug: false });

		const tools = await server.testInterface.listTools();

		// In fallback mode, no proposal tools should be registered
		assert.strictEqual(tools.tools.length, 0);
	});
});
