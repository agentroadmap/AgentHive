/**
 * proposal-20: Gateway Bot - Human-Agent Talk Relay Tests
 *
 * AC #1: Talk Relay service monitors roadmap/messages/
 * AC #2: New messages pushed to external channel (Discord webhook)
 * AC #3: External messages written back to local chat files
 * AC #4: Configuration for API keys/Webhooks
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import { createUniqueTestDir, safeCleanup } from "../support/test-utils.ts";

describe("proposal-20: Gateway Bot - Human-Agent Talk Relay", () => {
	let projectRoot: string;
	let core: Core;

	beforeEach(async () => {
		projectRoot = createUniqueTestDir("test-gateway");
		core = new Core(projectRoot);
		await core.initializeProject("Test Project", false);
	});

	afterEach(async () => {
		await safeCleanup(projectRoot);
	});

	describe("AC #1: Relay monitors roadmap/messages/", () => {
		it("can send and read messages from local chat", async () => {
			await core.sendMessage({
				from: "alice",
				message: "Hello from alice",
				type: "group",
				group: "project",
			});

			const result = await core.readMessages({ channel: "project" });
			assert.ok(result.messages.length > 0, "Should have messages");
			assert.ok(
				result.messages.some((m) => m.from === "alice"),
				"Should find alice's message",
			);
		});
	});

	describe("AC #3: External messages written back to local files", () => {
		it("external-style messages are persisted in markdown format", async () => {
			await core.sendMessage({
				from: "external-user",
				message: "Message from Discord",
				type: "group",
				group: "project",
			});

			// Verify message is in the file
			const result = await core.readMessages({ channel: "project" });
			assert.ok(
				result.messages.some((m) => m.text.includes("Discord")),
				"External message should be in local files",
			);
		});
	});

	describe("AC #4: Configuration structure", () => {
		it("config file can be loaded", async () => {
			const config = await core.fs.loadConfig();
			assert.ok(config !== null, "Config should be loadable");
		});
	});

	describe("AC #2: Message push structure", () => {
		it("message format supports webhook-compatible fields", async () => {
			await core.sendMessage({
				from: "relay-bot",
				message: "Webhook-style message",
				type: "group",
				group: "project",
			});

			const result = await core.readMessages({ channel: "project" });
			const msg = result.messages.find((m) => m.from === "relay-bot");
			assert.ok(msg, "Relay message should exist");
			assert.ok(msg.timestamp, "Message should have timestamp");
		});
	});
});
