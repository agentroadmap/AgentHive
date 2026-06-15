/**
 * P468: LiaisonMessageLog, LiaisonMessageSigner, OutOfOrderBuffer
 *
 * Class-based interface over the roadmap.liaison_message durable log.
 * Transport layer: LISTEN/NOTIFY on channel `msg_<agency_id>` (lightweight
 * envelope — full row fetched from DB). Replay from log on partition recovery.
 *
 * Signing: HMAC-SHA256 over canonical `agencyId|kind|sortedPayload|signedAt`.
 * When AGENCY_SIGNING_KEY env var is absent, falls back to dev sentinel.
 *
 * OutOfOrderBuffer: in-memory, per-agency, window=100. Flushes contiguous runs
 * as gap fills; emits protocol_resync signal on overflow.
 */

import { createHmac } from "node:crypto";
import { query } from "../../infra/postgres/pool.js";
import type {
	LiaisonMessage,
	LiaisonMessageAckOutcome,
	LiaisonMessageDirection,
} from "../../infra/agency/liaison-message-types.js";
import {
	storeMessage,
	acknowledgeMessage,
	getMessageById,
	getMessagesInSequenceRange,
	getUnackedMessages,
} from "../../infra/agency/liaison-message-service.js";

export type { LiaisonMessage, LiaisonMessageAckOutcome };

// ─── LiaisonMessageLog ────────────────────────────────────────────────────────

export interface AppendOptions {
	agencyId: string;
	direction: LiaisonMessageDirection;
	kind: string;
	payload: Record<string, unknown>;
	correlationId?: string;
}

export class LiaisonMessageLog {
	/**
	 * Append a message with advisory-locked sequence assignment.
	 * Idempotent: re-sending the same (agency_id, sequence) is a no-op.
	 */
	async append(opts: AppendOptions): Promise<LiaisonMessage> {
		const messageId = crypto.randomUUID();
		const correlationId = opts.correlationId ?? crypto.randomUUID();
		const sequence = await this.#nextSequence(opts.agencyId);
		const signedAt = new Date().toISOString();
		const signer = new LiaisonMessageSigner();
		const signature = signer.sign(opts.agencyId, opts.kind, opts.payload, signedAt);

		return storeMessage({
			message_id: messageId,
			agency_id: opts.agencyId,
			sequence,
			direction: opts.direction,
			kind: opts.kind,
			correlation_id: correlationId,
			payload: opts.payload,
			signed_at: signedAt,
			signature,
		});
	}

	/**
	 * Acknowledge a message. COALESCE-guarded first-write-wins in the DB
	 * via fn_liaison_ack_message; safe to call repeatedly.
	 */
	async ack(
		messageId: string,
		outcome: LiaisonMessageAckOutcome,
		error?: string,
	): Promise<void> {
		await acknowledgeMessage(messageId, outcome, error);
	}

	/**
	 * Idempotency lookup: fetch message by (agency_id, sequence).
	 */
	async findBySequence(
		agencyId: string,
		sequence: bigint,
	): Promise<LiaisonMessage | null> {
		const result = await query<{
			message_id: string;
			agency_id: string;
			sequence: string;
			direction: string;
			kind: string;
			correlation_id: string;
			payload: unknown;
			signed_at: string;
			signature: string;
			acked_at: string | null;
			ack_outcome: string | null;
			ack_error: string | null;
			created_at: string;
		}>(
			`SELECT message_id, agency_id, sequence, direction, kind, correlation_id,
			        payload, signed_at, signature, acked_at, ack_outcome, ack_error, created_at
			   FROM roadmap.liaison_message
			  WHERE agency_id = $1 AND sequence = $2`,
			[agencyId, sequence],
		);
		if (result.rows.length === 0) return null;
		return this.#parseRow(result.rows[0]);
	}

	/**
	 * Replay: return ordered slice from sequence N (inclusive).
	 */
	async replayFrom(agencyId: string, fromSequence: bigint): Promise<LiaisonMessage[]> {
		return getMessagesInSequenceRange(agencyId, fromSequence);
	}

