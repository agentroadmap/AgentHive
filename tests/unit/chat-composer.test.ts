import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as composer from "../../src/utils/chat-composer.ts";

describe("Chat Composer Utils", () => {
	it("should initialize empty proposal", () => {
		const proposal = composer.createChatComposerProposal();
		assert.deepEqual(proposal.lines, [""]);
		assert.equal(composer.getChatComposerText(proposal), "");
	});

	it("should handle text input", () => {
		let proposal = composer.createChatComposerProposal();
		const result = composer.applyChatComposerKey(
			proposal,
			{ sequence: "h" },
			"h",
		);
		if (result.type === "update") {
			proposal = result.proposal;
		}
		assert.equal(composer.getChatComposerText(proposal), "h");
	});

	it("should handle backspace", () => {
		let proposal = { lines: ["hi"] };
		const result = composer.applyChatComposerKey(proposal, {
			name: "backspace",
		});
		if (result.type === "update") {
			proposal = result.proposal;
		}
		assert.equal(composer.getChatComposerText(proposal), "h");
	});

	it("should handle multiline input (Shift+Enter)", () => {
		let proposal = { lines: ["line1"] };
		const result = composer.applyChatComposerKey(proposal, {
			name: "return",
			shift: true,
		});
		if (result.type === "update") {
			proposal = result.proposal;
		}
		assert.equal(composer.getChatComposerText(proposal), "line1\n");
	});

	it("should send message on Enter", () => {
		const proposal = { lines: ["hello"] };
		const result = composer.applyChatComposerKey(proposal, { name: "return" });
		assert.equal(result.type, "send");
		if (result.type === "send") {
			assert.equal(result.message, "hello");
		}
	});

	it("should normalize mentions", () => {
		const knownUsers = ["Alice (Senior Agent)", "Bob"];
		const proposal = { lines: ["Hello @al"] };
		const suggestions = composer.getChatMentionSuggestions(
			proposal,
			knownUsers,
		);
		assert.equal(suggestions.length, 1);
		assert.equal(suggestions[0].value, "@alice");
	});

	it("should cycle mentions with Tab", () => {
		const knownUsers = ["Alice", "Bob"];
		let proposal = { lines: ["@"] };

		proposal = composer.cycleChatMention(proposal, knownUsers, 1);
		assert.equal(composer.getChatComposerText(proposal), "@alice");

		proposal = composer.cycleChatMention(proposal, knownUsers, 1);
		assert.equal(composer.getChatComposerText(proposal), "@bob");
	});

	it("should complete paths", () => {
		const mockList = (_dir: string) => [
			{ name: "file.txt", isDirectory: false },
			{ name: "docs", isDirectory: true },
		];

		let proposal = { lines: ["read /tmp/f"] };
		proposal = composer.completeChatPath(proposal, {
			homeDir: "/home/user",
			listDirectory: mockList,
		});

		assert.equal(composer.getChatComposerText(proposal), "read /tmp/file.txt");
	});
});
