import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatAgentLabelLive } from "../../src/shared/ui/format-agent-label.ts";

const HOST_IDS = ["bot", "mac", "hermes", "srv"];

describe("formatAgentLabelLive", () => {
	it("snapshot: 3-segment alias with known host strips middle segment", () => {
		const result = formatAgentLabelLive(
			{ display_alias: "Claude-Bot-Documenter", agent_identity: "ccs46ant-bot-docum-a" },
			HOST_IDS,
		);
		assert.equal(result, "Claude-Documenter (ccs46ant-bot-docum-a)");
	});

	it("NULL alias passthrough: renders raw identity with no parens", () => {
		const result = formatAgentLabelLive(
			{ display_alias: null, agent_identity: "ccs46ant-bot-docum-a" },
			HOST_IDS,
		);
		assert.equal(result, "ccs46ant-bot-docum-a");
	});

	it("Tier 1 (2-segment) alias: returned unchanged with identity in parens", () => {
		const result = formatAgentLabelLive(
			{ display_alias: "Claude-Bot", agent_identity: "ccs46ant-bot-a" },
			HOST_IDS,
		);
		assert.equal(result, "Claude-Bot (ccs46ant-bot-a)");
	});

	it("unknown host: alias rendered verbatim with identity in parens", () => {
		const result = formatAgentLabelLive(
			{ display_alias: "Claude-NewHost-Documenter", agent_identity: "ccs46ant-newhost-docum-a" },
			HOST_IDS,
		);
		assert.equal(result, "Claude-NewHost-Documenter (ccs46ant-newhost-docum-a)");
	});

	it("hyphenated role: Claude-Bot-GateReview strips host correctly", () => {
		const result = formatAgentLabelLive(
			{ display_alias: "Claude-Bot-GateReview", agent_identity: "ccs46ant-bot-gate-a" },
			HOST_IDS,
		);
		assert.equal(result, "Claude-GateReview (ccs46ant-bot-gate-a)");
	});

	it("newly added host: after adding to hostIds the alias strips correctly", () => {
		const withNewHost = [...HOST_IDS, "newhost"];
		const result = formatAgentLabelLive(
			{ display_alias: "Claude-NewHost-Documenter", agent_identity: "ccs46ant-newhost-docum-a" },
			withNewHost,
		);
		assert.equal(result, "Claude-Documenter (ccs46ant-newhost-docum-a)");
	});
});
