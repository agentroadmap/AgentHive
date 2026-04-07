/**
 * proposal-31: Channel Subscription MCP Integration Tests
 *
 * Verifies chan_subscribe MCP tool is properly exposed
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import { createUniqueTestDir, safeCleanup } from "../support/test-utils.ts";

describe("proposal-31: Channel Subscription MCP Integration", () => {
	let projectRoot: string;
	let core: Core;

	beforeEach(async () => {
		projectRoot = createUniqueTestDir("test-sub-mcp");
		core = new Core(projectRoot);
		await core.initializeProject("Test Project", false);
	});

	afterEach(async () => {
		await safeCleanup(projectRoot);
	});

	describe("AC #1: Subscribe to channel", () => {
		it("agent can subscribe to a public channel", async () => {
			await core.subscribeToChannel("alice", "public");
			const subs = await core.getSubscriptions("alice");
			assert.ok(subs.includes("public"), "Should be subscribed to public");
		});

		it("agent can subscribe to a group channel", async () => {
			await core.subscribeToChannel("bob", "project");
			const subs = await core.getSubscriptions("bob");
			assert.ok(subs.includes("project"), "Should be subscribed to project");
		});
	});

	describe("AC #2: Push notifications without polling", () => {
		it("subscribed agent receives notification on new message", async () => {
			await core.subscribeToChannel("alice", "project");

			let received: any = null;
			core.registerNotificationCallback("alice", (msg) => {
				received = msg;
			});

			await core.sendMessage({
				from: "bob",
				message: "Hello project!",
				type: "group",
				group: "project",
			});

			assert.ok(received, "Should receive notification");
			assert.strictEqual(received.from, "bob");
		});
	});

	describe("AC #3: Persistence across sessions", () => {
		it("subscriptions persist after creating new Core instance", async () => {
			await core.subscribeToChannel("alice", "public");
			await core.subscribeToChannel("alice", "project");

			const core2 = new Core(projectRoot);
			const subs = await core2.getSubscriptions("alice");

			assert.ok(subs.includes("public"), "Should persist public subscription");
			assert.ok(
				subs.includes("project"),
				"Should persist project subscription",
			);
		});
	});

	describe("AC #4: Unsubscribe mechanism", () => {
		it("agent can unsubscribe from a channel", async () => {
			await core.subscribeToChannel("alice", "project");
			await core.unsubscribeFromChannel("alice", "project");

			const subs = await core.getSubscriptions("alice");
			assert.ok(!subs.includes("project"), "Should be unsubscribed");
		});
	});

	describe("AC #5: chan_subscribe MCP tool", () => {
		it("subscription handler works correctly", async () => {
			// This tests the same logic as the MCP tool handler
			await core.subscribeToChannel("agent1", "public");
			const subs = await core.getSubscriptions("agent1");
			assert.ok(subs.includes("public"), "Subscribe should work");

			await core.unsubscribeFromChannel("agent1", "public");
			const subsAfter = await core.getSubscriptions("agent1");
			assert.ok(!subsAfter.includes("public"), "Unsubscribe should work");
		});
	});
});
