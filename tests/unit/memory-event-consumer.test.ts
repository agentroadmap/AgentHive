/**
 * P194: Unit tests for MemoryEventConsumer.processEvent() routing logic.
 *
 * All tests inject a mock MemoryService — no live DB, no LISTEN connection.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryEventConsumer } from "../../src/memory/memory-event-consumer.ts";
import type { ProposalEventRow } from "../../src/memory/memory-event-consumer.ts";
import type { MemoryLayer } from "../../src/memory/memory_service.ts";

// ── Mock MemoryService ────────────────────────────────────────────────────────

interface AgentMemoryCall {
  agentIdentity: string;
  layer: MemoryLayer;
  key: string;
  value: unknown;
  ttlSeconds?: number;
}

interface ProjectMemoryCall {
  key: string;
  category: string;
  content: Record<string, unknown>;
  updatedBy?: string;
}

class MockMemoryService {
  agentCalls: AgentMemoryCall[] = [];
  projectCalls: ProjectMemoryCall[] = [];
  projectStore: Record<string, Record<string, unknown>> = {};

  async setAgentMemory(
    agentIdentity: string,
    layer: MemoryLayer,
    key: string,
    value: unknown,
    ttlSeconds?: number,
  ): Promise<void> {
    this.agentCalls.push({ agentIdentity, layer, key, value, ttlSeconds });
  }

  async getProjectMemory(key: string): Promise<Record<string, unknown> | null> {
    return this.projectStore[key] ?? null;
  }

  async setProjectMemory(
    key: string,
    category: string,
    content: Record<string, unknown>,
    updatedBy?: string,
  ): Promise<void> {
    this.projectCalls.push({ key, category, content, updatedBy });
    this.projectStore[key] = content;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(
  event_type: string,
  payload: Record<string, unknown> = {},
  proposal_id = "42",
): ProposalEventRow {
  return {
    id: "1",
    proposal_id,
    event_type,
    payload,
    created_at: new Date("2026-06-02T10:00:00Z"),
  };
}

function makeConsumer(): { consumer: MemoryEventConsumer; mock: MockMemoryService } {
  const mock = new MockMemoryService();
  const consumer = new MemoryEventConsumer(mock as never);
  return { consumer, mock };
}

// ── lease_claimed / lease_released ────────────────────────────────────────────

describe("lease_claimed", () => {
  it("writes episodic memory for the claiming agent", async () => {
    const { consumer, mock } = makeConsumer();
    await consumer.processEvent(
      makeEvent("lease_claimed", { agent: "claude/worker-1", expires_at: "2026-06-02T12:00:00Z" }),
    );
    assert.equal(mock.agentCalls.length, 1);
    const call = mock.agentCalls[0]!;
    assert.equal(call.agentIdentity, "claude/worker-1");
    assert.equal(call.layer, "episodic");
    assert.ok(call.key.startsWith("lease_claimed:p42"));
    assert.equal(call.ttlSeconds, 86_400);
  });

  it("skips write when agent field is absent", async () => {
    const { consumer, mock } = makeConsumer();
    await consumer.processEvent(makeEvent("lease_claimed", {}));
    assert.equal(mock.agentCalls.length, 0);
  });
});

describe("lease_released", () => {
  it("writes episodic memory for the releasing agent", async () => {
    const { consumer, mock } = makeConsumer();
    await consumer.processEvent(
      makeEvent("lease_released", { agent: "claude/worker-2", release_reason: "done" }),
    );
    assert.equal(mock.agentCalls.length, 1);
    const call = mock.agentCalls[0]!;
    assert.equal(call.agentIdentity, "claude/worker-2");
    assert.equal(call.layer, "episodic");
    assert.ok(call.key.startsWith("lease_released:p42"));
  });
});

// ── status_changed ────────────────────────────────────────────────────────────

describe("status_changed", () => {
  it("appends to events:recent_transitions in project_memory", async () => {
    const { consumer, mock } = makeConsumer();
    await consumer.processEvent(
      makeEvent("status_changed", { from: "DRAFT", to: "REVIEW", agent: "operator" }),
    );
    assert.equal(mock.projectCalls.length, 1);
    const call = mock.projectCalls[0]!;
    assert.equal(call.key, "events:recent_transitions");
    assert.equal(call.category, "workflow");
    const items = call.content["items"] as unknown[];
    assert.equal(items.length, 1);
    assert.equal((items[0] as Record<string, unknown>)["event_type"], "status_changed");
  });

  it("prepends new events and caps at 20", async () => {
    const { consumer, mock } = makeConsumer();
    // Pre-fill with 20 existing items
    const existing = Array.from({ length: 20 }, (_, i) => ({ proposal_id: String(i) }));
    mock.projectStore["events:recent_transitions"] = { items: existing };

    await consumer.processEvent(makeEvent("status_changed", { from: "REVIEW", to: "DEVELOP" }));
    const stored = mock.projectStore["events:recent_transitions"] as { items: unknown[] };
    assert.equal(stored.items.length, 20, "must not exceed MAX_RECENT");
    // newest item is first
    const newest = stored.items[0] as Record<string, unknown>;
    assert.equal(newest["proposal_id"], "42");
  });
});

// ── decision_made ─────────────────────────────────────────────────────────────

describe("decision_made", () => {
  it("appends to events:recent_decisions", async () => {
    const { consumer, mock } = makeConsumer();
    await consumer.processEvent(makeEvent("decision_made", { verdict: "approve" }));
    assert.equal(mock.projectCalls[0]!.key, "events:recent_decisions");
  });
});

// ── maturity_changed ──────────────────────────────────────────────────────────

describe("maturity_changed", () => {
  it("appends to events:recent_maturity_changes", async () => {
    const { consumer, mock } = makeConsumer();
    await consumer.processEvent(makeEvent("maturity_changed", { from: "new", to: "active" }));
    assert.equal(mock.projectCalls[0]!.key, "events:recent_maturity_changes");
  });
});

// ── proposal_created ──────────────────────────────────────────────────────────

describe("proposal_created", () => {
  it("appends to events:recent_proposals", async () => {
    const { consumer, mock } = makeConsumer();
    await consumer.processEvent(makeEvent("proposal_created", { title: "New proposal" }));
    assert.equal(mock.projectCalls[0]!.key, "events:recent_proposals");
  });
});

// ── review_submitted ──────────────────────────────────────────────────────────

describe("review_submitted", () => {
  it("writes episodic memory for the reviewer and appends project event", async () => {
    const { consumer, mock } = makeConsumer();
    await consumer.processEvent(
      makeEvent("review_submitted", { reviewer: "skeptic-alpha", verdict: "approve" }),
    );
    assert.equal(mock.agentCalls.length, 1);
    assert.equal(mock.agentCalls[0]!.agentIdentity, "skeptic-alpha");
    assert.equal(mock.agentCalls[0]!.layer, "episodic");
    assert.equal(mock.projectCalls.length, 1);
    assert.equal(mock.projectCalls[0]!.key, "events:recent_reviews");
  });

  it("still writes project event when reviewer field is absent", async () => {
    const { consumer, mock } = makeConsumer();
    await consumer.processEvent(makeEvent("review_submitted", { verdict: "defer" }));
    assert.equal(mock.agentCalls.length, 0, "no agent write without reviewer");
    assert.equal(mock.projectCalls.length, 1, "project event still written");
  });
});

// ── no-op events ─────────────────────────────────────────────────────────────

describe("unhandled event types", () => {
  it("does not throw on dependency_added", async () => {
    const { consumer, mock } = makeConsumer();
    await assert.doesNotReject(
      consumer.processEvent(makeEvent("dependency_added", {})),
    );
    assert.equal(mock.agentCalls.length, 0);
    assert.equal(mock.projectCalls.length, 0);
  });

  it("does not throw on milestone_achieved", async () => {
    const { consumer, mock } = makeConsumer();
    await assert.doesNotReject(
      consumer.processEvent(makeEvent("milestone_achieved", {})),
    );
  });
});

// ── Error resilience ──────────────────────────────────────────────────────────

describe("error resilience", () => {
  it("does not throw when MemoryService.setAgentMemory rejects", async () => {
    const mock = new MockMemoryService();
    mock.setAgentMemory = async () => { throw new Error("DB down"); };
    const consumer = new MemoryEventConsumer(mock as never);
    await assert.doesNotReject(
      consumer.processEvent(makeEvent("lease_claimed", { agent: "worker-1" })),
    );
  });

  it("does not throw when MemoryService.setProjectMemory rejects", async () => {
    const mock = new MockMemoryService();
    mock.setProjectMemory = async () => { throw new Error("DB down"); };
    const consumer = new MemoryEventConsumer(mock as never);
    await assert.doesNotReject(
      consumer.processEvent(makeEvent("status_changed", { from: "DRAFT", to: "REVIEW" })),
    );
  });
});
