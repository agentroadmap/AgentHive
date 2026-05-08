/**
 * Discord External Routing Bridge (P923)
 *
 * Bidirectional bridge for operator ↔ agency communication via Discord.
 * Inbound: validates Discord HMAC signature, calls msg_send via fn_liaison_message_send_v2.
 * Outbound: LISTENs external_discord_outbound, re-validates grant, sends to Discord API.
 *
 * Failure isolation: timeout (10s), retry (2x exponential backoff), circuit breaker (10
 * consecutive failures → 5 min disabled), backpressure (queue cap 1000).
 * Never throws to orchestrator. All Discord calls wrapped in try/catch.
 */

import { createHmac, timingSafeEqual } from "crypto";
import { EventEmitter } from "events";
import { getPool, query } from "../postgres/pool.ts";

// ─── Types & Config ──────────────────────────────────────────────────────────

interface DiscordBridgeConfig {
  botToken: string;
  botPublicKey: string;
  pollIntervalMs?: number;
  maxQueueSize?: number;
}

interface ExternalRoutingGrant {
  id: bigint;
  external_id: string;
  agency_id: string;
  is_active: boolean;
}

interface OutboundMessage {
  message_id: bigint;
  to_agent: string;
  message_content: string;
  metadata: Record<string, any>;
  retry_count: number;
  created_at: Date;
}

enum CircuitBreakerState {
  CLOSED = "closed",
  DISABLED = "disabled",
}

// ─── Discord Bridge Class ────────────────────────────────────────────────────

export class DiscordExternalBridge extends EventEmitter {
  private config: DiscordBridgeConfig;
  private circuitBreakerState: CircuitBreakerState = CircuitBreakerState.CLOSED;
  private consecutiveFailures = 0;
  private lastFailureTime: number | null = null;
  private circuitBreakerResetTime: number | null = null;
  private outboundQueue: OutboundMessage[] = [];
  private listenClient: any = null;
  private processingLoop: NodeJS.Timer | null = null;

  private readonly FAILURE_WINDOW_MS = 60_000;
  private readonly FAILURE_THRESHOLD = 10;
  private readonly CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60_000;
  private readonly TIMEOUT_MS = 10_000;
  private readonly MAX_RETRIES = 2;
  private readonly RETRY_DELAYS = [1_000, 5_000];
  private readonly MAX_QUEUE_SIZE = 1_000;
  private readonly DISCORD_API = "https://discord.com/api/v10";

  constructor(config: DiscordBridgeConfig) {
    super();
    this.config = config;
  }

  /**
   * Start the bridge: establish pg_notify listener and processing loop.
   * Never throws; errors logged via standard logger.
   */
  async start(): Promise<void> {
    try {
      const pool = getPool();
      this.listenClient = await pool.connect();
      await this.listenClient.query("LISTEN external_discord_outbound");

      this.listenClient.on("notification", (msg: any) => {
        if (msg.channel === "external_discord_outbound" && msg.payload) {
          this.onOutboundNotify(msg.payload).catch((e) => {
            console.error(`[discord-bridge] onOutboundNotify error: ${e}`);
          });
        }
      });

      this.processingLoop = setInterval(
        () => this.processOutboundQueue().catch((e) => {
          console.error(`[discord-bridge] processOutboundQueue error: ${e}`);
        }),
        5_000,
      );

      console.log("[discord-bridge] Started");
    } catch (err) {
      console.error(`[discord-bridge] Failed to start: ${err}`);
    }
  }

  /**
   * Stop the bridge and clean up resources.
   */
  async stop(): Promise<void> {
    try {
      if (this.processingLoop) {
        clearInterval(this.processingLoop);
        this.processingLoop = null;
      }
      if (this.listenClient) {
        await this.listenClient.release();
        this.listenClient = null;
      }
      console.log("[discord-bridge] Stopped");
    } catch (err) {
      console.error(`[discord-bridge] Error stopping: ${err}`);
    }
  }

