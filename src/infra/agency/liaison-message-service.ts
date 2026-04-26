/**
 * P468: Liaison message service
 * Handles idempotent message storage, replay, signing, and LISTEN/NOTIFY integration
 */

import { query } from '../postgres/pool.js';
import type { LiaisonMessage, LiaisonMessageAckOutcome } from './liaison-message-types.js';

// ─── Configuration ──────────────────────────────────────────────────────────

const MESSAGE_SEQUENCE_WINDOW = 100; // Buffer out-of-order messages up to this window
const SIGNED_AT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const LISTEN_CHANNEL_PREFIX = 'liaison_message_';

// ─── Message Storage ────────────────────────────────────────────────────────

/**
 * Insert a message and return it with all fields set
 * Enforces idempotency via (agency_id, sequence) unique constraint
 */
export async function storeMessage(
    message: Partial<LiaisonMessage> & {
        message_id: string;
        agency_id: string;
        direction: string;
        kind: string;
        correlation_id: string;
        payload: Record<string, any>;
        signed_at: string;
        signature: string;
        sequence: bigint;
    }
): Promise<LiaisonMessage> {
    const result = await query<LiaisonMessage>(
        `INSERT INTO roadmap.liaison_message
            (message_id, agency_id, sequence, direction, kind, correlation_id, payload, signed_at, signature)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (agency_id, sequence) DO UPDATE
            SET message_id = EXCLUDED.message_id
        RETURNING
            message_id, agency_id, sequence, direction, kind, correlation_id,
            payload, signed_at, signature, acked_at, ack_outcome, ack_error, created_at`,
        [
            message.message_id,
            message.agency_id,
            message.sequence,
            message.direction,
            message.kind,
            message.correlation_id,
            JSON.stringify(message.payload),
            message.signed_at,
            message.signature,
        ]
    );

    if (result.rows.length === 0) {
        throw new Error(`Failed to store message for agency ${message.agency_id}`);
    }

    return parseMessageRow(result.rows[0]);
}

/**
 * Get the next sequence number for an agency
 * Liaisons use this on restart to resume from MAX(sequence) + 1
 */
export async function getNextSequence(agencyId: string): Promise<bigint> {
    const result = await query<{ next_sequence: string }>(
        `SELECT roadmap.fn_liaison_next_sequence($1) as next_sequence`,
        [agencyId]
    );

    if (result.rows.length === 0) {
        throw new Error(`Failed to get next sequence for agency ${agencyId}`);
    }

    return BigInt(result.rows[0].next_sequence);
}

/**
 * Fetch a message by ID
 */
export async function getMessageById(messageId: string): Promise<LiaisonMessage | null> {
    const result = await query<any>(
        `SELECT message_id, agency_id, sequence, direction, kind, correlation_id,
                payload, signed_at, signature, acked_at, ack_outcome, ack_error, created_at
         FROM roadmap.liaison_message
         WHERE message_id = $1`,
        [messageId]
    );

    if (result.rows.length === 0) {
        return null;
    }

    return parseMessageRow(result.rows[0]);
}

/**
 * Fetch unacked messages for an agency in sequence order
 * Used by orchestrator to catch up after restart
 */
export async function getUnackedMessages(
    agencyId: string,
    fromSequence?: bigint
): Promise<LiaisonMessage[]> {
    const whereClause = fromSequence
        ? `WHERE agency_id = $1 AND acked_at IS NULL AND sequence >= $2`
        : `WHERE agency_id = $1 AND acked_at IS NULL`;

    const params = fromSequence ? [agencyId, fromSequence] : [agencyId];

    const result = await query<any>(
        `SELECT message_id, agency_id, sequence, direction, kind, correlation_id,
                payload, signed_at, signature, acked_at, ack_outcome, ack_error, created_at
         FROM roadmap.liaison_message
         ${whereClause}
         ORDER BY sequence ASC`,
        params
    );

    return result.rows.map(parseMessageRow);
}

/**
 * Fetch messages from agency in sequence order
 * Used for replay and recovery scenarios
 */
export async function getMessagesInSequenceRange(
    agencyId: string,
    fromSequence: bigint,
    toSequence?: bigint
): Promise<LiaisonMessage[]> {
    const whereClause = toSequence
        ? `WHERE agency_id = $1 AND sequence >= $2 AND sequence <= $3`
        : `WHERE agency_id = $1 AND sequence >= $2`;

    const params = toSequence ? [agencyId, fromSequence, toSequence] : [agencyId, fromSequence];

    const result = await query<any>(
        `SELECT message_id, agency_id, sequence, direction, kind, correlation_id,
                payload, signed_at, signature, acked_at, ack_outcome, ack_error, created_at
         FROM roadmap.liaison_message
         ${whereClause}
         ORDER BY sequence ASC`,
        params
    );

    return result.rows.map(parseMessageRow);
}

