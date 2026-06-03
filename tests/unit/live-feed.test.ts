import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	chooseFeedActor,
	dedupeBoardLiveFeed,
	timestampToMillis,
} from "../../src/apps/ui/live-feed.ts";
import type { StreamEvent } from "../../src/core/messaging/event-stream.ts";

describe("dedupeBoardLiveFeed", () => {
	it("removes duplicate logical events while keeping order", () => {
		const events: StreamEvent[] = [
			{
				id: "1",
				type: "message",
				timestamp: 1000,
				proposalId: "P237",
				agentId: "codex-one",
				message: "P237 codex-one completed design",
				metadata: {},
			},
			{
				id: "2",
				type: "message",
				timestamp: 1001,
				proposalId: "P237",
				agentId: "codex-one",
				message: "P237 codex-one completed design",
				metadata: {},
			},
			{
				id: "3",
				type: "message",
				timestamp: 1002,
				proposalId: "P238",
				agentId: "codex-one",
				message: "P238 codex-one completed design",
				metadata: {},
			},
		];

		const deduped = dedupeBoardLiveFeed(events);

		assert.equal(deduped.length, 2);
		assert.equal(deduped[0]?.id, "1");
		assert.equal(deduped[1]?.id, "3");
	});

	it("parses postgres numeric timestamps correctly", () => {
		const millis = timestampToMillis("1744898052783.000");
		assert.equal(millis, 1744898052783);
	});
});

describe("chooseFeedActor", () => {
	it("keeps explicit non-system actors", () => {
		assert.equal(chooseFeedActor("gary", "claude"), "gary");
	});

	it("uses a correlated lease actor for system maturity transitions", () => {
		assert.equal(chooseFeedActor("system", "claude"), "claude");
	});

	it("falls back to system when no better actor exists", () => {
		assert.equal(chooseFeedActor("system", null), "system");
	});
});
