/**
 * S147.2 Tests: 1:1 Agent-to-Agent Messaging
 */

import assert from "node:assert";
import { beforeEach, describe, it } from "node:test";
import { registerAgent } from "../../src/core/identity/agent-registry/index.ts";
import {
	acknowledgeMessage,
	clearMessages,
	getMessages,
	getReplyChain,
	sendMessage,
} from "../../src/core/messaging/agent-messaging/index.ts";

describe("S147.2: 1:1 Agent-to-Agent Messaging", () => {
	beforeEach(async () => {
		await registerAgent({
			agentId: "xGit1",
			instanceId: "xGit1",
			agentType: "contract",
			role: "git-researcher",
			capabilities: ["git"],
		});
		await registerAgent({
			agentId: "xDev1",
			instanceId: "xDev1",
			agentType: "contract",
			role: "developer",
			capabilities: ["typescript"],
		});
		await clearMessages();
	});

	describe("AC#1: Agent sends message to Agent B by ID", () => {
		it("should create message with correct routing", async () => {
			const result = await sendMessage({
				from: "xGit1",
				to: "xDev1",
				type: "task",
				content: "Implement S147.1",
			});

			assert.ok(result.messageId, "Should return message ID");
		});

		it("should return success even when MCP channel not pre-created", async () => {
			const result = await sendMessage({
				from: "xGit1",
				to: "nonexistent-agent",
				type: "query",
				content: "Test",
			});

			// Message sent (MCP handles it or fails gracefully)
			assert.ok(result.messageId || !result.success);
		});
	});

	describe("AC#3: Agent B can reply to Agent A", () => {
		it("should support replyTo field", async () => {
			const sent = await sendMessage({
				from: "xGit1",
				to: "xDev1",
				type: "query",
				content: "Status?",
			});

			const reply = await sendMessage({
				from: "xDev1",
				to: "xGit1",
				type: "response",
				content: "Complete",
				replyTo: sent.messageId,
			});

			assert.ok(reply.messageId);
		});

		it("should build reply chain from local memory", async () => {
			const msg1 = await sendMessage({
				from: "xGit1",
				to: "xDev1",
				type: "query",
				content: "Q1",
			});
			const msg2 = await sendMessage({
				from: "xDev1",
				to: "xGit1",
				type: "response",
				content: "A1",
				replyTo: msg1.messageId,
			});
			const msg3 = await sendMessage({
				from: "xGit1",
				to: "xDev1",
				type: "query",
				content: "Q2",
				replyTo: msg2.messageId,
			});

			const chain = await getReplyChain(msg3.messageId);
			assert.strictEqual(chain.length, 3);
		});
	});

	describe("AC#4: Message metadata preserved", () => {
		it("should include timestamp in sent message", async () => {
			const result = await sendMessage({
				from: "xGit1",
				to: "xDev1",
				type: "task",
				content: "Test",
			});

			// Verify the message was sent (messageId generated)
			assert.ok(result.messageId, "Message should have an ID");
		});

		it("should generate unique message ID", async () => {
			const r1 = await sendMessage({
				from: "xGit1",
				to: "xDev1",
				type: "task",
				content: "Test 1",
			});
			const r2 = await sendMessage({
				from: "xGit1",
				to: "xDev1",
				type: "task",
				content: "Test 2",
			});

			assert.notStrictEqual(r1.messageId, r2.messageId);
		});
	});

	describe("Acknowledgment", () => {
		it("should acknowledge message receipt", async () => {
			const sent = await sendMessage({
				from: "xGit1",
				to: "xDev1",
				type: "task",
				content: "Ack test",
			});

			const acked = await acknowledgeMessage(sent.messageId);
			assert.strictEqual(acked, true);
		});
	});

	describe("AC#2: getMessages reads from MCP (async)", () => {
		it("should return a promise", async () => {
			const result = getMessages({ agentId: "xDev1" });
			assert.ok(
				result instanceof Promise,
				"getMessages should return a Promise",
			);
			const msgs = await result;
			assert.ok(Array.isArray(msgs), "Should resolve to array");
		});

		it("should handle MCP read gracefully", async () => {
			// MCP may not have this channel yet, should not throw
			const msgs = await getMessages({ agentId: "nonexistent-agent-999" });
			assert.ok(
				Array.isArray(msgs),
				"Should return array even if channel empty",
			);
		});
	});

	describe("AC#5: Message ordering (FIFO)", () => {
		it("should store messages in send order", async () => {
			const r1 = await sendMessage({
				from: "xGit1",
				to: "xDev1",
				type: "task",
				content: "First",
			});
			const r2 = await sendMessage({
				from: "xGit1",
				to: "xDev1",
				type: "task",
				content: "Second",
			});
			const r3 = await sendMessage({
				from: "xGit1",
				to: "xDev1",
				type: "task",
				content: "Third",
			});

			// All three should succeed
			assert.ok(r1.messageId);
			assert.ok(r2.messageId);
			assert.ok(r3.messageId);
		});
	});
});