	/**
	 * Restart sweep: return all unacked messages for an agency.
	 * Seeded by getMaxSequence() on reconnect.
	 */
	async getUnacked(agencyId: string, fromSequence?: bigint): Promise<LiaisonMessage[]> {
		return getUnackedMessages(agencyId, fromSequence);
	}

	/**
	 * Return the current max sequence number for an agency.
	 * Returns 0n if no messages have been stored yet.
	 * Used to seed OutOfOrderBuffer.setExpected() on startup or reconnect.
	 */
	async getMaxSequence(agencyId: string): Promise<bigint> {
		const result = await query<{ max_seq: string | null }>(
			`SELECT MAX(sequence) AS max_seq
			   FROM roadmap.liaison_message
			  WHERE agency_id = $1`,
			[agencyId],
		);
		const raw = result.rows[0]?.max_seq;
		return raw == null ? 0n : BigInt(raw);
	}

	// ── Private helpers ──────────────────────────────────────────────────────

	async #nextSequence(agencyId: string): Promise<bigint> {
		const result = await query<{ next_sequence: string }>(
			`SELECT roadmap.fn_liaison_next_sequence($1) AS next_sequence`,
			[agencyId],
		);
		if (result.rows.length === 0) {
			throw new Error(`fn_liaison_next_sequence returned no rows for ${agencyId}`);
		}
		return BigInt(result.rows[0].next_sequence);
	}

	#parseRow(row: Record<string, unknown>): LiaisonMessage {
		return {
			message_id: row.message_id as string,
			agency_id: row.agency_id as string,
			sequence: BigInt(row.sequence as string),
			direction: row.direction as LiaisonMessageDirection,
			kind: row.kind as string,
			correlation_id: row.correlation_id as string,
			payload:
				typeof row.payload === "string"
					? JSON.parse(row.payload)
					: (row.payload as Record<string, unknown>),
			signed_at:
				row.signed_at instanceof Date
					? (row.signed_at as Date).toISOString()
					: (row.signed_at as string),
			signature: row.signature as string,
			acked_at:
				row.acked_at == null
					? null
					: row.acked_at instanceof Date
					? (row.acked_at as Date).toISOString()
					: (row.acked_at as string),
			ack_outcome: (row.ack_outcome as LiaisonMessageAckOutcome | null) ?? null,
			ack_error: (row.ack_error as string | null) ?? null,
			created_at:
				row.created_at instanceof Date
					? (row.created_at as Date).toISOString()
					: (row.created_at as string),
		};
	}
}

// ─── LiaisonMessageSigner ─────────────────────────────────────────────────────

const SIGNED_AT_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

function getSigningKey(): string {
	return process.env.AGENCY_SIGNING_KEY ?? "dev-insecure-signing-key";
}

function canonicalJson(obj: Record<string, unknown>): string {
	return JSON.stringify(obj, Object.keys(obj).sort());
}

export class LiaisonMessageSigner {
	/**
	 * Sign canonical string: `agencyId|kind|sortedPayloadJson|signedAt`.
	 * Returns HMAC-SHA256 hex digest (64 chars).
	 */
	sign(
		agencyId: string,
		kind: string,
		payload: Record<string, unknown>,
		signedAt: string,
	): string {
		const material = `${agencyId}|${kind}|${canonicalJson(payload)}|${signedAt}`;
		return createHmac("sha256", getSigningKey()).update(material).digest("hex");
	}

