import assert from "node:assert";
import { describe, test } from "node:test";
import { generateAgencyAlias } from "./agent-name.ts";

/**
 * P1367 (amends P996): canonical agency aliases are hyphen-separated with an
 * optional LLM-variant middle slot and the process-type marker last.
 */
describe("generateAgencyAlias (P1367 AC-2)", () => {
	test("style only → <style>-a", () => {
		assert.equal(generateAgencyAlias({ style: "claude" }), "claude-a");
		assert.equal(generateAgencyAlias({ style: "codex" }), "codex-a");
		assert.equal(generateAgencyAlias({ style: "gemini" }), "gemini-a");
		assert.equal(generateAgencyAlias({ style: "copilot" }), "copilot-a");
	});

	test("style + variant → <style>-<variant>-a (hyphen, NOT dot)", () => {
		const alias = generateAgencyAlias({ style: "claude", variant: "mimo" });
		assert.equal(alias, "claude-mimo-a");
		assert.notEqual(alias, "claude.mimo.a");
	});

	test("liaison suffix → <style>-l", () => {
		assert.equal(
			generateAgencyAlias({ style: "codex", suffix: "l" }),
			"codex-l",
		);
		assert.equal(
			generateAgencyAlias({ style: "claude", variant: "bedrock", suffix: "l" }),
			"claude-bedrock-l",
		);
	});

	test("null/empty variant is treated as no variant (NULL slot)", () => {
		assert.equal(
			generateAgencyAlias({ style: "claude", variant: null }),
			"claude-a",
		);
		assert.equal(
			generateAgencyAlias({ style: "claude", variant: "" }),
			"claude-a",
		);
	});

	test("inputs are lower-cased and trimmed", () => {
		assert.equal(
			generateAgencyAlias({ style: "Claude", variant: " MiMo " }),
			"claude-mimo-a",
		);
	});
});