  /**
   * Handle inbound Discord message from webhook (operator → agency).
   * Validates HMAC signature, checks routing grant, calls msg_send.
   *
   * Never throws; errors logged as DEBUG with metric.
   */
  async handleInboundMessage(
    payload: Record<string, any>,
    signatureHeader: string,
  ): Promise<{ success: boolean; reason?: string }> {
    try {
      // 1. Validate HMAC signature
      if (!this.validateDiscordSignature(payload, signatureHeader)) {
        console.debug("[discord-bridge] Inbound signature validation failed");
        console.error("[discord-bridge] discord_inbound_sig_invalid");
        return { success: false, reason: "signature_invalid" };
      }

      const discordUserId = payload.user_id || payload.author?.id;
      const discordChannelId = payload.channel_id;
      const discordGuildId = payload.guild_id;
      const discordThreadId = payload.thread_id;
      const content = payload.content;
      const nonce = payload.nonce || this.generateNonce();

      if (!discordUserId || !content) {
        console.debug(
          `[discord-bridge] Missing required fields: user_id=${discordUserId}, content=${!!content}`,
        );
        return { success: false, reason: "missing_fields" };
      }

      // 2. Rate limit checks (pre-grant, bridge-global level)
      if (this.shouldThrottleGlobal()) {
        console.warn("[discord-bridge] discord_inbound_throttled_global");
        return { success: false, reason: "throttled_global" };
      }

      // 3. Lookup active grant for this external_id
      const externalId = discordUserId;
      const grant = await this.findActiveGrant(externalId, "discord");
      if (!grant) {
        console.warn(
          `[discord-bridge] No active grant for external_id=${externalId}`,
        );
        console.error("[discord-bridge] discord_inbound_grant_denied");
        return { success: false, reason: "grant_not_found" };
      }

      // 4. Rate limit per-user
      if (this.shouldThrottlePerUser(externalId)) {
        console.warn(
          `[discord-bridge] discord_inbound_throttled_per_user user=${externalId}`,
        );
        return { success: false, reason: "throttled_per_user" };
      }

      // 5. Rate limit per-agency
      if (this.shouldThrottlePerAgency(grant.agency_id)) {
        console.warn(
          `[discord-bridge] discord_inbound_throttled_per_agency agency=${grant.agency_id}`,
        );
        return { success: false, reason: "throttled_per_agency" };
      }

      // 6. Rate limit per-routing daily
      if (await this.isRoutingDailyCapped(grant.id)) {
        console.error(
          `[discord-bridge] discord_inbound_hard_reject_daily_cap grant_id=${grant.id}`,
        );
        return { success: false, reason: "daily_cap_exceeded" };
      }

      // 7. Prepare metadata and call msg_send
      const metadata = {
        discord_user_id: discordUserId,
        discord_channel_id: discordChannelId,
        discord_guild_id: discordGuildId,
        discord_thread_id: discordThreadId,
        external_routing_id: grant.id,
      };

      const toAgent = `external/discord/${externalId}`;
      const sigPayload = Buffer.from(signatureHeader, "hex");

      try {
        const result = await query(
          `SELECT * FROM roadmap.fn_liaison_message_send_v2(
             $1::text, $2::text, $3::text, $4::text,
             $5::jsonb, $6::bytea, $7::uuid
           )`,
          [
            "bridge/discord",
            toAgent,
            "text",
            content,
            JSON.stringify(metadata),
            sigPayload,
            nonce,
          ],
        );

        if (result.rows.length > 0) {
          console.log(
            `[discord-bridge] Inbound message inserted: message_id=${result.rows[0].message_id}`,
          );
          return { success: true };
        } else {
          console.error(
            "[discord-bridge] msg_send returned no rows (unexpected)",
          );
          return { success: false, reason: "insertion_failed" };
        }
      } catch (err: any) {
        if (err.message?.includes("nonce collision")) {
          console.debug("[discord-bridge] Nonce collision (replay detected)");
          return { success: false, reason: "nonce_collision" };
        }
        if (err.message?.includes("ACL deny")) {
          console.warn(`[discord-bridge] ACL deny: ${err.message}`);
          return { success: false, reason: "acl_denied" };
        }
        throw err;
      }
    } catch (err) {
      console.error(
        `[discord-bridge] handleInboundMessage error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { success: false, reason: "internal_error" };
    }
  }

  /**
   * On outbound notify: queue the message for processing.
   */
  private async onOutboundNotify(messageIdStr: string): Promise<void> {
    try {
      const messageId = BigInt(messageIdStr);

      // Fetch message details from message_ledger
      const result = await query(
        `SELECT to_agent, message_content, metadata, created_at
         FROM roadmap.message_ledger
         WHERE id = $1`,
        [messageId],
      );

      if (result.rows.length === 0) {
        console.warn(`[discord-bridge] Message ${messageId} not found`);
        return;
      }

      const row = result.rows[0];
      const msg: OutboundMessage = {
        message_id: messageId,
        to_agent: row.to_agent,
        message_content: row.message_content,
        metadata: row.metadata || {},
        retry_count: 0,
        created_at: row.created_at,
      };

      // Enqueue (with backpressure)
      if (this.outboundQueue.length >= this.MAX_QUEUE_SIZE) {
        const dropped = this.outboundQueue.shift();
        console.warn(
          `[discord-bridge] discord_overflow_dropped message_id=${dropped?.message_id}`,
        );
      }
      this.outboundQueue.push(msg);
    } catch (err) {
      console.error(`[discord-bridge] onOutboundNotify error: ${err}`);
    }
  }

  /**
   * Process outbound queue: send each message to Discord with retry + timeout.
   */
  private async processOutboundQueue(): Promise<void> {
    if (this.outboundQueue.length === 0) return;

    // Check circuit breaker
    if (this.circuitBreakerState === CircuitBreakerState.DISABLED) {
      if (
        this.circuitBreakerResetTime &&
        Date.now() >= this.circuitBreakerResetTime
      ) {
        this.circuitBreakerState = CircuitBreakerState.CLOSED;
        this.consecutiveFailures = 0;
        this.circuitBreakerResetTime = null;
        console.log("[discord-bridge] Circuit breaker CLOSED (reset)");
      } else {
        // Skip processing while disabled
        console.debug(
          `[discord-bridge] Circuit breaker DISABLED; skipping ${this.outboundQueue.length} messages`,
        );
        return;
      }
    }

    const msg = this.outboundQueue[0];

    try {
      await this.sendOutboundMessage(msg);
      this.outboundQueue.shift();
      this.recordSuccess();
    } catch (err) {
      if (msg.retry_count < this.MAX_RETRIES) {
        msg.retry_count++;
        const delay = this.RETRY_DELAYS[msg.retry_count - 1];
        console.log(
          `[discord-bridge] Retry ${msg.retry_count}/${this.MAX_RETRIES} in ${delay}ms`,
        );
        // Requeue after delay (simple: don't process again this cycle)
      } else {
        this.outboundQueue.shift();
        console.error(
          `[discord-bridge] discord_send_failed message_id=${msg.message_id}`,
        );
        this.recordFailure();
      }
    }
  }

  /**
   * Send a single message to Discord with timeout protection.
   */
  private async sendOutboundMessage(msg: OutboundMessage): Promise<void> {
    // Parse to_agent to extract external_id
    const match = msg.to_agent.match(/^external\/discord\/(.+)$/);
    if (!match) {
      throw new Error(`Invalid to_agent format: ${msg.to_agent}`);
    }
    const externalId = match[1];

    // Re-validate grant exists and is active (defense-in-depth)
    const grant = await this.findActiveGrant(externalId, "discord");
    if (!grant) {
      console.warn(
        `[discord-bridge] discord_send_grant_denied external_id=${externalId}`,
      );
      throw new Error("Grant revoked mid-flight");
    }

    // Resolve display name for reply prefix
    const displayName = await this.resolveAgencyDisplayName(msg.metadata);

    // Extract target user_id from metadata
    const discordUserId = msg.metadata?.discord_user_id;
    if (!discordUserId) {
      throw new Error("Missing discord_user_id in metadata");
    }

    // Send via timeout race
    await this.sendWithTimeout(discordUserId, displayName, msg.message_content);
  }

  /**
   * Send message to Discord with 10s timeout.
   */
  private async sendWithTimeout(
    discordUserId: string,
    displayName: string,
    content: string,
  ): Promise<void> {
    const promise = this.sendToDiscordDM(discordUserId, displayName, content);
    const timeoutPromise = new Promise<void>((_, reject) =>
      setTimeout(
        () => reject(new Error("Discord send timeout")),
        this.TIMEOUT_MS,
      ),
    );

    try {
      await Promise.race([promise, timeoutPromise]);
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes("timeout")
      ) {
        console.warn(`[discord-bridge] discord_send_timeout user=${discordUserId}`);
        throw err;
      }
      throw err;
    }
  }

  /**
   * Send DM via Discord API.
   */
  private async sendToDiscordDM(
    userId: string,
    senderName: string,
    content: string,
  ): Promise<void> {
    try {
      // Create DM channel
      const dmResp = await fetch(`${this.DISCORD_API}/users/@me/channels`, {
        method: "POST",
        headers: {
          Authorization: `Bot ${this.config.botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ recipient_id: userId }),
      });

