/**
 * P1456 tests: session-instance identity helpers.
 *
 * AC-12 — channel alignment: agentNotifyChannel(identity) must equal
 *          "msg_" + identity for valid session identities.
 * AC-18 — 63-byte channel limit: buildSessionIdentity() throws for
 *          agency+session combos that would produce an overlong channel.
 */

import { describe, it, expect } from "bun:test";
import {
	shortenSessionId,
	buildSessionIdentity,
} from "../../src/core/identity/session-instance.ts";
import { agentNotifyChannel } from "../../src/infra/messaging/a2a-access-control.ts";

// ── shortenSessionId ──────────────────────────────────────────────────────────

describe("shortenSessionId", () => {
	it("strips hyphens from a UUID and keeps first 8 alphanum chars", () => {
		const uuid = "7f3a2c1b-dead-beef-0000-111122223333";
		expect(shortenSessionId(uuid)).toBe("7f3a2c1b");
	});

	it("returns up to 8 chars when input is already pure alphanumeric", () => {
		expect(shortenSessionId("abcdef12345")).toBe("abcdef12");
	});

	it("returns empty string for an input with no alphanumeric chars", () => {
		expect(shortenSessionId("---")).toBe("");
	});

	it("handles short input without padding", () => {
		expect(shortenSessionId("abc")).toBe("abc");
	});
});

// ── buildSessionIdentity ── AC-12 ─────────────────────────────────────────────

describe("buildSessionIdentity — channel alignment (AC-12)", () => {
	it("produces identity that matches agentNotifyChannel output", () => {
		const agency = "claude.a";
		const rawSid = "7f3a2c1b-dead-beef-0000-111122223333";
		const identity = buildSessionIdentity(agency, rawSid);
		const channel = agentNotifyChannel(identity);
		// AC-12: the channel MUST be the msg_ prefix + raw identity
		expect(channel).toBe(`msg_${identity}`);
		expect(identity).toBe("claude.a/session/7f3a2c1b");
	});

	it("accepts typical codex agency identity", () => {
		const identity = buildSessionIdentity("codex.a", "deadbeef00000000");
		expect(identity).toBe("codex.a/session/deadbeef");
		expect(agentNotifyChannel(identity)).toBe("msg_codex.a/session/deadbeef");
	});

	it("throws when rawSessionId has no alphanumeric characters", () => {
		expect(() => buildSessionIdentity("claude.a", "---")).toThrow(
			/Cannot derive short session slug/,
		);
	});
});

// ── buildSessionIdentity ── AC-18 (63-byte limit) ────────────────────────────

describe("buildSessionIdentity — 63-byte channel limit (AC-18)", () => {
	it("succeeds for a channel exactly at the 63-byte limit", () => {
		// "msg_" = 4 bytes. 63 - 4 = 59 bytes for the identity.
		// identity = agency + "/session/" + 8 chars
		// "/session/" = 9 chars. So agency must be ≤ 42 chars (42+9+8=59).
		const agency = "a".repeat(42);
		const rawSid = "12345678abcdef";
		const identity = buildSessionIdentity(agency, rawSid);
		const channel = agentNotifyChannel(identity);
		expect(Buffer.byteLength(channel, "utf8")).toBeLessThanOrEqual(63);
	});

	it("throws when the composed channel name exceeds 63 bytes", () => {
		// Agency of 43 chars → identity = 43+9+8 = 60 bytes → channel = 64 bytes → reject
		const longAgency = "a".repeat(43);
		expect(() => buildSessionIdentity(longAgency, "12345678abcdef")).toThrow(
			/exceeds 63 bytes/,
		);
	});

	it("throws for agency identities containing disallowed characters", () => {
		// Spaces not in AGENT_IDENTITY_RE
		expect(() => buildSessionIdentity("my agency", "deadbeef")).toThrow(
			/only \[A-Za-z0-9/,
		);
	});
});
