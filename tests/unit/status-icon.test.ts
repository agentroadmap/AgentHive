import assert from "node:assert";
import { describe, test } from "node:test";
import {
	formatStatusWithIcon,
	getStatusColor,
	getStatusIcon,
	getStatusStyle,
} from "../../src/ui/status-icon.ts";
import { expect } from "../support/test-utils.ts";

describe("Status Icon Component", () => {
	describe("getStatusStyle", () => {
		test("returns correct style for Complete status", () => {
			const style = getStatusStyle("Complete");
			assert.strictEqual(style.icon, "✅");
			assert.strictEqual(style.color, "green");
		});

		test("returns correct style for Develop status", () => {
			const style = getStatusStyle("Develop");
			assert.strictEqual(style.icon, "◒");
			assert.strictEqual(style.color, "yellow");
		});

		test("returns correct style for Blocked status", () => {
			const style = getStatusStyle("Blocked");
			assert.strictEqual(style.icon, "●");
			assert.strictEqual(style.color, "red");
		});

		test("returns correct style for Draft status", () => {
			const style = getStatusStyle("Draft");
			assert.strictEqual(style.icon, "○");
			assert.strictEqual(style.color, "white");
		});

		test("returns correct style for Review status", () => {
			const style = getStatusStyle("Review");
			assert.strictEqual(style.icon, "◆");
			assert.strictEqual(style.color, "blue");
		});

		test("returns correct style for Merge status", () => {
			const style = getStatusStyle("Merge");
			assert.strictEqual(style.icon, "▣");
			assert.strictEqual(style.color, "cyan");
		});

		test("returns default style for unknown status", () => {
			const style = getStatusStyle("Unknown Status");
			assert.strictEqual(style.icon, "○");
			assert.strictEqual(style.color, "white");
		});
	});

	describe("getStatusColor", () => {
		test("returns correct color for each status", () => {
			expect(getStatusColor("Complete")).toBe("green");
			expect(getStatusColor("Develop")).toBe("yellow");
			expect(getStatusColor("Blocked")).toBe("red");
			expect(getStatusColor("Draft")).toBe("white");
			expect(getStatusColor("Review")).toBe("blue");
			expect(getStatusColor("Merge")).toBe("cyan");
		});

		test("returns default color for unknown status", () => {
			expect(getStatusColor("Unknown")).toBe("white");
		});
	});

	describe("getStatusIcon", () => {
		test("returns correct icon for each status", () => {
			expect(getStatusIcon("Complete")).toBe("✅");
			expect(getStatusIcon("Develop")).toBe("◒");
			expect(getStatusIcon("Blocked")).toBe("●");
			expect(getStatusIcon("Draft")).toBe("○");
			expect(getStatusIcon("Review")).toBe("◆");
			expect(getStatusIcon("Merge")).toBe("▣");
		});

		test("returns default icon for unknown status", () => {
			expect(getStatusIcon("Unknown")).toBe("○");
		});
	});

	describe("formatStatusWithIcon", () => {
		test("formats status with correct icon", () => {
			expect(formatStatusWithIcon("Complete")).toBe("✅ Complete");
			expect(formatStatusWithIcon("Develop")).toBe("◒ Develop");
			expect(formatStatusWithIcon("Blocked")).toBe("● Blocked");
			expect(formatStatusWithIcon("Draft")).toBe("○ Draft");
			expect(formatStatusWithIcon("Review")).toBe("◆ Review");
			expect(formatStatusWithIcon("Merge")).toBe("▣ Merge");
		});

		test("formats unknown status with default icon", () => {
			expect(formatStatusWithIcon("Custom Status")).toBe("○ Custom Status");
		});
	});

	describe("Maturity Styles", () => {
		test("returns correct color for each maturity level", () => {
			const { getMaturityColor } = require("../../src/ui/status-icon.ts");
			expect(getMaturityColor("new")).toBe("white");
			expect(getMaturityColor("active")).toBe("yellow");
			expect(getMaturityColor("mature")).toBe("green");
			expect(getMaturityColor("obsolete")).toBe("gray");
		});

		test("returns correct icon for each maturity level", () => {
			const { getMaturityIcon } = require("../../src/ui/status-icon.ts");
			expect(getMaturityIcon("new")).toBe("○ ");
			expect(getMaturityIcon("active")).toBe("▶ ");
			expect(getMaturityIcon("mature")).toBe("✓ ");
			expect(getMaturityIcon("obsolete")).toBe("✖ ");
		});
	});
});
