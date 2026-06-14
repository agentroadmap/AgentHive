/**
 * P1438 C6 AC-17 (minimal coordination surface) + AC-11 (representation).
 *
 * The explicit liaison-to-liaison protocol for C6 is limited to exactly three
 * verbs:
 *   - capacity_query   — on-demand, non-authoritative until the AI liaison
 *                        answers it from LIVE quota/inflight (NOT a canned pong).
 *   - handoff_request  — targeted/specialized work offered directly to one
 *                        agency; accepted only if it can actually serve it.
 *   - capability_gap   — records that no current agency can serve a needed
 *                        capability.
 *
 * Each verb is a deterministic handler (no LLM) so the coordination surface is
 * testable and cannot fall through to the generic auto-reply path. The `query`
 * and reply helpers are injected so the handlers unit-test without a live DB.
 *
 * Loop safety: a verb message that itself carries `reply_to` is the ANSWER to a
 * query we sent — it is consumed, never answered again (mirrors the reply-loop
 * breaker in liaison-agent.ts).
 */

import type { IncomingMessage } from "./liaison-agent.ts";

/** The fetched ledger row is wider than IncomingMessage (adds reply_to/read_at). */
export interface A2AVerbMessage extends IncomingMessage {
	reply_to?: number | null;
	read_at?: string | null;
}

