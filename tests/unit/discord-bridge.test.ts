/**
 * P221: Discord Bridge — Unit Tests
 *
 * Tests for DiscordRateLimiter, MessageFormatter, HealthChecker,
 * and DiscordBridgeService structural behaviour.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DiscordRateLimiter } from "../../src/apps/discord-bridge/rate-limiter.ts";
import {
	formatMessageEmbed,
	formatNotificationEmbed,
	type AgentiveMessage,
} from "../../src/apps/discord-bridge/message-formatter.ts";
import { HealthChecker } from "../../src/apps/discord-bridge/health-check.ts";

// ---------------------------------------------------------------------------
// DiscordRateLimiter
// ---------------------------------------------------------------------------

describe("DiscordRateLimiter", () => {
	it("allows first request on a new channel", () => {
		const limiter = new DiscordRateLimiter();
		assert.equal(limiter.allow("ch-1"), true);
	});

	it("returns false when bucket is exhausted", () => {
		const limiter = new DiscordRateLimiter(3, 60_000);
		limiter.allow("ch-x");
		limiter.allow("ch-x");
		limiter.allow("ch-x");
		assert.equal(limiter.allow("ch-x"), false);
	});

	it("getRemaining returns maxTokens for an unseen channel", () => {
		const limiter = new DiscordRateLimiter(50, 1000);
		assert.equal(limiter.getRemaining("unseen"), 50);
	});

	it("size is 0 before any channel is accessed", () => {
		const limiter = new DiscordRateLimiter();
		assert.equal(limiter.size, 0);
	});

	it("size increments when a new channel is accessed", () => {
		const limiter = new DiscordRateLimiter();
		limiter.allow("a");
		limiter.allow("b");
		assert.equal(limiter.size, 2);
	});

	it("two channels are independent — exhausting one does not affect the other", () => {
		const limiter = new DiscordRateLimiter(2, 60_000);
		limiter.allow("x");
		limiter.allow("x");
		limiter.allow("x"); // exhausted
		assert.equal(limiter.allow("y"), true); // independent
	});
});

// ---------------------------------------------------------------------------
// MessageFormatter
// ---------------------------------------------------------------------------

function makeMsg(overrides: Partial<AgentiveMessage> = {}): AgentiveMessage {
	return {
		id: "42",
		channel: "broadcast",
		from_agent: "orchestrator",
		message_content: "Hello world",
		created_at: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("MessageFormatter", () => {
	it("embed description equals message_content", () => {
		const embed = formatMessageEmbed(makeMsg());
		assert.equal(embed.description, "Hello world");
	});

	it("embed color is a number", () => {
		const embed = formatMessageEmbed(makeMsg());
		assert.equal(typeof embed.color, "number");
	});

	it("escalation type gets red color (0xff0000)", () => {
		const embed = formatMessageEmbed(makeMsg({ message_type: "escalation" }));
		assert.equal(embed.color, 0xff0000);
	});

	it("null message_type gets gray color (0x808080)", () => {
		const embed = formatMessageEmbed(makeMsg({ message_type: null }));
		assert.equal(embed.color, 0x808080);
	});

	it("gate_decision type gets blue color (0x0000ff)", () => {
		const embed = formatMessageEmbed(makeMsg({ message_type: "gate_decision" }));
		assert.equal(embed.color, 0x0000ff);
	});

	it("embed title comes from msg.title when set", () => {
		const embed = formatMessageEmbed(makeMsg({ title: "My Title" }));
		assert.equal(embed.title, "My Title");
	});

	it("embed title falls back to message_type.toUpperCase() when no title", () => {
		const embed = formatMessageEmbed(makeMsg({ message_type: "status" }));
		assert.equal(embed.title, "STATUS");
	});

	it("long content is truncated with ellipsis", () => {
		const longContent = "x".repeat(5000);
		const embed = formatMessageEmbed(makeMsg({ message_content: longContent }));
		assert.ok(embed.description.endsWith("..."));
		assert.ok(embed.description.length <= 4096);
	});

	it("formatNotificationEmbed with error level uses error color", () => {
		const embed = formatNotificationEmbed("agent", "Something broke", "error");
		assert.equal(embed.color, 0xe74c3c);
	});
});

// ---------------------------------------------------------------------------
// HealthChecker
// ---------------------------------------------------------------------------

describe("HealthChecker", () => {
	it("initial status is disconnected (wsConnected defaults false)", async () => {
		const hc = new HealthChecker();
		const status = await hc.checkHealth();
		assert.equal(status.status, "disconnected");
		assert.equal(status.connected, false);
	});

	it("connected reflects setConnectionState(true)", async () => {
		const hc = new HealthChecker();
		hc.setConnectionState(true);
		const status = await hc.checkHealth();
		assert.equal(status.connected, true);
	});

	it("last_heartbeat is null before recordHeartbeat", async () => {
		const hc = new HealthChecker();
		const status = await hc.checkHealth();
		assert.equal(status.last_heartbeat, null);
	});

	it("last_heartbeat is an ISO string after recordHeartbeat", async () => {
		const hc = new HealthChecker();
		hc.recordHeartbeat();
		const status = await hc.checkHealth();
		assert.ok(status.last_heartbeat !== null);
		assert.doesNotThrow(() => new Date(status.last_heartbeat!));
	});

	it("message_queue_length reflects setQueueLength", async () => {
		const hc = new HealthChecker();
		hc.setQueueLength(7);
		const status = await hc.checkHealth();
		assert.equal(status.message_queue_length, 7);
	});
});

// ---------------------------------------------------------------------------
// DiscordBridgeService structural
// ---------------------------------------------------------------------------

describe("DiscordBridgeService", () => {
	it("constructor builds an instance with getQueueLength", async () => {
		// Lazy import to avoid triggering pool connections at module load
		const { DiscordBridgeService } = await import(
			"../../src/apps/discord-bridge/discord-bridge.ts"
		);
		const hc = new HealthChecker();
		const svc = new DiscordBridgeService("dummy-token", hc);
		assert.equal(typeof svc.getQueueLength, "function");
	});

	it("getQueueLength returns 0 before any messages are queued", async () => {
		const { DiscordBridgeService } = await import(
			"../../src/apps/discord-bridge/discord-bridge.ts"
		);
		const hc = new HealthChecker();
		const svc = new DiscordBridgeService("dummy-token", hc);
		assert.equal(svc.getQueueLength(), 0);
	});
});
