import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatAgentLabelLive } from "./format-agent-label.ts";

const BOT_HOSTS = ["bot", "mac", "hermes"];

describe("formatAgentLabelLive", () => {
	test("TC-1: strips known host from 3-part alias", () => {
		const result = formatAgentLabelLive(
			{ display_alias: "Claude-Bot-Documenter", agent_identity: "ccs46ant-bot-docum-a" },
			{ knownHosts: BOT_HOSTS },
		);
		assert.equal(result, "Claude-Documenter (ccs46ant-bot-docum-a)");
	});

	test("TC-2: NULL alias passes through as raw identity (regression guard)", () => {
		const identity = "ccs46ant-bot-docum-a";
		const result = formatAgentLabelLive(
			{ display_alias: null, agent_identity: identity },
			{ knownHosts: BOT_HOSTS },
		);
		assert.equal(result, identity);
	});

	test("TC-3: 2-part alias (Tier 1) rendered unchanged with identity in parens", () => {
		const result = formatAgentLabelLive(
			{ display_alias: "Claude-Bot", agent_identity: "ccs46ant-bot-a" },
			{ knownHosts: BOT_HOSTS },
		);
		assert.equal(result, "Claude-Bot (ccs46ant-bot-a)");
	});

	test("TC-4: unknown host in middle renders verbatim until host is added to list", () => {
		const result = formatAgentLabelLive(
			{ display_alias: "Claude-NewHost-Documenter", agent_identity: "ccs46ant-newh-docum-a" },
			{ knownHosts: BOT_HOSTS },
		);
		assert.equal(result, "Claude-NewHost-Documenter (ccs46ant-newh-docum-a)");

		// After NewHost is added to the list, stripping kicks in without a code change.
		const resultAfterAdd = formatAgentLabelLive(
			{ display_alias: "Claude-NewHost-Documenter", agent_identity: "ccs46ant-newh-docum-a" },
			{ knownHosts: [...BOT_HOSTS, "newhost"] },
		);
		assert.equal(resultAfterAdd, "Claude-Documenter (ccs46ant-newh-docum-a)");
	});

	test("TC-5: hyphenated role stripped correctly", () => {
		const result = formatAgentLabelLive(
			{ display_alias: "Claude-Bot-GateReview", agent_identity: "ccs46ant-bot-gate-a" },
			{ knownHosts: BOT_HOSTS },
		);
		assert.equal(result, "Claude-GateReview (ccs46ant-bot-gate-a)");
	});

	test("TC-6: host matching is case-insensitive", () => {
		const result = formatAgentLabelLive(
			{ display_alias: "Claude-BOT-Documenter", agent_identity: "ccs46ant-bot-docum-a" },
			{ knownHosts: ["bot"] },
		);
		assert.equal(result, "Claude-Documenter (ccs46ant-bot-docum-a)");
	});

	test("TC-7: empty knownHosts disables stripping (alias shown verbatim with identity)", () => {
		const result = formatAgentLabelLive(
			{ display_alias: "Claude-Bot-Documenter", agent_identity: "ccs46ant-bot-docum-a" },
			{ knownHosts: [] },
		);
		assert.equal(result, "Claude-Bot-Documenter (ccs46ant-bot-docum-a)");
	});

	test("TC-8: missing opts defaults to no stripping (same as empty knownHosts)", () => {
		const result = formatAgentLabelLive({
			display_alias: "Claude-Bot-Documenter",
			agent_identity: "ccs46ant-bot-docum-a",
		});
		assert.equal(result, "Claude-Bot-Documenter (ccs46ant-bot-docum-a)");
	});
});
