/**
 * Tests for proposal-49: Inter-Agent Communication Protocol
 *
 * AC#1: Agents can send messages to channels (existing - tested elsewhere)
 * AC#2: Messages persisted in markdown files (existing - tested elsewhere)
 * AC#3: Agent mentions trigger notifications
 * AC#4: Message threading supported
 */

import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	appendMessage,
	buildThreads,
	ensureChannelFile,
	extractMentions,
	findMentionsForAgent,
	formatMentionNotification,
	formatMessage,
	formatThread,
	type ParsedMessage,
	parseMessageLine,
	parseMessagesFromFile,
	shouldNotify,
} from "../../src/core/messaging/message-protocol.ts";

describe("proposal-49: Inter-Agent Communication Protocol", () => {
	let testDir: string;
	let messagesDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "protocol-test-"));
		messagesDir = join(testDir, "messages");
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("AC#3: Agent mentions trigger notifications", () => {
		it("should extract mentions from message content", () => {
			assert.deepEqual(extractMentions("Hello @alice and @bob"), [
				"alice",
				"bob",
			]);
			assert.deepEqual(extractMentions("No mentions here"), []);
			assert.deepEqual(extractMentions("@alice @alice duplicate"), ["alice"]);
			assert.deepEqual(extractMentions("Use @agent-name format"), [
				"agent-name",
			]);
			assert.deepEqual(extractMentions("Use @agent_name format"), [
				"agent_name",
			]);
		});

		it("should parse messages with mentions", () => {
			const line = "[2026-03-24 10:00:00] bob: Hey @alice, can you help?";
			const message = parseMessageLine(line, "project");

			assert.notEqual(message, null);
			assert.equal(message?.type, "mention");
			assert.ok(message?.mentions.includes("alice"));
			assert.equal(message?.from, "bob");
		});

		it("should find mentions for a specific agent", () => {
			const messages: ParsedMessage[] = [
				{
					id: "msg-1",
					timestamp: "2026-03-24 10:00:00",
					from: "bob",
					content: "Hey @alice, can you help?",
					type: "mention",
					priority: "normal",
					mentions: ["alice"],
					channel: "project",
					raw: "",
				},
				{
					id: "msg-2",
					timestamp: "2026-03-24 10:01:00",
					from: "alice",
					content: "Sure @bob, what do you need?",
					type: "mention",
					priority: "normal",
					mentions: ["bob"],
					channel: "project",
					raw: "",
				},
				{
					id: "msg-3",
					timestamp: "2026-03-24 10:02:00",
					from: "carol",
					content: "Hey @alice, I also need help",
					type: "mention",
					priority: "normal",
					mentions: ["alice"],
					channel: "project",
					raw: "",
				},
			];

			const aliceMentions = findMentionsForAgent(messages, "alice");
			assert.equal(aliceMentions.length, 2);
			assert.equal(aliceMentions[0]?.message.from, "bob");
			assert.equal(aliceMentions[1]?.message.from, "carol");

			// Should not include self-mentions
			const aliceMentionsIncludingSelf = findMentionsForAgent(
				messages,
				"alice",
			);
			const selfMentions = aliceMentionsIncludingSelf.filter(
				(n) => n.message.from === "alice",
			);
			assert.equal(selfMentions.length, 0); // Self-mentions filtered out
		});

		it("should format mention notifications", () => {
			const notification = {
				agent: "alice",
				message: {
					id: "msg-1",
					timestamp: "2026-03-24 10:00:00",
					from: "bob",
					content: "Hey @alice, can you help?",
					type: "mention" as const,
					priority: "normal" as const,
					mentions: ["alice"],
					channel: "project",
					raw: "",
				},
				channel: "project",
			};

			const formatted = formatMentionNotification(notification);
			assert.ok(formatted.includes("Mention in #project"));
			assert.ok(formatted.includes("From: bob"));
			assert.ok(formatted.includes("Hey @alice, can you help?"));
		});

		it("should check if agent should be notified", () => {
			const mentionMsg: ParsedMessage = {
				id: "msg-1",
				timestamp: "2026-03-24 10:00:00",
				from: "bob",
				content: "Hey @alice",
				type: "mention",
				priority: "normal",
				mentions: ["alice"],
				channel: "project",
				raw: "",
			};

			const normalMsg: ParsedMessage = {
				id: "msg-2",
				timestamp: "2026-03-24 10:00:00",
				from: "bob",
				content: "Just a message",
				type: "text",
				priority: "normal",
				mentions: [],
				channel: "project",
				raw: "",
			};

			const selfMention: ParsedMessage = {
				id: "msg-3",
				timestamp: "2026-03-24 10:00:00",
				from: "alice",
				content: "@alice self mention",
				type: "mention",
				priority: "normal",
				mentions: ["alice"],
				channel: "project",
				raw: "",
			};

			assert.equal(shouldNotify(mentionMsg, "alice"), true);
			assert.equal(shouldNotify(normalMsg, "alice"), false);
			assert.equal(shouldNotify(selfMention, "alice"), false); // Self-mention
		});
	});

	describe("AC#4: Message threading supported", () => {
		it("should parse messages with thread markers", () => {
			const line =
				"[2026-03-24 10:05:00] alice [thread=MSG-abc123]: I agree with this approach";
			const message = parseMessageLine(line, "project");

			assert.notEqual(message, null);
			assert.equal(message?.type, "thread_reply");
			assert.equal(message?.threadId, "MSG-abc123");
			assert.equal(message?.replyTo, "MSG-abc123");
		});

		it("should parse messages with reply markers", () => {
			const line = "[2026-03-24 10:05:00] alice [reply=MSG-abc123]: Good point";
			const message = parseMessageLine(line, "project");

			assert.notEqual(message, null);
			assert.equal(message?.replyTo, "MSG-abc123");
			assert.equal(message?.threadId, undefined);
		});

		it("should build threads from messages", () => {
			const messages: ParsedMessage[] = [
				{
					id: "MSG-001",
					timestamp: "2026-03-24 10:00:00",
					from: "bob",
					content: "Should we use SQLite?",
					type: "text",
					priority: "normal",
					mentions: [],
					channel: "project",
					raw: "",
				},
				{
					id: "MSG-002",
					timestamp: "2026-03-24 10:01:00",
					from: "alice",
					content: "Yes, it's more reliable",
					type: "thread_reply",
					priority: "normal",
					mentions: [],
					threadId: "MSG-001",
					replyTo: "MSG-001",
					channel: "project",
					raw: "",
				},
				{
					id: "MSG-003",
					timestamp: "2026-03-24 10:02:00",
					from: "carol",
					content: "Agreed, let's use it",
					type: "thread_reply",
					priority: "normal",
					mentions: [],
					threadId: "MSG-001",
					replyTo: "MSG-001",
					channel: "project",
					raw: "",
				},
				{
					id: "MSG-004",
					timestamp: "2026-03-24 10:03:00",
					from: "dave",
					content: "Different topic here",
					type: "text",
					priority: "normal",
					mentions: [],
					channel: "project",
					raw: "",
				},
			];

			const threads = buildThreads(messages);

			assert.equal(threads.length, 1);
			assert.equal(threads[0]?.id, "MSG-001");
			assert.equal(threads[0]?.replies.length, 2);
			assert.ok(threads[0]?.participants.includes("bob"));
			assert.ok(threads[0]?.participants.includes("alice"));
			assert.ok(threads[0]?.participants.includes("carol"));
		});

		it("should format thread for display", () => {
			const thread = {
				id: "MSG-001",
				parent: {
					id: "MSG-001",
					timestamp: "2026-03-24 10:00:00",
					from: "bob",
					content: "Should we use SQLite?",
					type: "text" as const,
					priority: "normal" as const,
					mentions: [],
					channel: "project",
					raw: "",
				},
				replies: [
					{
						id: "MSG-002",
						timestamp: "2026-03-24 10:01:00",
						from: "alice",
						content: "Yes, it's more reliable",
						type: "thread_reply" as const,
						priority: "normal" as const,
						mentions: [],
						threadId: "MSG-001",
						replyTo: "MSG-001",
						channel: "project",
						raw: "",
					},
				],
				lastActivity: "2026-03-24 10:01:00",
				participants: ["bob", "alice"],
			};

			const formatted = formatThread(thread);
			assert.ok(formatted.includes("## Thread: MSG-001"));
			assert.ok(formatted.includes("**bob**"));
			assert.ok(formatted.includes("Should we use SQLite?"));
			assert.ok(formatted.includes("1 replies"));
			assert.ok(formatted.includes("**alice**"));
			assert.ok(formatted.includes("Participants: bob, alice"));
		});
	});

	describe("Message file operations", () => {
		it("should format messages correctly", () => {
			const formatted = formatMessage({
				from: "alice",
				content: "Hello everyone!",
			});

			assert.match(
				formatted,
				/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] alice:/,
			);
			assert.ok(formatted.includes("Hello everyone!"));
		});

		it("should format messages with priority", () => {
			const formatted = formatMessage({
				from: "alice",
				content: "Urgent!",
				priority: "urgent",
			});

			assert.ok(formatted.includes("[priority=urgent]"));
		});

		it("should format messages with thread marker", () => {
			const formatted = formatMessage({
				from: "alice",
				content: "Replying",
				threadId: "MSG-001",
			});

			assert.ok(formatted.includes("[thread=MSG-001]"));
		});

		it("should ensure channel file exists", () => {
			ensureChannelFile(messagesDir, "project");

			const filePath = join(messagesDir, "group-project.md");
			assert.equal(existsSync(filePath), true);
		});

		it("should append messages to channel file", () => {
			ensureChannelFile(messagesDir, "project");

			appendMessage(messagesDir, "project", {
				from: "alice",
				content: "First message",
			});

			appendMessage(messagesDir, "project", {
				from: "bob",
				content: "Second message",
			});

			const filePath = join(messagesDir, "group-project.md");
			const content = readFileSync(filePath, "utf-8");
			assert.ok(content.includes("First message"));
			assert.ok(content.includes("Second message"));
		});
	});

	describe("Parsing messages from files", () => {
		it("should parse messages from a markdown file", () => {
			ensureChannelFile(messagesDir, "project");
			const filePath = join(messagesDir, "group-project.md");

			// Append some test messages
			const content = `# Group Chat: #project

[2026-03-24 10:00:00] bob: Hello everyone!
[2026-03-24 10:01:00] alice: Hey @bob, how are you?
[2026-03-24 10:02:00] carol: Good morning!
`;
			writeFileSync(filePath, content);

			const messages = parseMessagesFromFile(filePath, "project");

			assert.equal(messages.length, 3);
			assert.equal(messages[0]?.from, "bob");
			assert.ok(messages[1]?.mentions.includes("bob"));
			assert.equal(messages[2]?.from, "carol");
		});

		it("should handle missing files", () => {
			const messages = parseMessagesFromFile("/nonexistent/file.md", "project");
			assert.deepEqual(messages, []);
		});
	});
});