export type VerbQueryFn = (
	sql: string,
	params?: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>;

export type VerbInsertReplyFn = (args: {
	fromAgent: string;
	toAgent: string;
	content: string;
	messageType: string;
	correlationId: string | null;
	replyTo: number;
	metadata?: Record<string, unknown>;
}) => Promise<number>;

export type VerbBridgeFn = (args: {
	msg: IncomingMessage;
	identity: string;
	provider: string;
}) => Promise<{ dispatchId: number }>;

export interface VerbHelpers {
	query: VerbQueryFn;
	insertReply: VerbInsertReplyFn;
	markRead: (messageId: number) => Promise<void>;
	bridgeTaskToOfferDispatch?: VerbBridgeFn;
	provider?: string;
	log?: string;
}

export interface VerbOutcome {
	action: string;
	replyId?: number;
	dispatchId?: number;
}

/** The three C6 coordination verbs. */
export const A2A_VERBS = [
	"capacity_query",
	"handoff_request",
	"capability_gap",
] as const;
export type A2AVerb = (typeof A2A_VERBS)[number];

export function isA2AVerb(messageType: string): messageType is A2AVerb {
	return (A2A_VERBS as readonly string[]).includes(messageType);
}

export interface CapacitySnapshot {
	found: boolean;
	agencyIdentity: string;
	maxInFlight: number;
	inFlightCount: number;
	headroom: number;
	agencyStatus: string | null;
}

/**
 * Resolve an agency's LIVE capacity by identity. Reuses the exact join path the
 * AgencyClaimLoop uses for its own capacity gate (agency-claim-loop.ts:266):
 * agent_registry → provider_registry → v_agency_in_flight. This is what makes
 * capacity_query "substantive ... sourced from live quota/inflight" (AC-11),
 * not a canned reply.
 */
export async function readAgencyCapacity(
	identity: string,
	query: VerbQueryFn,
): Promise<CapacitySnapshot> {
	const { rows } = await query(
		`SELECT pr.max_in_flight,
		        COALESCE(inf.in_flight_count, 0) AS in_flight_count,
		        inf.agency_status
		   FROM roadmap_workforce.provider_registry pr
		   JOIN roadmap_workforce.agent_registry ar ON ar.id = pr.agency_id
		   LEFT JOIN roadmap_workforce.v_agency_in_flight inf
		          ON inf.provider_registry_id = pr.id
		  WHERE ar.agent_identity = $1
		  LIMIT 1`,
		[identity],
	);
	if (rows.length === 0) {
		return {
			found: false,
			agencyIdentity: identity,
			maxInFlight: 0,
			inFlightCount: 0,
			headroom: 0,
			agencyStatus: null,
		};
	}
	const row = rows[0];
	const maxInFlight = Number(row.max_in_flight ?? 0);
	const inFlightCount = Number(row.in_flight_count ?? 0);
	return {
		found: true,
		agencyIdentity: identity,
		maxInFlight,
		inFlightCount,
		headroom: Math.max(0, maxInFlight - inFlightCount),
		agencyStatus: (row.agency_status as string | null) ?? null,
	};
}

function stringFrom(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function extractNeededCapability(msg: A2AVerbMessage): string | null {
	const md = msg.metadata ?? {};
	return (
		stringFrom(md.capability) ??
		stringFrom(md.needed_capability) ??
		stringFrom(md.capability_gap) ??
		stringFrom((md.gap as Record<string, unknown> | undefined)?.capability) ??
		null
	);
}

/**
 * AC-11 + AC-17 capacity_query: answer with a live capacity snapshot. A
 * capacity_query carrying reply_to is the answer to our own query — consume it.
 */
export async function handleCapacityQuery(
	msg: A2AVerbMessage,
	identity: string,
	h: VerbHelpers,
): Promise<VerbOutcome> {
	if (msg.reply_to != null) {
		await h.markRead(msg.id);
		return { action: "consumed_response" };
	}
	const snap = await readAgencyCapacity(identity, h.query);
	const content = snap.found
		? `capacity ${identity}: in_flight=${snap.inFlightCount}/${snap.maxInFlight} ` +
			`headroom=${snap.headroom} status=${snap.agencyStatus ?? "unknown"}`
		: `capacity ${identity}: unavailable (no provider_registry row)`;
	const replyId = await h.insertReply({
		fromAgent: identity,
		toAgent: msg.from_agent,
		content,
		messageType: "capacity_query",
		correlationId: msg.correlation_id ?? null,
		replyTo: msg.id,
		metadata: { capacity: snap },
	});
	await h.markRead(msg.id);
	return { action: snap.found ? "answered" : "answered_unavailable", replyId };
}

/**
 * AC-17 handoff_request: targeted/specialized work offered directly. Accept only
 * if the agency can actually serve it (has headroom + a working bridge);
 * otherwise decline explicitly. A handoff_request carrying reply_to is the
 * response to our own request — consume it.
 */
export async function handleHandoffRequest(
	msg: A2AVerbMessage,
	identity: string,
	h: VerbHelpers,
): Promise<VerbOutcome> {
	if (msg.reply_to != null) {
		await h.markRead(msg.id);
		return { action: "consumed_response" };
	}
	const snap = await readAgencyCapacity(identity, h.query);
	if (!snap.found || snap.headroom <= 0 || !h.bridgeTaskToOfferDispatch) {
		const reason = !snap.found
			? "unavailable"
			: snap.headroom <= 0
				? "at_capacity"
				: "no_bridge";
		const detail = snap.found
			? `at capacity (${snap.inFlightCount}/${snap.maxInFlight})`
			: "agency unavailable";
		const replyId = await h.insertReply({
			fromAgent: identity,
			toAgent: msg.from_agent,
			content: `handoff declined by ${identity}: ${detail}`,
			messageType: "handoff_request",
			correlationId: msg.correlation_id ?? null,
			replyTo: msg.id,
			metadata: { accepted: false, reason, capacity: snap },
		});
		await h.markRead(msg.id);
		return { action: "declined", replyId };
	}
	try {
		const result = await h.bridgeTaskToOfferDispatch({
			msg,
			identity,
			provider: h.provider ?? "claude",
		});
		const replyId = await h.insertReply({
			fromAgent: identity,
			toAgent: msg.from_agent,
			content: `handoff accepted by ${identity}; dispatch ${result.dispatchId} queued.`,
			messageType: "handoff_request",
			correlationId: msg.correlation_id ?? null,
			replyTo: msg.id,
			metadata: { accepted: true, dispatchId: result.dispatchId },
		});
		await h.markRead(msg.id);
		return { action: "accepted", replyId, dispatchId: result.dispatchId };
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		const replyId = await h.insertReply({
			fromAgent: identity,
			toAgent: msg.from_agent,
			content: `handoff failed at ${identity}: ${detail}`,
			messageType: "error",
			correlationId: msg.correlation_id ?? null,
			replyTo: msg.id,
			metadata: { accepted: false, reason: "error", detail },
		});
		await h.markRead(msg.id);
		return { action: "error", replyId };
	}
}

/**
 * AC-17 capability_gap: records that no current agency can serve a needed
 * capability. The inbound ledger row is the durable record; we also send a
 * non-null ack so the reporter has confirmation of persistence. An ack
 * carrying reply_to is consumed.
 */
export async function handleCapabilityGap(
	msg: A2AVerbMessage,
	identity: string,
	h: VerbHelpers,
): Promise<VerbOutcome> {
	if (msg.reply_to != null) {
		await h.markRead(msg.id);
		return { action: "consumed_ack" };
	}
	const capability = extractNeededCapability(msg);
	const replyId = await h.insertReply({
		fromAgent: identity,
		toAgent: msg.from_agent,
		content:
			`capability_gap recorded by ${identity}: ` +
			`'${capability ?? "unspecified"}' has no serving agency (ref msg ${msg.id})`,
		messageType: "ack",
		correlationId: msg.correlation_id ?? null,
		replyTo: msg.id,
		metadata: {
			capability_gap: {
				capability: capability ?? null,
				source_message_id: msg.id,
				reported_by: msg.from_agent,
			},
		},
	});
	await h.markRead(msg.id);
	return { action: "recorded", replyId };
}

/** Route a C6 coordination verb to its handler. Caller must pre-check isA2AVerb. */
export async function routeA2AVerb(
	msg: A2AVerbMessage,
	identity: string,
	h: VerbHelpers,
): Promise<VerbOutcome> {
	switch (msg.message_type) {
		case "capacity_query":
			return handleCapacityQuery(msg, identity, h);
		case "handoff_request":
			return handleHandoffRequest(msg, identity, h);
		case "capability_gap":
			return handleCapabilityGap(msg, identity, h);
		default:
			return { action: "ignored" };
	}
}
