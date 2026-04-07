import assert from "node:assert";
import { describe, test } from "node:test";
import {
	formatHeading,
	getHeadingStyle,
	type HeadingLevel,
} from "../../src/ui/heading.ts";

describe("Heading component", () => {
	describe("getHeadingStyle", () => {
		test("should return correct style for level 1", () => {
			const style = getHeadingStyle(1);
			assert.strictEqual(style.color, "bright-white");
			assert.strictEqual(style.bold, true);
		});

		test("should return correct style for level 2", () => {
			const style = getHeadingStyle(2);
			assert.strictEqual(style.color, "cyan");
			assert.strictEqual(style.bold, false);
		});

		test("should return correct style for level 3", () => {
			const style = getHeadingStyle(3);
			assert.strictEqual(style.color, "white");
			assert.strictEqual(style.bold, false);
		});
	});

	describe("formatHeading", () => {
		test("should format level 1 heading with bold and bright-white", () => {
			const formatted = formatHeading("Main Title", 1);
			assert.strictEqual(
				formatted,
				"{bold}{brightwhite-fg}Main Title{/brightwhite-fg}{/bold}",
			);
		});

		test("should format level 2 heading with cyan", () => {
			const formatted = formatHeading("Section Title", 2);
			assert.strictEqual(formatted, "{cyan-fg}Section Title{/cyan-fg}");
		});

		test("should format level 3 heading with white", () => {
			const formatted = formatHeading("Subsection Title", 3);
			assert.strictEqual(formatted, "{white-fg}Subsection Title{/white-fg}");
		});

		test("should handle empty text", () => {
			const formatted = formatHeading("", 1);
			assert.strictEqual(
				formatted,
				"{bold}{brightwhite-fg}{/brightwhite-fg}{/bold}",
			);
		});

		test("should handle special characters", () => {
			const formatted = formatHeading("Title with @#$%", 2);
			assert.strictEqual(formatted, "{cyan-fg}Title with @#$%{/cyan-fg}");
		});
	});

	describe("heading levels", () => {
		test("should accept valid heading levels", () => {
			const levels: HeadingLevel[] = [1, 2, 3];

			for (const level of levels) {
				const style = getHeadingStyle(level);
				assert.notStrictEqual(style, undefined);
				assert.strictEqual(typeof style.color, "string");
				assert.strictEqual(typeof style.bold, "boolean");
			}
		});

		test("should have distinct styles for each level", () => {
			const style1 = getHeadingStyle(1);
			const style2 = getHeadingStyle(2);
			const style3 = getHeadingStyle(3);

			// Level 1 should be the only bold one
			assert.strictEqual(style1.bold, true);
			assert.strictEqual(style2.bold, false);
			assert.strictEqual(style3.bold, false);

			// Each level should have different colors
			assert.notStrictEqual(style1.color, style2.color);
			assert.notStrictEqual(style2.color, style3.color);
			assert.notStrictEqual(style1.color, style3.color);
		});
	});

	describe("blessed tag formatting", () => {
		test("should produce valid blessed tags", () => {
			const level1 = formatHeading("Test", 1);
			const level2 = formatHeading("Test", 2);
			const level3 = formatHeading("Test", 3);

			// Should contain valid blessed tag syntax
			assert.ok(/^\{.*\}.*\{\/.*\}$/.test(level1));
			assert.ok(/^\{.*\}.*\{\/.*\}$/.test(level2));
			assert.ok(/^\{.*\}.*\{\/.*\}$/.test(level3));

			// Level 1 should have both bold and color tags
			assert.ok(level1.includes("{bold}"));
			assert.ok(level1.includes("{/bold}"));
			assert.ok(level1.includes("-fg}"));

			// Level 2 and 3 should only have color tags
			assert.ok(!level2.includes("{bold}"));
			assert.ok(!level3.includes("{bold}"));
		});
	});
});
