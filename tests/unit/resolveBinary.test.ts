import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { expect } from "../support/test-utils.ts";

const require = createRequire(import.meta.url);
const { getPackageName } = require("../../scripts/resolveBinary.cjs");

describe("getPackageName", () => {
	it("maps win32 platform to windows package", () => {
		expect(getPackageName("win32", "x64")).toBe("agent-roadmap-windows-x64");
	});

	it("returns linux name unchanged", () => {
		expect(getPackageName("linux", "arm64")).toBe("agent-roadmap-linux-arm64");
	});
});
