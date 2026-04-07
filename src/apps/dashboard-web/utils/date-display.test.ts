import assert from "node:assert";
import { describe, it } from "node:test";
import {
	formatStoredUtcDateForCompactDisplay,
	formatStoredUtcDateForDisplay,
	parseStoredUtcDate,
} from "./date-display";

describe("parseStoredUtcDate", () => {
	it("parses stored UTC datetime strings", () => {
		const parsed = parseStoredUtcDate("2026-02-09 06:01");
		assert.notStrictEqual(parsed, null);
		assert.strictEqual(parsed?.toISOString(), "2026-02-09T06:01:00.000Z");
	});

	it("parses date-only strings as UTC midnight", () => {
		const parsed = parseStoredUtcDate("2026-02-09");
		assert.notStrictEqual(parsed, null);
		assert.strictEqual(parsed?.toISOString(), "2026-02-09T00:00:00.000Z");
	});

	it("returns null for invalid date values", () => {
		assert.strictEqual(parseStoredUtcDate("2026-02-31 06:01"), null);
		assert.strictEqual(parseStoredUtcDate("not-a-date"), null);
	});
});

describe("formatStoredUtcDateForDisplay", () => {
	it("formats datetime values in local timezone", () => {
		const expected = new Date(Date.UTC(2026, 1, 9, 6, 1, 0)).toLocaleString(
			undefined,
			{
				dateStyle: "medium",
				timeStyle: "short",
			},
		);
		assert.strictEqual(
			formatStoredUtcDateForDisplay("2026-02-09 06:01"),
			expected,
		);
	});

	it("formats date-only values as local dates", () => {
		const expected = new Date(
			Date.UTC(2026, 1, 9, 0, 0, 0),
		).toLocaleDateString();
		assert.strictEqual(formatStoredUtcDateForDisplay("2026-02-09"), expected);
	});

	it("falls back to original value when parsing fails", () => {
		assert.strictEqual(
			formatStoredUtcDateForDisplay("not-a-date"),
			"not-a-date",
		);
	});
});

describe("formatStoredUtcDateForCompactDisplay", () => {
	const now = new Date(Date.UTC(2026, 1, 21, 12, 0, 0));

	it("formats recent values as relative days", () => {
		assert.strictEqual(
			formatStoredUtcDateForCompactDisplay("2026-02-21", now),
			"today",
		);
		assert.strictEqual(
			formatStoredUtcDateForCompactDisplay("2026-02-20", now),
			"yesterday",
		);
		assert.strictEqual(
			formatStoredUtcDateForCompactDisplay("2026-02-18", now),
			"3d ago",
		);
	});

	it("formats older values as short date", () => {
		const expected = new Date(
			Date.UTC(2026, 1, 10, 0, 0, 0),
		).toLocaleDateString();
		assert.strictEqual(
			formatStoredUtcDateForCompactDisplay("2026-02-10", now),
			expected,
		);
	});

	it("handles missing and invalid values gracefully", () => {
		assert.strictEqual(formatStoredUtcDateForCompactDisplay("", now), "—");
		assert.strictEqual(
			formatStoredUtcDateForCompactDisplay("not-a-date", now),
			"not-a-date",
		);
	});
});
