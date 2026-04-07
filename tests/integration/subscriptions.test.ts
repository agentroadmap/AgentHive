/**
 * Tests for Channel Subscription System
 * Covers: subscribe, unsubscribe, persistence, agents lookup
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";

describe("Channel Subscriptions", () => {
	let testDir: string;
	let core: Core;

	beforeEach(async () => {
		testDir = join(tmpdir(), `test-subs-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		// Initialize a basic project structure
		mkdirSync(join(testDir, "roadmap", "proposals"), { recursive: true });
		core = new Core(testDir);
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("subscribeToChannel", () => {
		it("subscribes an agent to a channel", async () => {
			await core.subscribeToChannel("alice", "project");
			const subs = await core.getSubscriptions("alice");
			assert.ok(subs.includes("project"));
		});

		it("allows multiple subscriptions", async () => {
			await core.subscribeToChannel("alice", "project");
			await core.subscribeToChannel("alice", "public");
			const subs = await core.getSubscriptions("alice");
			assert.equal(subs.length, 2);
			assert.ok(subs.includes("project"));
			assert.ok(subs.includes("public"));
		});

		it("deduplicates subscriptions", async () => {
			await core.subscribeToChannel("alice", "project");
			await core.subscribeToChannel("alice", "project");
			const subs = await core.getSubscriptions("alice");
			assert.equal(subs.length, 1);
		});

		it("supports multiple agents independently", async () => {
			await core.subscribeToChannel("alice", "project");
			await core.subscribeToChannel("bob", "public");

			const aliceSubs = await core.getSubscriptions("alice");
			const bobSubs = await core.getSubscriptions("bob");

			assert.equal(aliceSubs.length, 1);
			assert.equal(bobSubs.length, 1);
			assert.ok(aliceSubs.includes("project"));
			assert.ok(bobSubs.includes("public"));
		});
	});

	describe("unsubscribeFromChannel", () => {
		it("unsubscribes an agent from a channel", async () => {
			await core.subscribeToChannel("alice", "project");
			await core.unsubscribeFromChannel("alice", "project");
			const subs = await core.getSubscriptions("alice");
			assert.equal(subs.length, 0);
		});

		it("is safe to unsubscribe from non-existent subscription", async () => {
			await core.unsubscribeFromChannel("alice", "nonexistent");
			const subs = await core.getSubscriptions("alice");
			assert.equal(subs.length, 0);
		});

		it("only removes the specified channel", async () => {
			await core.subscribeToChannel("alice", "project");
			await core.subscribeToChannel("alice", "public");
			await core.unsubscribeFromChannel("alice", "project");

			const subs = await core.getSubscriptions("alice");
			assert.equal(subs.length, 1);
			assert.ok(subs.includes("public"));
		});
	});

	describe("getSubscribedAgents", () => {
		it("returns agents subscribed to a channel", async () => {
			await core.subscribeToChannel("alice", "project");
			await core.subscribeToChannel("bob", "project");
			await core.subscribeToChannel("carol", "public");

			const projectAgents = await core.getSubscribedAgents("project");
			assert.equal(projectAgents.length, 2);
			assert.ok(projectAgents.includes("alice"));
			assert.ok(projectAgents.includes("bob"));
		});

		it("returns empty for channel with no subscribers", async () => {
			const agents = await core.getSubscribedAgents("empty-channel");
			assert.equal(agents.length, 0);
		});
	});

	describe("persistence", () => {
		it("saves subscriptions to disk", async () => {
			await core.subscribeToChannel("alice", "project");

			const subsPath = join(testDir, "roadmap", "local", "subscriptions.json");
			assert.ok(existsSync(subsPath));
		});

		it("loads subscriptions on new Core instance", async () => {
			await core.subscribeToChannel("alice", "project");
			await core.subscribeToChannel("bob", "public");

			// Create new Core instance
			const core2 = new Core(testDir);
			const aliceSubs = await core2.getSubscriptions("alice");
			const bobSubs = await core2.getSubscriptions("bob");

			assert.ok(aliceSubs.includes("project"));
			assert.ok(bobSubs.includes("public"));
		});

		it("handles corrupt file gracefully", async () => {
			const subsPath = join(testDir, "roadmap", "local", "subscriptions.json");
			const { writeFileSync, mkdirSync } = await import("node:fs");
			mkdirSync(join(testDir, "roadmap", "local"), { recursive: true });
			writeFileSync(subsPath, "{ invalid json");

			// Should not throw
			const core2 = new Core(testDir);
			const subs = await core2.getSubscriptions("alice");
			assert.equal(subs.length, 0);
		});
	});

	describe("push notifications", () => {
		it("notifies subscribed agent via callback when message is sent", async () => {
			// Subscribe alice to project group
			await core.subscribeToChannel("alice", "project");

			// Register notification callback for alice
			let receivedMsg: {
				channel: string;
				from: string;
				text: string;
				timestamp: string;
			} | null = null;
			core.registerNotificationCallback("alice", (msg) => {
				receivedMsg = msg;
			});

			// Send a message as bob to project group
			await core.sendMessage({
				from: "bob",
				message: "Hello project!",
				type: "group",
				group: "project",
			});

			// Verify alice received the notification
			assert.ok(
				receivedMsg !== null,
				"alice should have received a notification",
			);
			const msg = receivedMsg as {
				channel: string;
				from: string;
				text: string;
				timestamp: string;
			};
			assert.equal(msg.channel, "project");
			assert.equal(msg.from, "bob");
			assert.ok(msg.text.includes("Hello project!"));
		});

		it("does not notify the sender", async () => {
			await core.subscribeToChannel("bob", "project");

			let receivedMsg: {
				channel: string;
				from: string;
				text: string;
				timestamp: string;
			} | null = null;
			core.registerNotificationCallback("bob", (msg) => {
				receivedMsg = msg;
			});

			await core.sendMessage({
				from: "bob",
				message: "Self message",
				type: "group",
				group: "project",
			});

			assert.equal(
				receivedMsg,
				null,
				"sender should not receive their own notification",
			);
		});

		it("can unsubscribe from notifications", async () => {
			await core.subscribeToChannel("alice", "project");

			let callCount = 0;
			const unsub = core.registerNotificationCallback("alice", () => {
				callCount++;
			});

			await core.sendMessage({
				from: "bob",
				message: "msg1",
				type: "group",
				group: "project",
			});
			assert.equal(callCount, 1);

			// Unregister
			unsub();

			await core.sendMessage({
				from: "bob",
				message: "msg2",
				type: "group",
				group: "project",
			});
			assert.equal(
				callCount,
				1,
				"callback should not be called after unsubscribe",
			);
		});
	});
});
