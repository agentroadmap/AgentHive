import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { opsMatch } from "../../src/infra/agency/tool-grant.ts";

describe("opsMatch — P599 AC-5", () => {
	it("exact match passes", () => {
		assert.equal(opsMatch(["proposal:read", "proposal:write"], "proposal:read"), true);
	});

	it("exact match fails when op not in granted list", () => {
		assert.equal(opsMatch(["proposal:read"], "proposal:write"), false);
	});

	it("wildcard prefix pass: proposal:* matches proposal:read", () => {
		assert.equal(opsMatch(["proposal:*"], "proposal:read"), true);
	});

	it("wildcard prefix fail: proposal:* does not match agent:read", () => {
		assert.equal(opsMatch(["proposal:*"], "agent:read"), false);
	});

	// Bonus edge cases to make the semantics crystal clear
	it("empty granted list always returns false", () => {
		assert.equal(opsMatch([], "proposal:read"), false);
	});

	it("wildcard pass: mcp_agent:* matches mcp_agent:spawn", () => {
		assert.equal(opsMatch(["mcp_agent:*"], "mcp_agent:spawn"), true);
	});

	it("wildcard does not bleed across namespace boundary", () => {
		assert.equal(opsMatch(["git:*"], "gh:pr"), false);
	});
});
