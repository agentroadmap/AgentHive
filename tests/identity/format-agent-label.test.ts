/**
 * P933: formatAgentLabelLive — display alias rendering with DB-driven host strip
 *
 * AC-1: 3-segment alias, known host → host stripped, identity in parens
 * AC-2: NULL alias passthrough — byte-for-byte identical to pre-change format
 * AC-3: 2-segment (Tier 1) alias → no strip
 * AC-4: Unknown host → verbatim alias (no strip); strip activates after DB update only
 * AC-5: Hyphenated role variant
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	formatAgentLabelLive,
	formatAgentLabelShort,
} from "../../src/shared/ui/format-agent-label.ts";

const KNOWN_HOSTS = ["bot", "mac", "hermes", "srv"];

// AC-1: snapshot test — the canonical P933 example
test("AC-1: Claude-Bot-Documenter renders as Claude-Documenter (identity)", () => {
	const result = formatAgentLabelLive(
		{ display_alias: "Claude-Bot-Documenter", agent_identity: "ccs46ant-bot-docum-a" },
		KNOWN_HOSTS,
	);
	assert.strictEqual(result, "Claude-Documenter (ccs46ant-bot-docum-a)");
});

// AC-2: NULL alias — must be byte-for-byte the raw identity
test("AC-2: NULL alias passthrough is identical to pre-change format", () => {
	const identity = "ccs46ant-bot-docum-a";
	const result = formatAgentLabelLive(
		{ display_alias: null, agent_identity: identity },
		KNOWN_HOSTS,
	);
	assert.strictEqual(result, identity);
});

test("AC-2: undefined alias passthrough is identical to pre-change format", () => {
	const identity = "ccs46ant-bot-docum-a";
	const result = formatAgentLabelLive(
		{ agent_identity: identity },
		KNOWN_HOSTS,
	);
	assert.strictEqual(result, identity);
});

// AC-3: 2-segment (Tier 1) alias — no host strip even though middle word is a host name
test("AC-3: Tier 1 alias Claude-Bot is unchanged (2 segments, nothing to strip)", () => {
	const result = formatAgentLabelLive(
		{ display_alias: "Claude-Bot", agent_identity: "ccs46ant-bot-a" },
		KNOWN_HOSTS,
	);
	assert.strictEqual(result, "Claude-Bot (ccs46ant-bot-a)");
});

// AC-4: Unknown host — alias renders verbatim (no strip) until NewHost is in DB
test("AC-4: Claude-NewHost-Documenter renders verbatim when NewHost not in knownHosts", () => {
	const result = formatAgentLabelLive(
		{ display_alias: "Claude-NewHost-Documenter", agent_identity: "ccs46ant-newhost-docum-a" },
		KNOWN_HOSTS,
	);
	assert.strictEqual(result, "Claude-NewHost-Documenter (ccs46ant-newhost-docum-a)");
});

test("AC-4: after NewHost added to DB knownHosts, host is stripped", () => {
	const result = formatAgentLabelLive(
		{ display_alias: "Claude-NewHost-Documenter", agent_identity: "ccs46ant-newhost-docum-a" },
		[...KNOWN_HOSTS, "newhost"],
	);
	assert.strictEqual(result, "Claude-Documenter (ccs46ant-newhost-docum-a)");
});

// AC-5: Hyphenated role
test("AC-5: Claude-Bot-GateReview renders as Claude-GateReview", () => {
	const result = formatAgentLabelLive(
		{ display_alias: "Claude-Bot-GateReview", agent_identity: "ccs46ant-bot-grvw-a" },
		KNOWN_HOSTS,
	);
	assert.strictEqual(result, "Claude-GateReview (ccs46ant-bot-grvw-a)");
});

// Host matching is case-insensitive (alias segment compared lowercased)
test("host matching is case-insensitive", () => {
	const result = formatAgentLabelLive(
		{ display_alias: "Claude-BOT-Documenter", agent_identity: "ccs46ant-bot-docum-a" },
		KNOWN_HOSTS,
	);
	assert.strictEqual(result, "Claude-Documenter (ccs46ant-bot-docum-a)");
});

// Empty knownHosts — no strip happens regardless of alias shape
test("empty knownHosts disables all host stripping", () => {
	const result = formatAgentLabelLive(
		{ display_alias: "Claude-Bot-Documenter", agent_identity: "ccs46ant-bot-docum-a" },
		[],
	);
	assert.strictEqual(result, "Claude-Bot-Documenter (ccs46ant-bot-docum-a)");
});

// formatAgentLabelShort — no identity suffix
test("formatAgentLabelShort strips host and omits identity parens", () => {
	const result = formatAgentLabelShort(
		{ display_alias: "Claude-Bot-Documenter", agent_identity: "ccs46ant-bot-docum-a" },
		{ knownHosts: KNOWN_HOSTS },
	);
	assert.strictEqual(result, "Claude-Documenter");
});

test("formatAgentLabelShort with NULL alias returns raw identity", () => {
	const result = formatAgentLabelShort(
		{ display_alias: null, agent_identity: "ccs46ant-bot-docum-a" },
		{ knownHosts: KNOWN_HOSTS },
	);
	assert.strictEqual(result, "ccs46ant-bot-docum-a");
});
