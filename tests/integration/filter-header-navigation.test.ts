import { describe, it } from "node:test";
import { resolveSearchHorizontalNavigation } from "../../src/ui/components/filter-header.ts";
import { expect } from "../support/test-utils.ts";

describe("resolveSearchHorizontalNavigation", () => {
	it("cycles immediately when search is empty", () => {
		expect(resolveSearchHorizontalNavigation(0, 0, "left")).toBe("cycle-prev");
		expect(resolveSearchHorizontalNavigation(0, 0, "right")).toBe("cycle-next");
	});

	it("cycles prev only when cursor is at the start boundary", () => {
		expect(resolveSearchHorizontalNavigation(6, -6, "left")).toBe("cycle-prev");
		expect(resolveSearchHorizontalNavigation(6, -5, "left")).toBe("stay");
	});

	it("cycles next only when cursor is at the end boundary", () => {
		expect(resolveSearchHorizontalNavigation(6, 0, "right")).toBe("cycle-next");
		expect(resolveSearchHorizontalNavigation(6, -1, "right")).toBe("stay");
	});
});
