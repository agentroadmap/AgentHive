import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	decodeIntent,
	encodeIntent,
	extractHumanText,
	formatIntent,
	INTENT_PREFIX,
	type NegotiationIntent,
} from "../../src/types/intents.ts";

describe("Negotiation Intents", () => {
	test("encodeIntent produces valid payload", () => {
		const intent: NegotiationIntent = {
			type: "claim_request",
			proposalId: "proposal-9",
			from: "Opus",
			to: "Gemini",
			reason: "I have expertise in messaging",
		};

		const encoded = encodeIntent(intent);
		assert.ok(
			encoded.startsWith(INTENT_PREFIX),
			"should start with intent prefix",
		);
		assert.ok(
			encoded.includes('"type":"claim_request"'),
			"should contain type",
		);
		assert.ok(
			encoded.includes('"proposalId":"proposal-9"'),
			"should contain proposalId",
		);
		assert.ok(encoded.includes('"from":"Opus"'), "should contain from");
		assert.ok(encoded.includes('"to":"Gemini"'), "should contain to");
	});

	test("decodeIntent parses valid payload", () => {
		const intent: NegotiationIntent = {
			type: "handoff",
			proposalId: "proposal-6",
			from: "Gemini",
			to: "Copilot",
			reason: "Busy with proposal-9",
		};

		const encoded = encodeIntent(intent);
		const decoded = decodeIntent(encoded);

		assert.equal(decoded?.type, "handoff");
		assert.equal(decoded?.proposalId, "proposal-6");
		assert.equal(decoded?.from, "Gemini");
		assert.equal(decoded?.to, "Copilot");
		assert.equal(decoded?.reason, "Busy with proposal-9");
	});

	test("decodeIntent returns null for plain text", () => {
		assert.equal(decodeIntent("Just a regular message"), null);
		assert.equal(decodeIntent("No intent here"), null);
	});

	test("decodeIntent returns null for malformed payload", () => {
		assert.equal(decodeIntent("__intent__:not-json"), null);
		assert.equal(decodeIntent("__intent__:{invalid}"), null);
	});

	test("extractHumanText removes intent prefix", () => {
		const text = `${INTENT_PREFIX}{"type":"reject","proposalId":"proposal-5","from":"Opus"}\nSorry, can't take this one`;
		const humanText = extractHumanText(text);
		assert.equal(humanText, "Sorry, can't take this one");
	});

	test("extractHumanText returns original for plain text", () => {
		const text = "Just a regular message";
		assert.equal(extractHumanText(text), text);
	});

	test("formatIntent produces readable output", () => {
		const claimReq: NegotiationIntent = {
			type: "claim_request",
			proposalId: "proposal-9",
			from: "Opus",
		};
		assert.ok(formatIntent(claimReq).includes("Claim Request"));
		assert.ok(formatIntent(claimReq).includes("proposal-9"));

		const handoff: NegotiationIntent = {
			type: "handoff",
			proposalId: "proposal-6",
			from: "Gemini",
			to: "Copilot",
			reason: "Out of scope",
		};
		assert.ok(formatIntent(handoff).includes("Handoff"));
		assert.ok(formatIntent(handoff).includes("@Copilot"));
		assert.ok(formatIntent(handoff).includes("Out of scope"));

		const reject: NegotiationIntent = {
			type: "reject",
			proposalId: "proposal-5",
			from: "Copilot",
			reason: "No capability",
		};
		assert.ok(formatIntent(reject).includes("Reject"));
		assert.ok(formatIntent(reject).includes("No capability"));
	});

	test("roundtrip encode/decode preserves all fields", () => {
		const original: NegotiationIntent = {
			type: "block",
			proposalId: "proposal-10",
			from: "System",
			to: "All",
			reason: "Dependency missing",
			timestamp: "2026-03-20T12:00:00Z",
		};

		const encoded = encodeIntent(original);
		const decoded = decodeIntent(encoded);

		assert.deepEqual(decoded, original);
	});

	test("message with intent and human text", () => {
		const intent: NegotiationIntent = {
			type: "claim_request",
			proposalId: "proposal-11",
			from: "Opus",
		};

		const encoded = encodeIntent(intent);
		const fullMessage = `${encoded}\nI'd like to work on this because I have research experience.`;

		const decoded = decodeIntent(fullMessage);
		const humanText = extractHumanText(fullMessage);

		assert.equal(decoded?.type, "claim_request");
		assert.equal(decoded?.proposalId, "proposal-11");
		assert.ok(humanText.includes("research experience"));
	});
});
