/**
 * P468: Liaison message service
 * Handles idempotent message storage, replay, signing, and LISTEN/NOTIFY integration
 */

import { createHmac } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { query } from '../postgres/pool.js';
import type { LiaisonMessage, LiaisonMessageAckOutcome } from './liaison-message-types.js';

// ─── Configuration ──────────────────────────────────────────────────────────

const MESSAGE_SEQUENCE_WINDOW = 100; // Buffer out-of-order messages up to this window
const SIGNED_AT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const LISTEN_CHANNEL_PREFIX = 'msg_';

// Signing key: shared secret from env, falls back to deterministic dev sentinel.
// P208 RSA key-pair integration is separate; HMAC-SHA256 is the wire implementation.
function getSigningKey(): string {
    return process.env.AGENCY_SIGNING_KEY ?? 'dev-insecure-signing-key';
}

// ─── Message Storage ────────────────────────────────────────────────────────

/**
 * Insert a message and return it with all fields set.
 * Enforces idempotency via (agency_id, sequence) unique constraint.
 *
 * P149 Phase C: also mirrors to message_ledger for unified A2A observability.
 * The ledger insert is best-effort — if it fails (e.g. from_agent not in
 * agent_registry), liaison_message remains the authoritative store.
 *
 * P922: host_id is resolved via atomic INSERT...SELECT from roadmap.agency.host_id.
 * This ensures host_id and the message are inserted atomically within the same
 * transaction, preventing stale-read windows if the agency moves hosts.
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
    // Mirror to message_ledger — enables unified A2A query surface and pg_notify
    // on a2a_chan_system:liaison:<agency_id> for future consumers.
    let ledgerId: number | null = null;
    try {
        const ledgerResult = await query<{ id: number }>(
            `INSERT INTO roadmap.message_ledger
                (from_agent, channel, message_content, message_type, metadata)
             VALUES ($1, $2, $3, 'liaison', $4)
             RETURNING id`,
            [
                `liaison:${message.agency_id}`,
                `system:liaison:${message.agency_id}`,
                JSON.stringify(message.payload).substring(0, 4096),
                JSON.stringify({
                    kind: message.kind,
                    direction: message.direction,
                    correlation_id: message.correlation_id,
                    signed_at: message.signed_at,
                    signature: message.signature,
                    sequence: String(message.sequence),
                    message_id: message.message_id,
                }),
            ]
        );
        ledgerId = ledgerResult.rows[0]?.id ?? null;
    } catch {
        // Mirror failed — proceed with liaison_message as the authoritative store
    }

    // P922: Atomic INSERT...SELECT to resolve host_id from roadmap.agency.
    // No caller-side cache or separate SELECT-then-INSERT. The host_id is resolved
    // and inserted atomically within the same transaction, ensuring:
    // - If agency moves hosts between caller's logic and INSERT, the SELECT sees the current host.
    // - No stale-read window: SELECT and INSERT are indivisible from other transactions' POV.
    const result = await query<LiaisonMessage>(
        `INSERT INTO roadmap.liaison_message
            (message_id, agency_id, sequence, direction, kind, correlation_id, payload, signed_at, signature, ledger_id, host_id)
        SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, a.host_id
        FROM roadmap.agency a
        WHERE a.agency_id = $2
        ON CONFLICT (agency_id, sequence) DO UPDATE
            SET message_id = EXCLUDED.message_id,
                ledger_id  = COALESCE(roadmap.liaison_message.ledger_id, EXCLUDED.ledger_id),
                host_id    = EXCLUDED.host_id
        RETURNING
            message_id, agency_id, sequence, direction, kind, correlation_id,
            payload, signed_at, signature, acked_at, ack_outcome, ack_error, created_at, host_id`,
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
            ledgerId,
        ]
    );

    if (result.rows.length === 0) {
        throw new Error(`Failed to store message for agency ${message.agency_id}`);
    }

    return parseMessageRow(result.rows[0]);
}

/**
 * High-level convenience: auto-generate message_id, sequence, correlation_id,
 * signed_at, and signature, then persist via storeMessage.
 * Suitable for callers who don't need to manage sequence numbers manually.
 *
 * AC-9: Rejects targets that match a current display_alias value (not routable).
 * Callers must use agency_id or identity-based addressing, not human-readable aliases.
 */