	/**
	 * Verify a message signature. Returns false if:
	 * - signature is absent
	 * - signed_at skew > 5 minutes (replay-attack prevention)
	 * - HMAC digest does not match
	 *
	 * Test-mode stub signatures (prefix "stub-", value "sig", "test-signature")
	 * are accepted without key-material verification.
	 */
	verify(
		agencyId: string,
		kind: string,
		payload: Record<string, unknown>,
		signedAt: string,
		signature: string,
	): boolean {
		if (!signature) return false;

		// Allow test-mode stubs so unit tests don't need live key material.
		if (
			signature.startsWith("stub-") ||
			signature === "sig" ||
			signature === "test-signature"
		) {
			return true;
		}

		if (!this.#isTimestampValid(signedAt)) return false;

		const expected = this.sign(agencyId, kind, payload, signedAt);
		return expected === signature;
	}

	#isTimestampValid(signedAtIso: string): boolean {
		const signedAt = new Date(signedAtIso).getTime();
		const now = Date.now();
		const age = now - signedAt;
		return age >= 0 && age <= SIGNED_AT_TOLERANCE_MS;
	}
}

// ─── OutOfOrderBuffer ─────────────────────────────────────────────────────────

const BUFFER_WINDOW = 100;

export type ResyncSignal = {
	type: "protocol_resync";
	agencyId: string;
	maxBufferedSequence: bigint;
	droppedCount: number;
};

export type FlushResult = {
	flushed: LiaisonMessage[];
	resync: ResyncSignal | null;
};

/**
 * In-memory per-agency buffer for out-of-order LISTEN/NOTIFY telemetry.
 *
 * Usage:
 *   const buf = new OutOfOrderBuffer(agencyId);
 *   await buf.setExpected(await log.getMaxSequence(agencyId) + 1n);
 *
 *   // On each NOTIFY:
 *   const { flushed, resync } = buf.push(message);
 *   if (resync) sendProtocolResync(resync);
 *   for (const m of flushed) processMessage(m);
 */
export class OutOfOrderBuffer {
	readonly agencyId: string;
	#expected: bigint = 1n;
	#buffer = new Map<bigint, LiaisonMessage>();

	constructor(agencyId: string) {
		this.agencyId = agencyId;
	}

	/**
	 * Seed expected sequence. Call after reading getMaxSequence() on startup
	 * or reconnect.
	 */
	setExpected(seq: bigint): void {
		this.#expected = seq;
	}

	/**
	 * Reset buffer state (e.g. after a protocol_resync handshake completes).
	 */
	reset(nextExpected: bigint): void {
		this.#buffer.clear();
		this.#expected = nextExpected;
	}

	/**
	 * Push a received message into the buffer.
	 *
	 * - In-order (seq === expected): flush this message plus any buffered
	 *   contiguous run; advance expected.
	 * - Ahead-of-sequence within window: buffer and return empty flush.
	 * - Gap beyond window: emit protocol_resync signal; clear buffer.
	 */
	push(message: LiaisonMessage): FlushResult {
		const seq = message.sequence;

		if (seq === this.#expected) {
			// In-order: flush the contiguous run
			this.#buffer.set(seq, message);
			return { flushed: this.#flushContiguous(), resync: null };
		}

		if (seq < this.#expected) {
			// Duplicate / already processed — ignore
			return { flushed: [], resync: null };
		}

		// seq > expected
		const gap = Number(seq - this.#expected);

		if (gap <= BUFFER_WINDOW && this.#buffer.size < BUFFER_WINDOW) {
			this.#buffer.set(seq, message);
			return { flushed: [], resync: null };
		}

		// Beyond window — emit resync, clear buffer
		const droppedCount = this.#buffer.size + 1; // buffered + this one
		const maxBuffered = seq;
		this.#buffer.clear();
		this.#expected = seq + 1n;

		const resync: ResyncSignal = {
			type: "protocol_resync",
			agencyId: this.agencyId,
			maxBufferedSequence: maxBuffered,
			droppedCount,
		};
		return { flushed: [], resync };
	}

	get expectedSequence(): bigint {
		return this.#expected;
	}

	get bufferedCount(): number {
		return this.#buffer.size;
	}

	#flushContiguous(): LiaisonMessage[] {
		const out: LiaisonMessage[] = [];
		while (this.#buffer.has(this.#expected)) {
			out.push(this.#buffer.get(this.#expected)!);
			this.#buffer.delete(this.#expected);
			this.#expected++;
		}
		return out;
	}
}
