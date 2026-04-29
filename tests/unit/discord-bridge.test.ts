/**
 * Unit tests for the Discord Bridge (P221).
 *
 * Tests pure logic only — no DB, no real Discord connection.
 * AC-6: DiscordRateLimiter enforces 50 req/s per channel
 * AC-8: MessageFormatter converts AgentHive message to Discord embed
 */

import assert from "node:assert";
import { describe, it } from "node:test";

import { DiscordRateLimiter } from "../../src/apps/discord-bridge/rate-limiter.ts";
import {
	formatMessageEmbed,
	type AgentiveMessage,
} from "../../src/apps/discord-bridge/message-formatter.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMsg(overrides: Partial<AgentiveMessage> = {}): AgentiveMessage {
	return {
		id: "42",
		channel: "broadcast",
		from_agent: "orchestrator",
		to_agent: null,
		message_content: "Hello AgentHive!",
		message_type: "status",
		proposal_id: null,
		title: null,
		created_at: "2026-04-29T00:00:00.000Z",
		...overrides,
	};
}

// ─── MessageFormatter (AC-8) ─────────────────────────────────────────────────

describe("MessageFormatter — formatMessageEmbed", () => {
	it("returns an embed with description from message_content", () => {
		const embed = formatMessageEmbed(makeMsg());
		assert.strictEqual(embed.description, "Hello AgentHive!");
	});

	it("includes From and Channel fields", () => {
		const embed = formatMessageEmbed(makeMsg());
		const names = embed.fields.map((f) => f.name);
		assert.ok(names.includes("From"), "embed should have From field");
		assert.ok(names.includes("Channel"), "embed should have Channel field");
	});

	it("sets From field value to from_agent", () => {
		const embed = formatMessageEmbed(makeMsg({ from_agent: "agent-007" }));
		const from = embed.fields.find((f) => f.name === "From");
		assert.strictEqual(from?.value, "agent-007");
	});

	it("sets Channel field value", () => {
		const embed = formatMessageEmbed(makeMsg({ channel: "team:engineering" }));
		const ch = embed.fields.find((f) => f.name === "Channel");
		assert.strictEqual(ch?.value, "team:engineering");
	});

	it("includes footer with message ID", () => {
		const embed = formatMessageEmbed(makeMsg({ id: "99" }));
		assert.ok(embed.footer?.text.includes("99"), "footer should contain message ID");
	});

	it("includes Proposal field when proposal_id is set", () => {
		const embed = formatMessageEmbed(makeMsg({ proposal_id: "P221" }));
		const proposalField = embed.fields.find((f) => f.name === "Proposal");
		assert.ok(proposalField, "embed should have Proposal field");
		assert.strictEqual(proposalField?.value, "P221");
	});

	it("omits Proposal field when proposal_id is null", () => {
		const embed = formatMessageEmbed(makeMsg({ proposal_id: null }));
		const proposalField = embed.fields.find((f) => f.name === "Proposal");
		assert.strictEqual(proposalField, undefined);
	});

	it("uses message_type for title when title is absent", () => {
		const embed = formatMessageEmbed(makeMsg({ message_type: "escalation" }));
		assert.strictEqual(embed.title, "ESCALATION");
	});

	it("uses explicit title when present", () => {
		const embed = formatMessageEmbed(makeMsg({ title: "Critical Alert" }));
		assert.strictEqual(embed.title, "Critical Alert");
	});

	it("colors escalation messages red", () => {
		const embed = formatMessageEmbed(makeMsg({ message_type: "escalation" }));
		assert.strictEqual(embed.color, 0xff0000);
	});

	it("colors gate_decision messages blue", () => {
		const embed = formatMessageEmbed(makeMsg({ message_type: "gate_decision" }));
		assert.strictEqual(embed.color, 0x0000ff);
	});

	it("uses gray for unknown message types", () => {
		const embed = formatMessageEmbed(makeMsg({ message_type: "unknown_type" }));
		assert.strictEqual(embed.color, 0x808080);
	});

	it("truncates message_content longer than 4096 chars", () => {
		const longContent = "x".repeat(5000);
		const embed = formatMessageEmbed(makeMsg({ message_content: longContent }));
		assert.ok(
			embed.description.length <= 4096,
			`description length ${embed.description.length} exceeds 4096`,
		);
	});
});

// ─── DiscordRateLimiter (AC-6) ────────────────────────────────────────────────

describe("DiscordRateLimiter — token bucket", () => {
	it("allows up to maxTokens requests immediately", () => {
		const rl = new DiscordRateLimiter(5, 1000);
		for (let i = 0; i < 5; i++) {
			assert.strictEqual(rl.allow("ch1"), true, `request ${i + 1} should be allowed`);
		}
	});

	it("blocks requests once tokens are exhausted", () => {
		const rl = new DiscordRateLimiter(3, 1000);
		rl.allow("ch1");
		rl.allow("ch1");
		rl.allow("ch1");
		assert.strictEqual(rl.allow("ch1"), false, "4th request should be blocked");
	});

	it("tracks separate buckets per channel", () => {
		const rl = new DiscordRateLimiter(1, 1000);
		assert.strictEqual(rl.allow("ch1"), true);
		assert.strictEqual(rl.allow("ch1"), false); // exhausted
		assert.strictEqual(rl.allow("ch2"), true); // separate bucket
	});

	it("starts new channels with full token bucket", () => {
		const rl = new DiscordRateLimiter(50, 1000);
		assert.strictEqual(rl.allow("fresh-channel"), true);
	});

	it("getRemaining returns full bucket for unseen channel", () => {
		const rl = new DiscordRateLimiter(50, 1000);
		assert.strictEqual(rl.getRemaining("unseen"), 50);
	});

	it("getRemaining decrements after allow()", () => {
		const rl = new DiscordRateLimiter(10, 1000);
		rl.allow("ch");
		const remaining = rl.getRemaining("ch");
		assert.ok(remaining < 10, "remaining should be less than max after one request");
	});

	it("size reports number of tracked channels", () => {
		const rl = new DiscordRateLimiter(10, 1000);
		rl.allow("ch1");
		rl.allow("ch2");
		assert.strictEqual(rl.size, 2);
	});

	it("default constructor uses 50 tokens / 1s", () => {
		const rl = new DiscordRateLimiter();
		let allowed = 0;
		for (let i = 0; i < 60; i++) {
			if (rl.allow("ch")) allowed++;
		}
		assert.strictEqual(allowed, 50, "exactly 50 tokens should be available initially");
	});
});

// ─── Relay logic (AC-5: queue on rate limit, AC-7: retry) ────────────────────
// These are tested via the pure building blocks above; end-to-end relay requires
// a live DB + Discord token and lives in tests/integration/discord-a2a-bridge.test.ts
