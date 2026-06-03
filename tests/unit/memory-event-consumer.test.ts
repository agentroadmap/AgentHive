import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	classifyMemoryEvent,
	type MemoryEvent,
	mergeRecentEvents,
} from "../../src/memory/memory-event-consumer.ts";

const at = new Date("2026-05-26T01:00:00.000Z");

function event(overrides: Partial<MemoryEvent>): MemoryEvent {
	return {
		source: "proposal_event",
		source_id: 1,
		proposal_id: 194,
		event_type: "proposal_created",
		payload: {},
		created_at: at,
		...overrides,
	};
}

describe("memory event consumer classification", () => {
	it("routes proposal transitions and gate decisions to workflow memory", () => {
		assert.deepEqual(
			classifyMemoryEvent(event({ event_type: "status_changed" })),
			{
				bucket: "transition",
				projectKey: "recent_transitions",
				category: "workflow",
			},
		);

		assert.deepEqual(
			classifyMemoryEvent(
				event({
					source: "gate_decision_log",
					source_id: 4,
					event_type: "gate_decision",
				}),
			),
			{
				bucket: "transition",
				projectKey: "recent_transitions",
				category: "workflow",
			},
		);
	});

	it("routes dispatch, run, and liaison events to agent episodic memory", () => {
		assert.deepEqual(
			classifyMemoryEvent(
				event({
					source: "squad_dispatch",
					source_id: 12,
					event_type: "dispatch_event",
					payload: { agent_identity: "cdgp5oai-bot-devel-a" },
				}),
			),
			{
				bucket: "agent_episodic",
				agentIdentity: "cdgp5oai-bot-devel-a",
			},
		);

		assert.deepEqual(
			classifyMemoryEvent(
				event({
					source: "liaison_message",
					source_id: "7b8b5f2e-15f6-4b9f-8d30-59d454051111",
					event_type: "liaison_heartbeat",
					payload: { agency_id: "codex-agency-bot" },
				}),
			),
			{
				bucket: "agent_episodic",
				agentIdentity: "codex-agency-bot",
			},
		);
	});

	it("routes route and budget audit rows to project decision memory", () => {
		assert.deepEqual(
			classifyMemoryEvent(
				event({
					source: "dispatch_route_audit",
					source_id: 9,
					event_type: "route_decision",
				}),
			),
			{
				bucket: "route_decision",
				projectKey: "route_decisions",
				category: "workflow",
			},
		);

		assert.deepEqual(
			classifyMemoryEvent(
				event({
					source: "agent_budget_ledger",
					source_id: 10,
					event_type: "budget_decision",
				}),
			),
			{
				bucket: "budget_decision",
				projectKey: "budget_decisions",
				category: "workflow",
			},
		);
	});
});

describe("mergeRecentEvents", () => {
	it("deduplicates replayed source rows and preserves bounded recency", () => {
		const existing = {
			activities: [
				{ source: "proposal_event", source_id: 1, event_type: "old" },
				{ source: "proposal_event", source_id: 2, event_type: "keep" },
			],
		};

		const merged = mergeRecentEvents(
			existing,
			"activities",
			{ source: "proposal_event", source_id: 1, event_type: "new" },
			2,
		);

		assert.deepEqual(merged, {
			activities: [
				{ source: "proposal_event", source_id: 1, event_type: "new" },
				{ source: "proposal_event", source_id: 2, event_type: "keep" },
			],
		});
	});
});
