/**
 * P228: Cubic Runtime Abstraction — A2A Messenger
 *
 * Same-host agent-to-agent messaging via Postgres message_ledger.
 * Wraps the existing messaging infrastructure (P833) with a clean
 * RuntimeProvider-compatible interface.
 *
 * Multi-host (federated) messaging is future scope (P229+) — see design doc.
 *
 * @deprecated Prefer the MCP `mcp_message` tool surface (msg_send/msg_read/
 * msg_ack/msg_reply/msg_wait_reply) for new callers. This class predates the
 * P833 unified message envelope; its semantics overlap with the MCP tools and
 * SubprocessProvider's send/recv stubs do not currently route through it.
 * Kept for compatibility with the RuntimeProvider abstraction. To be folded
 * into the MCP path or removed in a follow-up to P837 (legacy cleanup).
 */

import { query } from "../../infra/postgres/pool.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface A2AMessage {
  id?: string;
  from: string;
  to: string;
  type: string;
  content: unknown;
  timestamp?: string;
  correlationId?: string;
}

export interface SendOptions {
  /** Optional correlation ID for request/response tracking */
  correlationId?: string;
  /** Optional proposal context */
  proposalId?: number;
  /** Optional reply_to ID (P907) */
  replyToId?: string | number;
}

export interface RecvOptions {
  /** Poll for up to this many ms before returning null */
  timeoutMs?: number;
  /** Filter to a specific message type */
  messageType?: string;
}

// ─── A2AMessenger ─────────────────────────────────────────────────────────────

/**
 * A2AMessenger: local (same-host) agent-to-agent message bus.
 *
 * Uses the roadmap.message_ledger table + pg_notify for low-latency delivery.
 * Agents on the same host share the same DB connection pool, so pg_notify
 * messages arrive within a single network round-trip.
 *
 * Federation (multi-host): plug a FederatedMessenger that bridges via WebSocket
 * or HTTP webhook — see docs/runtime-abstraction.md §5 for the sketch.
 */
export class A2AMessenger {
  constructor(
    private readonly identity: string,
  ) {}

  /**
   * Send a message to another agent via message_ledger.
   * Emits a pg_notify on the 'a2a_messages' channel for real-time delivery.
   */
  async send(
    toAgent: string,
    message: { type: string; content: unknown },
    opts: SendOptions = {},
  ): Promise<string> {
    const payload = typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content);

    const { rows } = await query<{ id: string }>(
      `INSERT INTO roadmap.message_ledger
         (from_agent, to_agent, message_content, message_type, proposal_id, correlation_id, reply_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id::text`,
      [
        this.identity,
        toAgent,
        payload,
        message.type,
        opts.proposalId ?? null,
        opts.correlationId ?? null,
        opts.replyToId ?? null,
      ],
    );

    const messageId = rows[0]?.id ?? "";

    // pg_notify for real-time delivery to agents polling the channel
    await query(
      `SELECT pg_notify('a2a_messages', $1)`,
      [JSON.stringify({ to: toAgent, from: this.identity, id: messageId })],
    );

    return messageId;
  }

  /**
   * Receive the next unread message addressed to this agent.
   *
   * Marks the row as read (sets `read_at`) and returns it. The row stays in
   * `message_ledger` so that `message_timeout_tracking` can still match it
   * for ACK / escalation, and so callers can later issue an explicit
   * `msg_ack` (mirrors P833 semantics). Earlier versions of this method
   * DELETEd the row on read, which destroyed ACK provenance and caused
   * timeout escalations to fire on already-delivered messages.
   *
   * Returns null if no unread direct message exists for this agent within
   * `timeoutMs`. Polls every 100ms; for low-latency wake-ups, prefer the
   * MCP `msg_read(wait_ms=...)` tool which uses pg_notify.
   */
  async recv(opts: RecvOptions = {}): Promise<A2AMessage | null> {
    const { timeoutMs = 0, messageType } = opts;
    const deadline = Date.now() + timeoutMs;

    do {
      const msg = await this.pollOne(messageType);
      if (msg) return msg;

      if (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
    } while (Date.now() < deadline);

    return null;
  }

  private async pollOne(
    messageType?: string,
  ): Promise<A2AMessage | null> {
    const typeFilter = messageType
      ? "AND message_type = $2"
      : "";
    const params: unknown[] = [this.identity];
    if (messageType) params.push(messageType);

    // UPDATE … SET read_at to mark delivered without losing the row.
    // FOR UPDATE SKIP LOCKED on the inner SELECT keeps concurrent receivers
    // from claiming the same row.
    const { rows } = await query<{
      id: string;
      from_agent: string;
      to_agent: string;
      message_type: string;
      message_content: string;
      created_at: Date;
      correlation_id: string | null;
    }>(
      `UPDATE roadmap.message_ledger
       SET    read_at = now()
       WHERE  id = (
         SELECT id FROM roadmap.message_ledger
         WHERE  to_agent = $1
           AND  (channel IS NULL OR channel = 'direct')
           AND  read_at IS NULL
           ${typeFilter}
         ORDER  BY created_at ASC
         LIMIT  1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id::text, from_agent, to_agent, message_type,
                 message_content, created_at, correlation_id`,
      params,
    );

    if (rows.length === 0) return null;

    const row = rows[0];
    let content: unknown;
    try {
      content = JSON.parse(row.message_content);
    } catch {
      content = row.message_content;
    }

    return {
      id: row.id,
      from: row.from_agent,
      to: row.to_agent,
      type: row.message_type,
      content,
      timestamp: row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
      correlationId: row.correlation_id ?? undefined,
    };
  }

  /**
   * Broadcast a message to a named channel (e.g. 'proposal_updates').
   * Agents subscribe by polling message_ledger rows with matching channel.
   */
  async broadcast(
    channel: string,
    message: { type: string; content: unknown },
    opts: SendOptions = {},
  ): Promise<string> {
    const payload = typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content);

    const { rows } = await query<{ id: string }>(
      `INSERT INTO roadmap.message_ledger
         (from_agent, channel, message_content, message_type, proposal_id, correlation_id, reply_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id::text`,
      [
        this.identity,
        channel,
        payload,
        message.type,
        opts.proposalId ?? null,
        opts.correlationId ?? null,
        opts.replyToId ?? null,
      ],
    );

    const messageId = rows[0]?.id ?? "";

    await query(
      `SELECT pg_notify($1, $2)`,
      [
        channel,
        JSON.stringify({ from: this.identity, id: messageId }),
      ],
    );

    return messageId;
  }

  /**
   * Register this agent as available on a channel (noop — registration
   * is implicit via agent_identity in the DB).
   */
  async register(channel: string): Promise<void> {
    // No-op: presence is derived from message_ledger rows.
    // Future: insert into a presence/subscription table.
    void channel;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create an A2AMessenger for the given agent identity.
 * Each agent should hold one messenger instance per session.
 */
export function createA2AMessenger(agentIdentity: string): A2AMessenger {
  return new A2AMessenger(agentIdentity);
}
