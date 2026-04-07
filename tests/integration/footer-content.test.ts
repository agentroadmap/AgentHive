import assert from "node:assert";
import { describe, it } from "node:test";
import { formatFooterContent } from "../../src/ui/footer-content.ts";
import { expect } from "../support/test-utils.ts";

describe("formatFooterContent", () => {
	it("keeps footer on one line when terminal width is sufficient", () => {
		const content =
			" {cyan-fg}[Tab]{/} Switch View | {cyan-fg}[/]{/} Search | {cyan-fg}[q/Esc]{/} Quit";

		const result = formatFooterContent(content, 120);

		assert.strictEqual(result.height, 1);
		expect(result.content.includes("\n")).toBe(false);
	});

	it("wraps footer into two lines by splitting on separators", () => {
		const content =
			" {cyan-fg}[Tab]{/} Switch View | {cyan-fg}[/]{/} Search | {cyan-fg}[p]{/} Priority | {cyan-fg}[i]{/} Directive | {cyan-fg}[l]{/} Labels | {cyan-fg}[q/Esc]{/} Quit";

		const result = formatFooterContent(content, 52);
		const lines = result.content.split("\n");

		assert.strictEqual(result.height, 2);
		assert.strictEqual(lines.length, 2);
		expect(lines[0]?.includes("|")).toBe(true);
		expect(lines[1]?.includes("|")).toBe(true);
	});

	it("fills the first line progressively so the second line grows as width shrinks", () => {
		const content = " one | two | three | four | five";

		const wider = formatFooterContent(content, 28);
		const narrower = formatFooterContent(content, 22);

		assert.strictEqual(wider.height, 2);
		assert.strictEqual(narrower.height, 2);
		assert.strictEqual(wider.content, " one | two | three | four\n five");
		assert.strictEqual(narrower.content, " one | two | three\n four | five");
	});

	it("returns original content for messages without separators", () => {
		const content = " {red-fg}Failed to open editor.{/}";

		const result = formatFooterContent(content, 24);

		assert.strictEqual(result.height, 1);
		assert.strictEqual(result.content, content);
	});
});
