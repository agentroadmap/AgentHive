import assert from "node:assert/strict";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { RelayService } from "../../src/core/messaging/relay.ts";
import type { RelayConfig } from "../../src/types/index.ts";

const TEST_DIR = join(process.cwd(), "tmp", "test-relay");
const MESSAGES_DIR = join(TEST_DIR, "roadmap", "messages");

describe("Relay Service Module", () => {
	let relay: RelayService;
	let mockCore: any;
	let mockFetch: any;

	beforeEach(() => {
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true, force: true });
		}
		mkdirSync(MESSAGES_DIR, { recursive: true });

		mockCore = {
			getMessagesDir: async () => MESSAGES_DIR,
			sendMessage: mock.fn(async () => {}),
		};

		// Mock global fetch
		mockFetch = mock.fn(async () => ({
			ok: true,
			json: async () => [],
			statusText: "OK",
		}));
		global.fetch = mockFetch;
	});

	afterEach(() => {
		if (relay) relay.stop();
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true, force: true });
		}
	});

	it("should not start if disabled", async () => {
		const config: RelayConfig = { enabled: false };
		relay = new RelayService(mockCore as any, config);
		await relay.start();
		// @ts-expect-error - accessing private for test
		assert.equal(relay.isRunning, false);
	});

	it("should parse new lines and push to webhook", async () => {
		const config: RelayConfig = {
			enabled: true,
			webhook_url: "https://discord.local/webhook",
			ignored_agents: ["noisy-bot"],
		};
		relay = new RelayService(mockCore as any, config);

		const chatFile = join(MESSAGES_DIR, "general.md");
		writeFileSync(chatFile, "[2026-03-24 00:00] system: Init\n");

		await relay.start();

		// Append new content
		appendFileSync(chatFile, "[2026-03-24 00:01] user1: Hello world\n");
		appendFileSync(chatFile, "[2026-03-24 00:02] noisy-bot: Beep boop\n");

		// Trigger manual handle (since fs.watch is async/finicky in tests)
		// @ts-expect-error
		await relay.handleFileChange("general.md");

		// Should have called fetch for user1, but NOT for noisy-bot
		assert.equal(mockFetch.mock.callCount(), 1);
		const call = mockFetch.mock.calls[0];
		const payload = JSON.parse(call.arguments[1].body);
		assert.equal(payload.username, "user1 (Relay)");
		assert.ok(payload.content.includes("Hello world"));
	});

	it("should fetch external messages and write to local chat", async () => {
		const config: RelayConfig = {
			enabled: true,
			bot_token: "secret",
			channel_id: "123",
			interval_ms: 10000,
		};

		const externalMsg = {
			id: "msg-100",
			author: { username: "ext-user", bot: false },
			content: "From Discord",
		};

		mockFetch.mock.mockImplementation(async () => ({
			ok: true,
			json: async () => [externalMsg],
		}));

		relay = new RelayService(mockCore as any, config);

		// @ts-expect-error
		await relay.fetchExternalMessages();

		assert.equal(mockCore.sendMessage.mock.callCount(), 1);
		const call = mockCore.sendMessage.mock.calls[0];
		assert.equal(call.arguments[0].from, "ext-user (External)");
		assert.equal(call.arguments[0].message, "From Discord");
	});

	it("should avoid infinite loops from its own relayed messages", async () => {
		const config: RelayConfig = {
			enabled: true,
			bot_token: "secret",
			channel_id: "123",
		};

		const selfMsg = {
			id: "msg-101",
			author: { username: "agent-1 (Relay)", bot: true },
			content: "I relayed this",
		};

		mockFetch.mock.mockImplementation(async () => ({
			ok: true,
			json: async () => [selfMsg],
		}));

		relay = new RelayService(mockCore as any, config);

		// @ts-expect-error
		await relay.fetchExternalMessages();

		// Should NOT have sent message to core
		assert.equal(mockCore.sendMessage.mock.callCount(), 0);
	});
});