/**
 * Acknowledge a message
 * Orchestrator writes acked_at + ack_outcome after processing
 */
export async function acknowledgeMessage(
    messageId: string,
    outcome: LiaisonMessageAckOutcome,
    error?: string
): Promise<void> {
    const result = await query(
        `SELECT * FROM roadmap.fn_liaison_ack_message($1, $2, $3)`,
        [messageId, outcome, error || null]
    );

    if (result.rows.length === 0) {
        throw new Error(`Failed to acknowledge message ${messageId}`);
    }
}

/**
 * Get the previous ack outcome for a message (for idempotent repeated acks)
 */
export async function getMessageAckOutcome(
    messageId: string
): Promise<{ outcome: LiaisonMessageAckOutcome | null; error: string | null } | null> {
    const result = await query<{ ack_outcome: string | null; ack_error: string | null }>(
        `SELECT ack_outcome, ack_error
         FROM roadmap.liaison_message
         WHERE message_id = $1`,
        [messageId]
    );

    if (result.rows.length === 0) {
        return null;
    }

    return {
        outcome: result.rows[0].ack_outcome as LiaisonMessageAckOutcome | null,
        error: result.rows[0].ack_error,
    };
}

// ─── Out-of-Order Buffering & Replay ────────────────────────────────────────

/**
 * Detect out-of-order messages and buffer them
 * Returns true if message is in-order, false if buffered
 */
export async function detectAndBufferOutOfOrder(
    agencyId: string,
    expectedSequence: bigint,
    incomingSequence: bigint
): Promise<{ inOrder: boolean; droppedCount: number }> {
    const gap = Number(incomingSequence - expectedSequence);

    if (gap === 0) {
        // In order
        return { inOrder: true, droppedCount: 0 };
    }

    if (gap > 0 && gap <= MESSAGE_SEQUENCE_WINDOW) {
        // Out of order within buffer window — keep it
        return { inOrder: false, droppedCount: 0 };
    }

    // Out of order beyond buffer window — drop and signal resync
    return { inOrder: false, droppedCount: gap };
}

// ─── Signature Verification ─────────────────────────────────────────────────

/**
 * Verify that signed_at is within the acceptable timeout
 * Rejects messages older than 5 minutes
 */
export function isSignatureTimestampValid(signedAtIso: string): boolean {
    const signedAt = new Date(signedAtIso).getTime();
    const now = Date.now();
    const age = now - signedAt;

    return age >= 0 && age <= SIGNED_AT_TIMEOUT_MS;
}

/**
 * Generate a signature over message content
 * TODO(P472): Implement actual signature verification against agency public key
 * For now, this is a stub that documents the expected signature format
 */
export function generateMessageSignature(
    agencyId: string,
    kind: string,
    payload: Record<string, any>,
    signedAt: string
): string {
    // TODO(P472): Replace with HMAC-SHA256 or RSA verification against agency's public_key
    // Signature should be deterministic over (agency_id, kind, payload, signed_at)
    // For now, return a placeholder
    return `stub-signature-${agencyId}-${kind}-${signedAt}`;
}

/**
 * Verify a message signature
 * TODO(P472): Implement actual signature verification
 */
export async function verifyMessageSignature(
    agencyId: string,
    kind: string,
    payload: Record<string, any>,
    signedAt: string,
    signature: string
): Promise<boolean> {
    // TODO(P472): Fetch agency.metadata.public_key from roadmap.agency
    // Verify the detached signature over (agency_id, kind, payload, signed_at)
    // For now, accept all signatures
    return true;
}

// ─── LISTEN/NOTIFY Integration ──────────────────────────────────────────────

/**
 * Listen for new messages for an agency
 * Returns an async iterable that yields messages as they arrive
 */
export function listenForMessages(agencyId: string): AsyncIterable<LiaisonMessage> {
    return createMessageListener(agencyId);
}

async function* createMessageListener(agencyId: string) {
    // TODO(P472): Implement real LISTEN/NOTIFY via pg client
    // For now, this is a stub that yields nothing
    // In production, connect to Postgres LISTEN on channel 'liaison_message_<agency_id>'
    yield;
}

// ─── Helper Functions ────────────────────────────────────────────────────────

function parseMessageRow(row: any): LiaisonMessage {
    return {
        message_id: row.message_id,
        agency_id: row.agency_id,
        sequence: BigInt(row.sequence),
        direction: row.direction,
        kind: row.kind,
        correlation_id: row.correlation_id,
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
        signed_at: row.signed_at,
        signature: row.signature,
        acked_at: row.acked_at,
        ack_outcome: row.ack_outcome,
        ack_error: row.ack_error,
        created_at: row.created_at,
    };
}
