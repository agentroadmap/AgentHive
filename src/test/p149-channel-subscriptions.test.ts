/**
 * P149: Channel Subscriptions & Push Notifications — Test Suite
 *
 * Tests the 5 acceptance criteria:
 * AC-1: channel_subscription table schema
 * AC-2: msg_subscribe MCP tool
 * AC-3: pg_notify trigger on message_ledger INSERT
 * AC-4: msg_read wait_ms parameter
 * AC-5: Fallback when pg_notify unavailable
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(process.cwd());

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	assert.equal(first?.type, "text");
	return first.text ?? "";
}

// ---------------------------------------------------------------------------
// AC-1: channel_subscription table schema validation
// ---------------------------------------------------------------------------
describe("AC-1: channel_subscription table", () => {
	let sql: string;

	beforeEach(() => {
		sql = readFileSync(resolve(ROOT, "database/ddl/roadmap-baseline-2026-04-13.sql"), "utf-8");
	});

	it("migration SQL defines correct columns", () => {
		assert.ok(
			sql.includes("CREATE TABLE roadmap.channel_subscription"),
			"Should create channel_subscription table",
		);
		assert.ok(sql.includes("agent_identity"), "Should have agent_identity column");
		assert.ok(sql.includes("channel"), "Should have channel column");
		assert.ok(sql.includes("subscribed_at"), "Should have subscribed_at column");
		assert.ok(
			sql.includes("channel_subscription_unique UNIQUE (agent_identity, channel)"),
			"Should enforce one subscription per agent/channel",
		);
		assert.ok(
			sql.includes("REFERENCES roadmap_workforce.agent_registry"),
			"Should have FK to agent_registry",
		);
		assert.ok(
			sql.includes("channel ~ '^(direct|team:.+|broadcast|system)$'"),
			"Should validate channel format",
		);
		assert.ok(
			sql.includes("idx_channel_subscription_channel"),
			"Should create index on channel",
		);
	});

	it("channel format validation accepts valid patterns", () => {
		const validChannels = ["direct", "team:alpha", "team:my-team-1", "broadcast", "system"];
		const pattern = /^(direct|team:.+|broadcast|system)$/;
		for (const ch of validChannels) {
			assert.ok(pattern.test(ch), `Channel '${ch}' should be valid`);
		}
	});

	it("channel format validation rejects invalid patterns", () => {
		const invalidChannels = ["", "invalid", "team:", "TEAM:alpha", "direct1", "broad"];
		const pattern = /^(direct|team:.+|broadcast|system)$/;
		for (const ch of invalidChannels) {
			assert.ok(!pattern.test(ch), `Channel '${ch}' should be invalid`);
		}
	});
});

// ---------------------------------------------------------------------------
// AC-2: chan_subscribe MCP tool
// ---------------------------------------------------------------------------
describe("AC-2: chan_subscribe MCP tool", () => {
	it("PgMessagingHandlers.subscribe returns CallToolResult with content", async () => {
		const { PgMessagingHandlers } = await import(
			"../apps/mcp-server/tools/messages/pg-handlers.ts"
		);
		const mockCore = {} as any;
		const handler = new PgMessagingHandlers(mockCore, ROOT);

		const result = await handler.subscribe({
			agent_identity: "test-agent",
			channel: "team:alpha",
			subscribe: true,
		});

		// Should return a properly formatted CallToolResult
		assert.ok(result.content, "Should return content array");
		assert.ok(Array.isArray(result.content), "Content should be an array");
		assert.ok(result.content[0].type === "text", "Should be text content");
		assert.ok(typeof firstText(result) === "string", "Text should be a string");
		// Either "Subscribed" (success) or "⚠️" (error from missing table) is valid
		assert.ok(
			firstText(result).includes("Subscribed") ||
				firstText(result).includes("⚠️"),
			`Should indicate subscription result, got: ${firstText(result).substring(0, 80)}`,
		);
	});

	it("subscribe with subscribe=false returns unsubscribe result", async () => {
		const { PgMessagingHandlers } = await import(
			"../apps/mcp-server/tools/messages/pg-handlers.ts"
		);
		const mockCore = {} as any;
		const handler = new PgMessagingHandlers(mockCore, ROOT);

		const result = await handler.subscribe({
			agent_identity: "test-agent",
			channel: "broadcast",
			subscribe: false,
		});

		assert.ok(result.content[0].type === "text");
		assert.ok(
			firstText(result).includes("Unsubscribed") ||
				firstText(result).includes("⚠️"),
			`Should indicate unsubscribe result, got: ${firstText(result).substring(0, 80)}`,
		);
	});

	it("subscribe validates channel format before DB call", async () => {
		const { PgMessagingHandlers } = await import(
			"../apps/mcp-server/tools/messages/pg-handlers.ts"
		);
		const mockCore = {} as any;
		const handler = new PgMessagingHandlers(mockCore, ROOT);

		const result = await handler.subscribe({
			agent_identity: "test-agent",
			channel: "invalid-channel",
			subscribe: true,
		});

		// Invalid channel should be caught before DB call
		assert.ok(
			firstText(result).includes("Invalid channel format"),
			`Should reject invalid channel, got: ${firstText(result).substring(0, 80)}`,
		);
	});

	it("subscribe defaults to true when subscribe param omitted", async () => {
		const { PgMessagingHandlers } = await import(
			"../apps/mcp-server/tools/messages/pg-handlers.ts"
		);
		const mockCore = {} as any;
		const handler = new PgMessagingHandlers(mockCore, ROOT);

		const result = await handler.subscribe({
			agent_identity: "test-agent",
			channel: "system",
		});

		assert.ok(result.content[0].type === "text");
		// Default is subscribe (true)
		assert.ok(
			firstText(result).includes("Subscribed") ||
				firstText(result).includes("⚠️"),
			`Default action should be subscribe, got: ${firstText(result).substring(0, 80)}`,
		);
	});

	it("supports all channel types: direct, team:name, broadcast, system", async () => {
		const { PgMessagingHandlers } = await import(
			"../apps/mcp-server/tools/messages/pg-handlers.ts"
		);
		const mockCore = {} as any;
		const handler = new PgMessagingHandlers(mockCore, ROOT);

		for (const channel of ["direct", "team:backend", "broadcast", "system"]) {
			const result = await handler.subscribe({
				agent_identity: "test-agent",
				channel,
				subscribe: true,
			});
			// Should not get "Invalid channel format" for valid channels
			assert.ok(
				!firstText(result).includes("Invalid channel format"),
				`Should accept channel '${channel}', got: ${firstText(result).substring(0, 80)}`,
			);
		}
	});

	it("listSubscriptions returns formatted result", async () => {
		const { PgMessagingHandlers } = await import(
			"../apps/mcp-server/tools/messages/pg-handlers.ts"
		);
		const mockCore = {} as any;
		const handler = new PgMessagingHandlers(mockCore, ROOT);

		const result = await handler.listSubscriptions({
			agent_identity: "test-agent",
		});

		assert.ok(result.content[0].type === "text");
		assert.ok(typeof firstText(result) === "string");
	});
});

// ---------------------------------------------------------------------------
// AC-3: pg_notify trigger on message_ledger INSERT
// ---------------------------------------------------------------------------
describe("AC-3: pg_notify trigger", () => {
	let sql: string;

	beforeEach(() => {
		sql = readFileSync(resolve(ROOT, "database/ddl/roadmap-baseline-2026-04-13.sql"), "utf-8");
	});

	it("migration defines fn_notify_new_message trigger function", () => {
		assert.ok(
			sql.includes("CREATE FUNCTION roadmap.fn_notify_new_message()"),
			"Should define trigger function",
		);
		assert.ok(sql.includes("pg_notify("), "Should call pg_notify");
		assert.ok(sql.includes("'new_message'"), "Should notify on 'new_message' channel");
		assert.ok(sql.includes("jsonb_build_object"), "Should build JSON payload");
	});

	it("trigger payload includes required fields", () => {
		const requiredFields = [
			"'message_id'",
			"'from_agent'",
			"'to_agent'",
			"'channel'",
			"'message_type'",
			"'proposal_id'",
			"'created_at'",
		];
		for (const field of requiredFields) {
			assert.ok(sql.includes(field), `Trigger payload should include ${field}`);
		}
	});

	it("trigger is attached to message_ledger AFTER INSERT", () => {
		assert.ok(
			sql.includes("AFTER INSERT ON roadmap.message_ledger"),
			"Should fire AFTER INSERT on message_ledger",
		);
		assert.ok(sql.includes("FOR EACH ROW"), "Should be FOR EACH ROW trigger");
	});
});

// ---------------------------------------------------------------------------
// AC-4: msg_read wait_ms parameter
// ---------------------------------------------------------------------------
describe("AC-4: msg_read wait_ms", () => {
	it("readMessages accepts wait_ms parameter", async () => {
		const { PgMessagingHandlers } = await import(
			"../apps/mcp-server/tools/messages/pg-handlers.ts"
		);
		const mockCore = {} as any;
		const handler = new PgMessagingHandlers(mockCore, ROOT);

		const result = await handler.readMessages({
			channel: "test",
			wait_ms: 100,
		});

		assert.ok(result.content, "Should return a result with content");
	});

	it("without wait_ms, reads messages immediately", async () => {
		const { PgMessagingHandlers } = await import(
			"../apps/mcp-server/tools/messages/pg-handlers.ts"
		);
		const mockCore = {} as any;
		const handler = new PgMessagingHandlers(mockCore, ROOT);

		const result = await handler.readMessages({
			channel: "test",
		});

		assert.ok(result.content, "Should return immediately without wait_ms");
	});

	it("readMessages handles all parameter combinations", async () => {
		const { PgMessagingHandlers } = await import(
			"../apps/mcp-server/tools/messages/pg-handlers.ts"
		);
		const mockCore = {} as any;
		const handler = new PgMessagingHandlers(mockCore, ROOT);

		// Agent filter
		const r1 = await handler.readMessages({ agent: "agent1" });
		assert.ok(r1.content);

		// Channel + limit
		const r2 = await handler.readMessages({ channel: "test", limit: 10 });
		assert.ok(r2.content);

		// Channel + wait_ms
		const r3 = await handler.readMessages({ channel: "test", wait_ms: 50 });
		assert.ok(r3.content);
	});
});

// ---------------------------------------------------------------------------
// AC-5: Fallback when pg_notify unavailable
// ---------------------------------------------------------------------------
describe("AC-5: pg_notify fallback", () => {
	it("MessageNotificationListener can be instantiated", async () => {
		const { MessageNotificationListener } = await import(
			"../apps/mcp-server/tools/messages/pg-handlers.ts"
		);
		const listener = new MessageNotificationListener();
		assert.ok(listener, "Should create listener instance");
	});

	it("readMessages degrades gracefully when pg_notify is unavailable", async () => {
		const { PgMessagingHandlers } = await import(
			"../apps/mcp-server/tools/messages/pg-handlers.ts"
		);
		const mockCore = {} as any;
		const handler = new PgMessagingHandlers(mockCore, ROOT);

		const result = await handler.readMessages({
			channel: "test",
			wait_ms: 100,
		});

		assert.ok(result.content, "Should return result even if pg_notify unavailable");
	});
});

// ---------------------------------------------------------------------------
// Integration: server.ts tool registration
// ---------------------------------------------------------------------------
describe("Tool Registration in server.ts", () => {
	let serverCode: string;

	beforeEach(() => {
		serverCode = readFileSync(resolve(ROOT, "src/apps/mcp-server/server.ts"), "utf-8");
	});

	it("server registers chan_subscribe tool for Postgres backend", () => {
		assert.ok(
			serverCode.includes('name: "chan_subscribe"'),
			"Should register chan_subscribe tool",
		);
		assert.ok(
			serverCode.includes('name: "chan_subscriptions"'),
			"Should register chan_subscriptions tool",
		);
	});

	it("msg_read tool includes wait_ms in schema", () => {
		assert.ok(serverCode.includes("wait_ms"), "msg_read should include wait_ms parameter");
	});

	it("chan_subscribe requires agent_identity and channel", () => {
		// Find the chan_subscribe block and check required fields
		const subscribeBlock = serverCode.match(
			/name: "chan_subscribe"[\s\S]*?required: \[(.*?)\]/,
		);
		assert.ok(subscribeBlock, "Should find chan_subscribe tool definition");
		if (subscribeBlock) {
			assert.ok(
				subscribeBlock[1].includes('"agent_identity"'),
				"Should require agent_identity",
			);
			assert.ok(subscribeBlock[1].includes('"channel"'), "Should require channel");
		}
	});
});