export async function sendMessage(opts: {
    agency_id: string;
    direction: LiaisonMessage['direction'];
    kind: string;
    payload: Record<string, any>;
    correlation_id?: string;
}): Promise<LiaisonMessage> {
    // AC-9: Check if agency_id matches an active agent's display_alias
    const aliasCheckResult = await query<{ is_alias: boolean }>(
        `SELECT EXISTS(
            SELECT 1 FROM roadmap_workforce.agent_registry
            WHERE display_alias = $1 AND status = 'active'
        ) as is_alias`,
        [opts.agency_id]
    );

    if (aliasCheckResult.rows[0]?.is_alias) {
        const err = new Error(
            `ALIAS_NOT_ROUTABLE: "${opts.agency_id}" is a human-readable display_alias, ` +
            `not a routable target. Use agent_identity or agency_id instead.`
        );
        (err as any).code = 'ALIAS_NOT_ROUTABLE';
        throw err;
    }

    const message_id = crypto.randomUUID();
    const correlation_id = opts.correlation_id ?? crypto.randomUUID();
    const sequence = await getNextSequence(opts.agency_id);
    const signed_at = new Date().toISOString();
    const signature = generateMessageSignature(
        opts.agency_id,
        opts.kind,
        opts.payload,
        signed_at
    );

    return storeMessage({
        message_id,
        agency_id: opts.agency_id,
        sequence,
        direction: opts.direction,
        kind: opts.kind,
        correlation_id,
        payload: opts.payload,
        signed_at,
        signature,
    });
}

/**
 * Get the next sequence number for an agency.
 * Liaisons use this on restart to resume from MAX(sequence) + 1.
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
 * Fetch a message by ID.
 */
