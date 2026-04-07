import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseCompletionContext } from "./helper.ts";

describe("parseCompletionContext", () => {
	test("parses empty command line", () => {
		const context = parseCompletionContext("roadmap ", 8);
		assert.equal(context.command, null);
		assert.equal(context.subcommand, null);
		assert.equal(context.partial, "");
		assert.equal(context.lastFlag, null);
	});

	test("parses partial command", () => {
		const context = parseCompletionContext("roadmap tas", 11);
		assert.equal(context.command, null);
		assert.equal(context.partial, "tas");
	});

	test("parses complete command", () => {
		const context = parseCompletionContext("roadmap proposal ", 13);
		assert.equal(context.command, "proposal");
		assert.equal(context.subcommand, null);
		assert.equal(context.partial, "");
	});

	test("parses partial subcommand", () => {
		const context = parseCompletionContext("roadmap proposal ed", 15);
		assert.equal(context.command, "proposal");
		assert.equal(context.subcommand, null);
		assert.equal(context.partial, "ed");
	});

	test("parses complete subcommand", () => {
		const context = parseCompletionContext("roadmap proposal edit ", 18);
		assert.equal(context.command, "proposal");
		assert.equal(context.subcommand, "edit");
		assert.equal(context.partial, "");
	});

	test("parses partial argument", () => {
		const context = parseCompletionContext(
			"roadmap proposal edit proposal-",
			23,
		);
		assert.equal(context.command, "proposal");
		assert.equal(context.subcommand, "edit");
		assert.equal(context.partial, "proposal-");
	});

	test("parses flag", () => {
		const context = parseCompletionContext(
			"roadmap proposal create --status ",
			29,
		);
		assert.equal(context.command, "proposal");
		assert.equal(context.subcommand, "create");
		assert.equal(context.lastFlag, "--status");
		assert.equal(context.partial, "");
	});

	test("parses partial flag value", () => {
		const context = parseCompletionContext(
			"roadmap proposal create --status In",
			31,
		);
		assert.equal(context.command, "proposal");
		assert.equal(context.subcommand, "create");
		assert.equal(context.lastFlag, "--status");
		assert.equal(context.partial, "In");
	});

	test("handles quoted strings", () => {
		const context = parseCompletionContext(
			'roadmap proposal create "test proposal" --status ',
			41,
		);
		assert.equal(context.command, "proposal");
		assert.equal(context.subcommand, "create");
		assert.equal(context.lastFlag, "--status");
		assert.equal(context.partial, "");
	});

	test("handles multiple flags", () => {
		const context = parseCompletionContext(
			"roadmap proposal create --priority high --status ",
			46,
		);
		assert.equal(context.command, "proposal");
		assert.equal(context.subcommand, "create");
		assert.equal(context.lastFlag, "--status");
		assert.equal(context.partial, "");
	});

	test("parses completion subcommand", () => {
		const context = parseCompletionContext("roadmap completion install ", 27);
		assert.equal(context.command, "completion");
		assert.equal(context.subcommand, "install");
		assert.equal(context.partial, "");
	});

	test("handles cursor in middle of line", () => {
		// Cursor at position 13 is after "roadmap proposal " (space included)
		const context = parseCompletionContext("roadmap proposal edit", 13);
		assert.equal(context.command, "proposal");
		assert.equal(context.subcommand, null);
		assert.equal(context.partial, "");
	});

	test("counts argument position correctly", () => {
		const context = parseCompletionContext(
			"roadmap proposal edit proposal-1 ",
			25,
		);
		assert.equal(context.command, "proposal");
		assert.equal(context.subcommand, "edit");
		assert.equal(context.argPosition, 1);
	});

	test("does not count flag values as arguments", () => {
		const context = parseCompletionContext(
			"roadmap proposal create --status Reached ",
			34,
		);
		assert.equal(context.command, "proposal");
		assert.equal(context.subcommand, "create");
		assert.equal(context.argPosition, 0);
	});
});
