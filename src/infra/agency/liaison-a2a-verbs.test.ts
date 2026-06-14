/**
 * P1438 C6 AC-17 (coordination verbs) + AC-11 (representation).
 *
 * Tests the three liaison↔liaison verbs end-to-end at the handler level with an
 * injected query/reply/bridge — proving:
 *   - capacity_query answers from LIVE inflight/max (not a canned pong) and the
 *     reply carries a non-null body + structured capacity (AC-11).
 *   - handoff_request accepts only with headroom (bridges to a dispatch) and
 *     declines explicitly at capacity.
 *   - capability_gap records the gap with a non-null ack body.
 *   - any verb carrying reply_to is consumed (loop safety), never re-answered.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	handleCapacityQuery,
	handleHandoffRequest,
	handleCapabilityGap,
	routeA2AVerb,
	readAgencyCapacity,
	isA2AVerb,
	type A2AVerbMessage,
	type VerbHelpers,
} from "./liaison-a2a-verbs.ts";

const IDENTITY = "claude-bot-gary.a";

function baseMsg(over: Partial<A2AVerbMessage>): A2AVerbMessage {
	return {
		id: 1,
		from_agent: "peer-bot.a",
		to_agent: IDENTITY,
		message_content: "",
		message_type: "capacity_query",
		proposal_id: null,
		project_id: null,
		metadata: {},
		correlation_id: "corr-1",
		reply_to: null,
		...over,
	};
}

function makeHelpers(over: Partial<VerbHelpers> = {}): {
	helpers: VerbHelpers;
	insertReply: ReturnType<typeof vi.fn>;
	markRead: ReturnType<typeof vi.fn>;
	bridge: ReturnType<typeof vi.fn>;
	query: ReturnType<typeof vi.fn>;
} {
	const insertReply = vi.fn().mockResolvedValue(999);
	const markRead = vi.fn().mockResolvedValue(undefined);
	const bridge = vi.fn().mockResolvedValue({ dispatchId: 555 });
	const query = vi.fn();
	const helpers: VerbHelpers = {
		query,
		insertReply,
		markRead,
		bridgeTaskToOfferDispatch: bridge,
		provider: "claude",
		log: "[test]",
		...over,
	};
	return { helpers, insertReply, markRead, bridge, query };
}

function capacityRows(maxInFlight: number, inFlight: number, status = "active") {
	return {
		rows: [
			{
				max_in_flight: maxInFlight,
				in_flight_count: inFlight,
				agency_status: status,
			},
		],
	};
}

describe("isA2AVerb", () => {
	it("recognises exactly the three C6 verbs", () => {
		expect(isA2AVerb("capacity_query")).toBe(true);
		expect(isA2AVerb("handoff_request")).toBe(true);
		expect(isA2AVerb("capability_gap")).toBe(true);
		expect(isA2AVerb("task_request")).toBe(false);
		expect(isA2AVerb("text")).toBe(false);
	});
});

describe("readAgencyCapacity", () => {
	it("computes headroom = max - inflight from the live join", async () => {
		const query = vi.fn().mockResolvedValue(capacityRows(4, 1));
		const snap = await readAgencyCapacity(IDENTITY, query);
		expect(snap).toEqual({
			found: true,
			agencyIdentity: IDENTITY,
			maxInFlight: 4,
			inFlightCount: 1,
			headroom: 3,
			agencyStatus: "active",
		});
	});

	it("reports not-found (no provider_registry row)", async () => {
		const query = vi.fn().mockResolvedValue({ rows: [] });
		const snap = await readAgencyCapacity(IDENTITY, query);
		expect(snap.found).toBe(false);
		expect(snap.headroom).toBe(0);
	});

	it("never reports negative headroom when over capacity", async () => {
		const query = vi.fn().mockResolvedValue(capacityRows(1, 3));
		const snap = await readAgencyCapacity(IDENTITY, query);
		expect(snap.headroom).toBe(0);
	});
});

describe("AC-11 + AC-17 capacity_query", () => {
	it("answers a query with a substantive live snapshot (non-null body + metadata)", async () => {
		const { helpers, insertReply, markRead, query } = makeHelpers();
		query.mockResolvedValue(capacityRows(4, 1));

		const out = await handleCapacityQuery(baseMsg({}), IDENTITY, helpers);

		expect(out.action).toBe("answered");
		expect(out.replyId).toBe(999);
		expect(insertReply).toHaveBeenCalledOnce();
		const reply = insertReply.mock.calls[0][0];
		expect(reply.messageType).toBe("capacity_query");
		expect(reply.replyTo).toBe(1);
		// non-null, substantive body — not a canned pong
		expect(reply.content).toMatch(/in_flight=1\/4/);
		expect(reply.content).toMatch(/headroom=3/);
		expect(reply.content.length).toBeGreaterThan(0);
		expect(reply.metadata?.capacity).toMatchObject({ headroom: 3, found: true });
		expect(markRead).toHaveBeenCalledWith(1);
	});

	it("answers 'unavailable' when no provider_registry row exists", async () => {
		const { helpers, insertReply, query } = makeHelpers();
		query.mockResolvedValue({ rows: [] });
		const out = await handleCapacityQuery(baseMsg({}), IDENTITY, helpers);
		expect(out.action).toBe("answered_unavailable");
		expect(insertReply.mock.calls[0][0].content).toMatch(/unavailable/);
	});

	it("consumes a capacity_query that is itself a reply (no re-answer)", async () => {
		const { helpers, insertReply, markRead } = makeHelpers();
		const out = await handleCapacityQuery(
			baseMsg({ reply_to: 42 }),
			IDENTITY,
			helpers,
		);
		expect(out.action).toBe("consumed_response");
		expect(insertReply).not.toHaveBeenCalled();
		expect(markRead).toHaveBeenCalledWith(1);
	});
});

describe("AC-17 handoff_request", () => {
	it("accepts and bridges to a dispatch when there is headroom", async () => {
		const { helpers, insertReply, bridge, query } = makeHelpers();
		query.mockResolvedValue(capacityRows(4, 1));

		const out = await handleHandoffRequest(
			baseMsg({ message_type: "handoff_request", proposal_id: 4242 }),
			IDENTITY,
			helpers,
		);

		expect(out.action).toBe("accepted");
		expect(out.dispatchId).toBe(555);
		expect(bridge).toHaveBeenCalledOnce();
		const reply = insertReply.mock.calls[0][0];
		expect(reply.metadata).toMatchObject({ accepted: true, dispatchId: 555 });
		expect(reply.content).toMatch(/accepted/);
	});

	it("declines at capacity without calling the bridge", async () => {
		const { helpers, insertReply, bridge, query } = makeHelpers();
		query.mockResolvedValue(capacityRows(1, 1));

		const out = await handleHandoffRequest(
			baseMsg({ message_type: "handoff_request" }),
			IDENTITY,
			helpers,
		);

		expect(out.action).toBe("declined");
		expect(bridge).not.toHaveBeenCalled();
		expect(insertReply.mock.calls[0][0].metadata).toMatchObject({
			accepted: false,
			reason: "at_capacity",
		});
	});

	it("declines when the agency is unknown", async () => {
		const { helpers, bridge, query } = makeHelpers();
		query.mockResolvedValue({ rows: [] });
		const out = await handleHandoffRequest(
			baseMsg({ message_type: "handoff_request" }),
			IDENTITY,
			helpers,
		);
		expect(out.action).toBe("declined");
		expect(bridge).not.toHaveBeenCalled();
	});

	it("reports an error reply when the bridge throws", async () => {
		const { helpers, insertReply, query, bridge } = makeHelpers();
		query.mockResolvedValue(capacityRows(4, 0));
		bridge.mockRejectedValue(new Error("no proposal_id"));
		const out = await handleHandoffRequest(
			baseMsg({ message_type: "handoff_request" }),
			IDENTITY,
			helpers,
		);
		expect(out.action).toBe("error");
		expect(insertReply.mock.calls[0][0].messageType).toBe("error");
		expect(insertReply.mock.calls[0][0].content).toMatch(/no proposal_id/);
	});

	it("consumes a handoff_request that is itself a reply", async () => {
		const { helpers, insertReply, bridge } = makeHelpers();
		const out = await handleHandoffRequest(
			baseMsg({ message_type: "handoff_request", reply_to: 7 }),
			IDENTITY,
			helpers,
		);
		expect(out.action).toBe("consumed_response");
		expect(insertReply).not.toHaveBeenCalled();
		expect(bridge).not.toHaveBeenCalled();
	});
});

describe("AC-17 capability_gap", () => {
	it("records the gap with a non-null ack body + structured metadata", async () => {
		const { helpers, insertReply, markRead } = makeHelpers();
		const out = await handleCapabilityGap(
			baseMsg({
				message_type: "capability_gap",
				metadata: { capability: "rust-embedded" },
			}),
			IDENTITY,
			helpers,
		);

		expect(out.action).toBe("recorded");
		const reply = insertReply.mock.calls[0][0];
		expect(reply.messageType).toBe("ack");
		expect(reply.content).toMatch(/rust-embedded/);
		expect(reply.content.length).toBeGreaterThan(0);
		expect(reply.metadata?.capability_gap).toMatchObject({
			capability: "rust-embedded",
			source_message_id: 1,
			reported_by: "peer-bot.a",
		});
		expect(markRead).toHaveBeenCalledWith(1);
	});

	it("records 'unspecified' when no capability is named", async () => {
		const { helpers, insertReply } = makeHelpers();
		const out = await handleCapabilityGap(
			baseMsg({ message_type: "capability_gap", metadata: {} }),
			IDENTITY,
			helpers,
		);
		expect(out.action).toBe("recorded");
		expect(insertReply.mock.calls[0][0].content).toMatch(/unspecified/);
	});

	it("consumes a capability_gap ack carrying reply_to", async () => {
		const { helpers, insertReply } = makeHelpers();
		const out = await handleCapabilityGap(
			baseMsg({ message_type: "capability_gap", reply_to: 9 }),
			IDENTITY,
			helpers,
		);
		expect(out.action).toBe("consumed_ack");
		expect(insertReply).not.toHaveBeenCalled();
	});
});

describe("routeA2AVerb", () => {
	it("dispatches each verb to its handler", async () => {
		const { helpers, query } = makeHelpers();
		query.mockResolvedValue(capacityRows(4, 0));

		expect(
			(await routeA2AVerb(baseMsg({ message_type: "capacity_query" }), IDENTITY, helpers)).action,
		).toBe("answered");
		expect(
			(await routeA2AVerb(baseMsg({ message_type: "handoff_request", proposal_id: 1 }), IDENTITY, helpers)).action,
		).toBe("accepted");
		expect(
			(await routeA2AVerb(baseMsg({ message_type: "capability_gap" }), IDENTITY, helpers)).action,
		).toBe("recorded");
	});
});
