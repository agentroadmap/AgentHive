/**
 * P194: MemoryEventConsumer — propagates roadmap_events pg_notify notifications
 * into project_memory and agent_memory without advancing proposal state.
 *
 * Design constraints (P194 §Boundaries):
 * - Does NOT advance proposal maturity or state.
 * - Updates are best-effort and fully asynchronous.
 * - Never imports or depends on gate_pipeline.ts.
 * - Consumes the same roadmap_events channel used by the dashboard WebSocket.
 */

import { getPool, query } from "../infra/postgres/pool.ts";
import { MemoryService } from "./memory_service.ts";
import type { PoolClient } from "pg";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ProposalEventRow {
  id: string;
  proposal_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

interface NotifyPayload {
  event_id: string;
  type: string;
  proposal: string;
}

// How many items to keep in each rolling project_memory window
const MAX_RECENT = 20;

// TTL for agent episodic memory entries (24 h)
const EPISODIC_TTL_S = 86_400;

// ── MemoryEventConsumer ────────────────────────────────────────────────────────

export class MemoryEventConsumer {
  private client: PoolClient | null = null;
  private stopping = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly memory: MemoryService;

  constructor(memory?: MemoryService) {
    this.memory = memory ?? new MemoryService();
  }

  /** Begin listening. Reconnects automatically on connection loss. */
  async start(): Promise<void> {
    if (this.stopping || this.client) return;
    try {
      const client = await getPool().connect();
      this.client = client;

      client.on("error", (err) => {
        console.error("[MemoryEventConsumer] listener error:", err.message);
        if (this.client === client) this.client = null;
        try { client.release(true); } catch { /* ignore */ }
        this.scheduleReconnect();
      });

      await client.query("LISTEN roadmap_events");

      client.on("notification", (n) => {
        if (n.channel !== "roadmap_events" || !n.payload) return;
        try {
          const parsed = JSON.parse(n.payload) as NotifyPayload;
          void this.fetchAndProcess(parsed);
        } catch {
          /* malformed payload — ignore */
        }
      });

      console.log("[MemoryEventConsumer] listening on roadmap_events");
    } catch (err) {
      console.warn("[MemoryEventConsumer] start failed:", (err as Error).message);
      this.client = null;
      this.scheduleReconnect();
    }
  }

  /** Graceful shutdown: UNLISTEN and release the dedicated client. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      try { await this.client.query("UNLISTEN roadmap_events"); } catch { /* ignore */ }
      try { this.client.release(); } catch { /* ignore */ }
      this.client = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start();
    }, 5_000);
  }

  private async fetchAndProcess(parsed: NotifyPayload): Promise<void> {
    try {
      const { rows } = await query<ProposalEventRow>(
        `SELECT id, proposal_id, event_type, payload, created_at
         FROM roadmap_proposal.proposal_event
         WHERE id = $1`,
        [parsed.event_id],
      );
      if (!rows[0]) return;
      await this.processEvent(rows[0]);
    } catch (err) {
      console.warn("[MemoryEventConsumer] fetchAndProcess error:", (err as Error).message);
    }
  }

  /**
   * Route a single proposal event to the appropriate memory update.
   * Exported so tests can call it without spinning up a LISTEN connection.
   */
  async processEvent(event: ProposalEventRow): Promise<void> {
    try {
      switch (event.event_type) {
        case "lease_claimed":
        case "lease_released":
          await this.handleLeaseEvent(event);
          break;
        case "status_changed":
          await this.appendProjectEvent("events:recent_transitions", event);
          break;
        case "decision_made":
          await this.appendProjectEvent("events:recent_decisions", event);
          break;
        case "maturity_changed":
          await this.appendProjectEvent("events:recent_maturity_changes", event);
          break;
        case "proposal_created":
          await this.appendProjectEvent("events:recent_proposals", event);
          break;
        case "ac_updated":
          await this.appendProjectEvent("events:recent_ac_updates", event);
          break;
        case "review_submitted":
          await this.handleReviewSubmittedEvent(event);
          break;
        // dependency_added, dependency_resolved, milestone_achieved: informational;
        // no memory update needed until a downstream consumer requests it.
      }
    } catch (err) {
      // Best-effort: a memory write failure must never crash the listener.
      console.warn("[MemoryEventConsumer] processEvent error:", (err as Error).message);
    }
  }

  // ── Private handlers ─────────────────────────────────────────────────────────

  private async handleLeaseEvent(event: ProposalEventRow): Promise<void> {
    const agent = event.payload["agent"] as string | undefined;
    if (!agent) return;

    const key = `${event.event_type}:p${event.proposal_id}`;
    await this.memory.setAgentMemory(agent, "episodic", key, {
      proposal_id: event.proposal_id,
      event_type: event.event_type,
      ...event.payload,
      occurred_at: event.created_at,
    }, EPISODIC_TTL_S);
  }

  private async handleReviewSubmittedEvent(event: ProposalEventRow): Promise<void> {
    const reviewer = event.payload["reviewer"] as string | undefined;
    if (reviewer) {
      const key = `review:p${event.proposal_id}:${new Date(event.created_at).getTime()}`;
      await this.memory.setAgentMemory(reviewer, "episodic", key, {
        proposal_id: event.proposal_id,
        event_type: event.event_type,
        ...event.payload,
        occurred_at: event.created_at,
      }, EPISODIC_TTL_S);
    }
    await this.appendProjectEvent("events:recent_reviews", event);
  }

  /**
   * Prepend the event to a rolling MAX_RECENT-item window in project_memory.
   * category='workflow' satisfies the project_memory_category_check constraint.
   */
  private async appendProjectEvent(
    key: string,
    event: ProposalEventRow,
  ): Promise<void> {
    const existing = await this.memory.getProjectMemory(key) as { items?: unknown[] } | null;
    const items: unknown[] = Array.isArray(existing?.items) ? existing.items : [];
    items.unshift({
      proposal_id: event.proposal_id,
      event_type: event.event_type,
      payload: event.payload,
      occurred_at: event.created_at,
    });
    if (items.length > MAX_RECENT) items.splice(MAX_RECENT);
    await this.memory.setProjectMemory(key, "workflow", { items }, "memory-event-consumer");
  }
}