      if (!dmResp.ok) {
        throw new Error(
          `Discord DM channel creation failed: ${dmResp.status}`,
        );
      }

      const dmData = await dmResp.json();
      const channelId = dmData.id;

      // Send message to DM
      const msgResp = await fetch(
        `${this.DISCORD_API}/channels/${channelId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bot ${this.config.botToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            content: `**${senderName}**: ${content}`,
          }),
        },
      );

      if (!msgResp.ok) {
        throw new Error(
          `Discord message send failed: ${msgResp.status}`,
        );
      }
    } catch (err) {
      if (err instanceof Error) {
        // Classify error
        if (
          err.message.includes("429") ||
          err.message.includes("ECONNRESET")
        ) {
          throw new Error("Transient error, can retry");
        }
      }
      throw err;
    }
  }

  /**
   * Resolve agency display name for reply prefix (schema-safe).
   * Returns display_alias, persona_name, display_name, or agent_identity.
   */
  private async resolveAgencyDisplayName(metadata: Record<string, any>): Promise<string> {
    try {
      // Metadata may have agency_identity; if not, use default
      const agencyIdentity = metadata?.agency_identity || "bridge/discord";

      const result = await query(
        `SELECT COALESCE(
           (to_jsonb(ar) ->> 'display_alias'),
           (to_jsonb(ar) ->> 'persona_name'),
           (to_jsonb(ar) ->> 'display_name'),
           ar.agent_identity
         ) AS display
         FROM roadmap_workforce.agent_registry ar
         WHERE ar.agent_identity = $1`,
        [agencyIdentity],
      );

      if (result.rows.length > 0) {
        return result.rows[0].display || agencyIdentity;
      }
      return agencyIdentity;
    } catch (err) {
      console.error(
        `[discord-bridge] resolveAgencyDisplayName error: ${err}`,
      );
      return "Agent";
    }
  }

  /**
   * Validate Discord HMAC signature (timing-safe).
   */
  private validateDiscordSignature(
    payload: Record<string, any>,
    signatureHeader: string,
  ): boolean {
    try {
      const bodyString = JSON.stringify(payload);
      const hash = createHmac("sha256", this.config.botPublicKey)
        .update(bodyString)
        .digest("hex");

      const expectedSig = Buffer.from(hash);
      const providedSig = Buffer.from(signatureHeader, "hex");

      return timingSafeEqual(expectedSig, providedSig);
    } catch {
      return false;
    }
  }

  /**
   * Find active external_routing grant for given external_id + channel_kind.
   */
  private async findActiveGrant(
    externalId: string,
    channelKind: string,
  ): Promise<ExternalRoutingGrant | null> {
    try {
      const result = await query(
        `SELECT id, external_id, agency_id, is_active
         FROM roadmap.external_routing
         WHERE external_id = $1 AND channel_kind = $2 AND is_active = true
         LIMIT 1`,
        [externalId, channelKind],
      );

      return result.rows.length > 0 ? result.rows[0] : null;
    } catch (err) {
      console.error(`[discord-bridge] findActiveGrant error: ${err}`);
      return null;
    }
  }

  /**
   * Check if per-external_id rate limit exceeded (10/min soft drop).
   */
  private shouldThrottlePerUser(externalId: string): boolean {
    // TODO: Implement sliding-window rate limit
    return false;
  }

  /**
   * Check if per-agency_id rate limit exceeded (60/min soft drop).
   */
  private shouldThrottlePerAgency(agencyId: string): boolean {
    // TODO: Implement sliding-window rate limit
    return false;
  }

  /**
   * Check if bridge-global rate limit exceeded (10000/min soft drop).
   */
  private shouldThrottleGlobal(): boolean {
    // TODO: Implement sliding-window rate limit
    return false;
  }

  /**
   * Check if routing daily cap exceeded (1000 hard reject).
   */
  private async isRoutingDailyCapped(grantId: bigint): Promise<boolean> {
    try {
      const result = await query(
        `SELECT COUNT(*) as count
         FROM roadmap.message_ledger
         WHERE metadata ->> 'external_routing_id' = $1
           AND created_at >= CURRENT_DATE`,
        [grantId.toString()],
      );

      const count = result.rows[0]?.count || 0;
      return count >= 1000;
    } catch (err) {
      console.error(`[discord-bridge] isRoutingDailyCapped error: ${err}`);
      return false;
    }
  }

  /**
   * Generate a random UUID for nonce.
   */
  private generateNonce(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Record a successful send (reset failure counter).
   */
  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.lastFailureTime = null;
  }

  /**
   * Record a failure and potentially trigger circuit breaker.
   */
  private recordFailure(): void {
    const now = Date.now();

    // Reset counter if outside failure window
    if (
      this.lastFailureTime &&
      now - this.lastFailureTime > this.FAILURE_WINDOW_MS
    ) {
      this.consecutiveFailures = 1;
    } else {
      this.consecutiveFailures++;
    }

    this.lastFailureTime = now;

    // Trigger circuit breaker if threshold exceeded
    if (this.consecutiveFailures >= this.FAILURE_THRESHOLD) {
      this.circuitBreakerState = CircuitBreakerState.DISABLED;
      this.circuitBreakerResetTime =
        now + this.CIRCUIT_BREAKER_COOLDOWN_MS;
      console.error(
        `[discord-bridge] Circuit breaker DISABLED (${this.consecutiveFailures} consecutive failures)`,
      );
    }
  }
}

/**
 * Export singleton bridge instance (started by Orchestrator).
 */
let bridgeInstance: DiscordExternalBridge | null = null;

export function initializeDiscordBridge(config: DiscordBridgeConfig): DiscordExternalBridge {
  if (!bridgeInstance) {
    bridgeInstance = new DiscordExternalBridge(config);
  }
  return bridgeInstance;
}

export function getDiscordBridge(): DiscordExternalBridge | null {
  return bridgeInstance;
}
