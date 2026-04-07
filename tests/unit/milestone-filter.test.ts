import assert from "node:assert";
import { describe, it } from "node:test";
import {
	createDirectiveFilterValueResolver,
	normalizeDirectiveFilterValue,
	resolveClosestDirectiveFilterValue,
} from "../../src/utils/milestone-filter.ts";
import { expect } from "../support/test-utils.ts";

describe("directive filter matching", () => {
	it("normalizes punctuation and case", () => {
		expect(normalizeDirectiveFilterValue("  Release-1 / Alpha ")).toBe(
			"release 1 alpha",
		);
	});

	it("returns exact normalized directive when available", () => {
		const resolved = resolveClosestDirectiveFilterValue("RELEASE-1", [
			"Release-1",
			"Roadmap Alpha",
		]);
		assert.strictEqual(resolved, "release 1");
	});

	it("returns closest directive for typo input", () => {
		const resolved = resolveClosestDirectiveFilterValue("releas-1", [
			"Release-1",
			"Release-2",
			"Roadmap Alpha",
		]);
		assert.strictEqual(resolved, "release 1");
	});

	it("returns closest directive for partial input", () => {
		const resolved = resolveClosestDirectiveFilterValue("roadmp", [
			"Release-1",
			"Roadmap Alpha",
		]);
		assert.strictEqual(resolved, "roadmap alpha");
	});

	it("resolves directive IDs to titles for filtering", () => {
		const resolveDirective = createDirectiveFilterValueResolver([
			{
				id: "m-7",
				title: "New Directives UI",
				description: "",
				rawContent: "",
			},
		]);

		expect(resolveDirective("m-7")).toBe("New Directives UI");
		expect(resolveDirective("7")).toBe("New Directives UI");
		expect(resolveDirective("New Directives UI")).toBe("New Directives UI");
		expect(resolveDirective("m-99")).toBe("m-99");
	});
});
