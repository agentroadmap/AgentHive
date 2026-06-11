import { describe, it, expect } from "bun:test";
import parseTags from "./parseTags";

describe("parseTags", () => {
	it("returns empty object for null", () => {
		expect(parseTags(null)).toEqual({});
	});

	it("returns empty object for undefined", () => {
		expect(parseTags(undefined)).toEqual({});
	});

	it("returns the object as-is when input is an object", () => {
		const obj = { schema_drift: true, fingerprint: "abc123" };
		expect(parseTags(obj)).toBe(obj);
	});

	it("parses valid JSON string", () => {
		const json = '{"schema_drift": true, "fingerprint": "abc123"}';
		expect(parseTags(json)).toEqual({ schema_drift: true, fingerprint: "abc123" });
	});

	it("returns empty object for invalid JSON string", () => {
		expect(parseTags("{invalid json}")).toEqual({});
	});

	it("returns empty object for empty string", () => {
		expect(parseTags("")).toEqual({});
	});

	it("handles JSON string with null value", () => {
		const json = '{"key": null}';
		expect(parseTags(json)).toEqual({ key: null });
	});

	it("returns empty object if JSON parses to non-object", () => {
		expect(parseTags('"just a string"')).toEqual({});
		expect(parseTags("123")).toEqual({});
		expect(parseTags("true")).toEqual({});
	});
});
