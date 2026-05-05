/**
 * P199: Secure A2A Communication — Typed Envelope Schema
 *
 * AC#1: Defines the canonical A2AEnvelope with sender, recipient,
 * message_type, body, and security (signature) fields.
 *
 * AC#4: Security section documents nonce (replay prevention),
 * signature (spoofing prevention), and acl_grant_id (authorization trail).
 */

// ─── Message types ────────────────────────────────────────────────────────────

/** All valid message types in the A2A protocol. */
export type A2AMessageType =
    | "text"         // plain conversational message
    | "task"         // task assignment with optional action payload
    | "query"        // question expecting a structured response
    | "vote"         // proposal vote cast by an agent
    | "proposal_ref" // reference to a proposal (link / status update)
    | "code"         // code snippet or diff
    | "error"        // error notification
    | "notify"       // one-way notification (no reply expected)
    | "ack"          // acknowledgement of a received message
    | "event";       // system or lifecycle event

/** Priority levels for message scheduling and SLA enforcement. */
export type A2AMessagePriority = "low" | "normal" | "high" | "urgent";

/** ACL grant types that control what a sender may deliver. */
export type ACLGrantType = "dm" | "channel_post" | "system";

// ─── Envelope ─────────────────────────────────────────────────────────────────

/**
 * Canonical typed envelope for all A2A messages (AC#1).
 *
 * Every message persisted to roadmap.message_ledger is wrapped in this
 * envelope before insertion. The `security` section carries the nonce
 * and optional HMAC-SHA256 signature produced by the sending agent.
 */
export interface A2AEnvelope {
    /** Unique message nonce (UUID). Duplicates are rejected to prevent replay. */
    nonce: string;

    // ── Routing ──────────────────────────────────────────────────────────────

    /** Agent identity of the sender (e.g. 'claude/agency-bot'). */
    sender: string;

    /**
     * Agent identity of the intended recipient for DMs.
     * Null when the message targets a channel.
     */
    recipient: string | null;

    /**
     * Channel name for multi-subscriber delivery.
     * Must match ^(direct|team:.+|broadcast|system)$.
     * Null when recipient is set (DM).
     */
    channel: string | null;

    // ── Content ───────────────────────────────────────────────────────────────

    /** Discriminated message type. */
    message_type: A2AMessageType;

    /**
     * Typed body — only the fields relevant to message_type should be populated.
     */
    body: {
        text?: string;          // message_type: text | notify | ack
        code?: string;          // message_type: code
        proposal_id?: number;   // message_type: proposal_ref | task | vote
        task_action?: string;   // message_type: task
        error_code?: string;    // message_type: error
        error_detail?: string;  // message_type: error
    };

    // ── Metadata ──────────────────────────────────────────────────────────────

    metadata: {
        priority?: A2AMessagePriority;
        /** Message TTL in seconds from sent_at. Delivery agents may drop expired messages. */
        ttl?: number;
        /** message_ledger.id of the message being replied to. */
        reply_to?: number;
        /** Root message_ledger.id of the thread. */
        thread_id?: number;
        /** Associated proposal numeric ID. */
        proposal_id?: number;
    };

    // ── Security (AC#4: threat model coverage) ───────────────────────────────

    security: {
        /**
         * HMAC-SHA256 over concat(nonce, sender, JSON.stringify(body)).
         * Absent if the sender does not support signing (gracefully degraded).
         * Receivers SHOULD verify when present.
         * Threat: spoofing — impersonating a sending agent.
         */
        signature?: string;

        /**
         * ID of the roadmap.message_acl row that authorised this send.
         * Logged for audit trail.
         * Threat: unauthorized broadcast — ensures every send is ACL-checked.
         */
        acl_grant_id?: number;

        /**
         * Whether the body is encrypted (future: symmetric key per-DM pair).
         * Stored so receivers know to decrypt before processing.
         * Threat: eavesdropping via pg_notify channel sniffing.
         */
        encrypted?: boolean;
    };
}

// ─── Access control ───────────────────────────────────────────────────────────

/** Row from roadmap.message_acl. */
export interface MessageACLEntry {
    id: number;
    fromAgent: string;
    toAgent: string;   // '*' = any registered agent
    grantType: ACLGrantType;
    grantedBy: string;
    grantedAt: Date;
    revokedAt: Date | null;
}

/** Result of an ACL check. */
export interface ACLCheckResult {
    allowed: boolean;
    /** Machine-readable reason code. */
    reason: string;
    /** ACL entry id that permitted the send (present when allowed = true). */
    entryId?: number;
}

// ─── Notification ─────────────────────────────────────────────────────────────

/**
 * Payload delivered via pg_notify on an agent's dedicated channel.
 * This replaces the old NewMessageNotification (which used 'new_message').
 */
export interface A2ANotification {
    message_id: number;
    from_agent: string;
    to_agent: string | null;
    channel: string | null;
    message_type: string;
    proposal_id: number | null;
    nonce: string;
    created_at: string;
}