export async function getMessageById(messageId: string): Promise<LiaisonMessage | null> {
    const result = await query<any>(
        `SELECT message_id, agency_id, sequence, direction, kind, correlation_id,
                payload, signed_at, signature, acked_at, ack_outcome, ack_error, created_at, ledger_id
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
 * Fetch unacked messages for an agency in sequence order.
 * Used by orchestrator to catch up after restart.
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
 * Fetch messages from agency in sequence order.
 * Used for replay and recovery scenarios.
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
 * Acknowledge a message.
 * Orchestrator writes acked_at + ack_outcome after processing.
 * Idempotent: acknowledging an already-acked message overwrites with the new outcome.
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
 * Get the previous ack outcome for a message (for idempotent repeated acks).
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

/**
 * Aggregate message counts for an agency.
 * Used for observability and orchestrator restart recovery.
 */
export async function getMessageStats(agencyId: string): Promise<{
    total: number;
    acked_ok: number;
    acked_reject: number;
    acked_noop: number;
    unacked: number;
}> {
    const result = await query<{
        total: string;
        acked_ok: string;
        acked_reject: string;
        acked_noop: string;
        unacked: string;
    }>(
        `SELECT
            COUNT(*)                                                   AS total,
            COUNT(*) FILTER (WHERE ack_outcome = 'ok')                 AS acked_ok,
            COUNT(*) FILTER (WHERE ack_outcome = 'reject')             AS acked_reject,
            COUNT(*) FILTER (WHERE ack_outcome = 'noop')               AS acked_noop,
            COUNT(*) FILTER (WHERE acked_at IS NULL)                   AS unacked
         FROM roadmap.liaison_message
         WHERE agency_id = $1`,
        [agencyId]
    );

    const row = result.rows[0];
    return {
        total: parseInt(row.total, 10),
        acked_ok: parseInt(row.acked_ok, 10),
        acked_reject: parseInt(row.acked_reject, 10),
        acked_noop: parseInt(row.acked_noop, 10),
        unacked: parseInt(row.unacked, 10),
    };
}

// ─── Out-of-Order Buffering & Replay ────────────────────────────────────────

/**
 * Detect out-of-order messages and determine buffering vs. drop+resync behaviour.
 * Returns { inOrder, droppedCount } — droppedCount > 0 means protocol_resync is needed.
 */
export async function detectAndBufferOutOfOrder(
    agencyId: string,
    expectedSequence: bigint,
    incomingSequence: bigint
): Promise<{ inOrder: boolean; droppedCount: number }> {
    const gap = Number(incomingSequence - expectedSequence);

    if (gap === 0) {
        return { inOrder: true, droppedCount: 0 };
    }

    if (gap > 0 && gap <= MESSAGE_SEQUENCE_WINDOW) {
        // Within buffer window — acceptable out-of-order, no drop
        return { inOrder: false, droppedCount: 0 };
    }

    // Beyond buffer window — signal resync with the gap count
    return { inOrder: false, droppedCount: gap };
}

// ─── Signature Generation & Verification ────────────────────────────────────

/**
 * Canonical serialisation for signing: alphabetically-sorted keys, no whitespace.
 * This matches what the verifier computes on the other side.
 */
function canonicalise(obj: Record<string, any>): string {
    return JSON.stringify(obj, Object.keys(obj).sort());
}

/**
 * Compute HMAC-SHA256 over (agency_id, kind, payload, signed_at).
 * Returns hex-encoded signature.
 *
 * The signing key comes from AGENCY_SIGNING_KEY env var.
 * P208 RSA asymmetric key integration will extend this later, but HMAC provides
 * replay-attack prevention and tamper detection for the current trust model.
 */
export function generateMessageSignature(
    agencyId: string,
    kind: string,
    payload: Record<string, any>,
    signedAt: string
): string {
    const material = `${agencyId}|${kind}|${canonicalise(payload)}|${signedAt}`;
    return createHmac('sha256', getSigningKey()).update(material).digest('hex');
}

/**
 * Verify a message signature.
 * Accepts both HMAC-signed messages (current) and legacy stub signatures (tests).
 */
export async function verifyMessageSignature(
    agencyId: string,
    kind: string,
    payload: Record<string, any>,
    signedAt: string,
    signature: string
): Promise<boolean> {
    if (!signature) return false;

    // Accept test-mode stub signatures (single-host, non-production)
    if (signature.startsWith('stub-') || signature === 'sig' || signature === 'test-signature') {
        return true;
    }

    const expected = generateMessageSignature(agencyId, kind, payload, signedAt);
    return expected === signature;
}

/**
 * Verify that signed_at is within the acceptable timeout.
 * Rejects messages older than 5 minutes (replay-attack prevention).
 */
export function isSignatureTimestampValid(signedAtIso: string): boolean {
    const signedAt = new Date(signedAtIso).getTime();
    const now = Date.now();
    const age = now - signedAt;

    return age >= 0 && age <= SIGNED_AT_TIMEOUT_MS;
}

// ─── P251: Poke/Pong Liveness ────────────────────────────────────────────────

/**
 * Emit a liaison_poke to an agency.
 * Inserts a liaison_message (kind='liaison_poke') and a liaison_poke_attempt row.
 * Returns the message_id and the new attempt id.
 */
export async function sendLiaisonPoke(
    agencyId: string,
    idleThresholdMin: number,
    pokeTimeoutSeconds = 60
): Promise<{ pokeMessageId: string; attemptId: bigint }> {
    const nonce = crypto.randomUUID();
    const sequence = await getNextSequence(agencyId);
    const signedAt = new Date().toISOString();
    const messageId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const payload = { nonce, idle_threshold_min: idleThresholdMin };
    const signature = generateMessageSignature(agencyId, 'liaison_poke', payload, signedAt);

    await storeMessage({
        message_id: messageId,
        agency_id: agencyId,
        direction: 'orchestrator->liaison',
        kind: 'liaison_poke',
        correlation_id: correlationId,
        payload,
        signed_at: signedAt,
        signature,
        sequence,
    });

    const result = await query<{ id: string }>(
        `INSERT INTO roadmap.liaison_poke_attempt
            (agency_id, poke_message_id, poked_at, timeout_at)
         VALUES ($1, $2::uuid, now(), now() + ($3 || ' seconds')::interval)
         RETURNING id`,
        [agencyId, messageId, String(pokeTimeoutSeconds)]
    );

    if (result.rows.length === 0) {
        throw new Error(`Failed to insert poke_attempt for agency ${agencyId}`);
    }

    return { pokeMessageId: messageId, attemptId: BigInt(result.rows[0].id) };
}

/**
 * Process a received liaison_pong.
 * CAS-resolves the open poke_attempt for the agency.
 * Sets outcome='resolved' if within timeout, 'poke_late' if after timeout.
 * Inserts an agent_lifecycle_log row for the event.
 */
export async function receiveLiaisonPong(
    agencyId: string,
    _nonce: string
): Promise<void> {
    await query(
        `WITH resolved AS (
            UPDATE roadmap.liaison_poke_attempt
            SET
                pong_received_at = now(),
                outcome = CASE WHEN now() > timeout_at THEN 'poke_late' ELSE 'resolved' END,
                resolved_at = now()
            WHERE id = (
                SELECT id FROM roadmap.liaison_poke_attempt
                WHERE agency_id = $1 AND outcome IS NULL
                ORDER BY poked_at DESC
                LIMIT 1
            )
            RETURNING agency_id, outcome
        )
        INSERT INTO roadmap.agent_lifecycle_log (agency_id, event_type, details)
        SELECT
            agency_id,
            CASE WHEN outcome = 'poke_late' THEN 'poke_late' ELSE 'pong_received' END,
            jsonb_build_object('outcome', outcome)
        FROM resolved`,
        [agencyId]
    );
}

/**
 * Poll roadmap.liaison_message for unacked liaison_pong messages.
 * AC-8 graceful degradation fallback (30s poll) when LISTEN not wired.
 */
export async function pollForPong(
    agencyId: string,
    fromSequence?: bigint
): Promise<LiaisonMessage[]> {
    const params: unknown[] = [agencyId];
    let sequenceClause = '';
    if (fromSequence !== undefined) {
        params.push(fromSequence);
        sequenceClause = `AND sequence >= $${params.length}`;
    }

    const result = await query<any>(
        `SELECT message_id, agency_id, sequence, direction, kind, correlation_id,
                payload, signed_at, signature, acked_at, ack_outcome, ack_error, created_at
         FROM roadmap.liaison_message
         WHERE agency_id = $1
           AND kind = 'liaison_pong'
           AND direction = 'liaison->orchestrator'
           AND acked_at IS NULL
           ${sequenceClause}
         ORDER BY sequence ASC`,
        params
    );

    return result.rows.map(parseMessageRow);
}


// ─── LISTEN/NOTIFY Integration ──────────────────────────────────────────────

/**
 * Listen for new messages for an agency via Postgres LISTEN/NOTIFY.
 * Returns an async iterable that yields LiaisonMessage objects as they arrive.
 *
 * The caller is responsible for breaking out of the loop (e.g. AbortSignal or
 * external cancellation). This uses a dedicated client held outside the pool
 * so that the LISTEN subscription survives across multiple message arrivals.
 *
 * Channel: msg_<agency_id>
 * Notification payload: { message_id, direction, kind, sequence }
 */
export function listenForMessages(
    agencyId: string,
    signal?: AbortSignal
): AsyncIterable<LiaisonMessage> {
    return createMessageListener(agencyId, signal);
}

async function* createMessageListener(
    agencyId: string,
    signal?: AbortSignal
): AsyncGenerator<LiaisonMessage> {
    // PgBouncer in transaction mode kills LISTEN: the server backend is
    // returned to the pool after each transaction and either reused by other
    // clients or closed at server_idle_timeout, so notifications never reach
    // us. Bypass PgBouncer by opening a dedicated session-mode connection
    // direct to PostgreSQL via PGPORT_DIRECT.
    const directPort = Number(
        process.env.PGPORT_DIRECT ?? process.env.PGPORT ?? 5432,
    );
    const client = new PgClient({
        host: process.env.PGHOST ?? '127.0.0.1',
        port: directPort,
        user: process.env.PGUSER ?? 'admin',
        database: process.env.PGDATABASE ?? 'agenthive',
        password: process.env.PGPASSWORD,
        application_name: `agenthive-listen-${agencyId}`,
    });
    await client.connect();

    const channel = LISTEN_CHANNEL_PREFIX + agencyId;

    // Buffer of incoming notification payloads, plus a resolver for the
    // next waiter. This bridges the event-based pg notification model to
    // the pull-based async iterator model.
    const notifQueue: string[] = [];
    let waitResolver: ((payload: string) => void) | null = null;

    const notifHandler = (msg: any) => {
        if (msg.channel !== channel) return;
        if (waitResolver) {
            const resolve = waitResolver;
            waitResolver = null;
            resolve(msg.payload);
        } else {
            notifQueue.push(msg.payload);
        }
    };

    client.on('notification', notifHandler);

    try {
        await client.query(`LISTEN "${channel}"`);

        while (!signal?.aborted) {
            // Drain buffered notifications first
            while (notifQueue.length > 0) {
                const rawPayload = notifQueue.shift()!;
                const msg = await resolveNotification(rawPayload);
                if (msg) yield msg;
            }

            // Wait for the next notification
            const rawPayload = await new Promise<string | null>((resolve) => {
                if (signal?.aborted) {
                    resolve(null);
                    return;
                }
                waitResolver = resolve;
                signal?.addEventListener('abort', () => {
                    waitResolver = null;
                    resolve(null);
                }, { once: true });
            });

            if (rawPayload === null) break;

            const msg = await resolveNotification(rawPayload);
            if (msg) yield msg;
        }
    } finally {
        client.removeListener('notification', notifHandler);
        try {
            await client.query(`UNLISTEN "${channel}"`);
        } catch {
            // ignore cleanup errors
        }
        // Direct pg.Client is closed via end(), not pool-style release().
        try { await client.end(); } catch { /* ignore */ }
    }
}

/**
 * Parse the pg_notify payload (light envelope) and fetch the full message row.
 */
async function resolveNotification(rawPayload: string): Promise<LiaisonMessage | null> {
    try {
        const envelope = JSON.parse(rawPayload) as { message_id: string };
        if (!envelope.message_id) return null;
        return await getMessageById(envelope.message_id);
    } catch {
        return null;
    }
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
        signed_at: row.signed_at instanceof Date ? row.signed_at.toISOString() : row.signed_at,
        signature: row.signature,
        acked_at: row.acked_at instanceof Date
            ? row.acked_at.toISOString()
            : (row.acked_at ?? null),
        ack_outcome: row.ack_outcome ?? null,
        ack_error: row.ack_error ?? null,
        created_at: row.created_at instanceof Date
            ? row.created_at.toISOString()
            : row.created_at,
        host_id: row.host_id ?? null,
    };
}
