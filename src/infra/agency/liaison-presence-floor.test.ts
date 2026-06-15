/**
 * P1438 C6 AC-14 (no mechanical presence floor) + AC-15 (wake is not presence).
 *
 * AC-14: no heartbeat-derived agency dispatchability path remains for open-pool
 *        offers. The legacy offer_dispatch downlink push is gated OFF by default
 *        (isLegacyPushDispatchEnabled), and the agency-side claim decision reads
 *        no dispatchable/heartbeat/presence state.
 * AC-15: a wake (work_offers NOTIFY) on a parked claim loop drives a claim
 *        attempt but writes NO availability/dispatchable/presence/heartbeat row
 *        — if the session does not claim, no presence is asserted.
 *
 * The claim loop is driven with an injected recording query + a fake listener so
 * every SQL statement the wake→claim path issues is captured and audited.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// The claim decision's helper modules are mocked so the test isolates exactly
// what SQL the claim path itself issues (auth ok, policy allows, capacity high).
vi.mock("../../core/orchestration/provider-auth.ts", () => ({
	isProviderAuthDown: vi.fn(async () => false),
}));
vi.mock("./subscription-policy.ts", () => ({
	evaluateSubscriptionPolicy: vi.fn(async () => ({ allowed: true })),
	declareThrottle: vi.fn(async () => {}),
}));
vi.mock("./offer-dispatch-handler.ts", () => ({
	readAgencyMaxInFlight: vi.fn(async () => 10),
	handleOfferDispatch: vi.fn(async () => {}),
}));
import { AgencyClaimLoop } from "./agency-claim-loop.ts";
import { isLegacyPushDispatchEnabled } from "../../core/orchestration/legacy-push-dispatch-gate.ts";
import * as runtimeConfig from "../../shared/runtime/config.ts";

const PRESENCE_PATTERN =
	/dispatchable|last_heartbeat|presence_state|v_agency_status|fn_pulse|liaison_poke/i;
const AGENCY_WRITE_PATTERN =
	/(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+roadmap\.agency\b/i;

describe("P1438 AC-14: legacy push-dispatch gate", () => {
	beforeEach(() => vi.restoreAllMocks());

	it("defaults OFF when the runtime config resolver is not initialized (fail-closed)", async () => {
		// The real resolver throws "Resolver not initialized" when initConfig() was
		// never called (the test env). The gate must swallow that and fail closed.
		vi.spyOn(runtimeConfig, "get").mockImplementation(() => {
			throw new Error("Resolver not initialized");
		});
		expect(await isLegacyPushDispatchEnabled()).toBe(false);
	});

	it("is OFF when the flag resolves false", async () => {
		vi.spyOn(runtimeConfig, "get").mockResolvedValue(false as never);
		expect(await isLegacyPushDispatchEnabled()).toBe(false);
	});

	it("is ON only when an operator explicitly sets the flag true", async () => {
		vi.spyOn(runtimeConfig, "get").mockResolvedValue(true as never);
		expect(await isLegacyPushDispatchEnabled()).toBe(true);
	});
});

describe("P1438 AC-14 + AC-15: wake→claim path reads/writes no presence", () => {
	function makeLoop() {
		const sql: string[] = [];
		const queryFn = vi.fn(async (text: string) => {
			sql.push(text);
			if (/fn_claim_work_offer/.test(text)) return { rows: [] }; // no offer to claim
			if (/in_flight_count/.test(text)) return { rows: [{ in_flight_count: 0 }] };
			return { rows: [] };
		});

		let notifyHandler: ((m: { channel: string }) => void) | undefined;
		const listenerQueries: string[] = [];
		const fakeClient = {
			query: vi.fn(async (t: string) => {
				listenerQueries.push(t);
				return {};
			}),
			on: (event: string, h: (m: { channel: string }) => void) => {
				if (event === "notification") notifyHandler = h;
			},
			removeListener: () => {},
			end: vi.fn(async () => {}),
		};

		const onClaim = vi.fn(async () => {});
		const loop = new AgencyClaimLoop({
			agencyIdentity: "claude-bot-gary.a",
			provider: "claude",
			capabilities: ["develop"],
			onClaim,
			connectListener: async () => fakeClient as never,
			queryFn: queryFn as never,
			pollIntervalMs: 1_000_000, // keep the poll timer out of the window
			logger: { log() {}, warn() {}, error() {} },
		});
		return { loop, sql, listenerQueries, onClaim, getNotify: () => notifyHandler };
	}

	it("attempts a claim on start + on wake but issues no presence/heartbeat query and no agency presence write", async () => {
		const { loop, sql, listenerQueries, getNotify } = makeLoop();

		await loop.start(); // initial tryClaim
		const notify = getNotify();
		expect(notify).toBeTypeOf("function");
		notify!({ channel: "work_offers" }); // the doorbell
		await new Promise((r) => setTimeout(r, 20)); // let the async tryClaim run
		await loop.stop();

		const allSql = sql.join("\n");
		// the wake actually drove a claim attempt (emergent presence = the claim)
		expect(allSql).toMatch(/fn_claim_work_offer/);
		// AC-14: no heartbeat-derived dispatchability read in the claim decision
		expect(allSql).not.toMatch(PRESENCE_PATTERN);
		// AC-15: receiving the notification wrote NO availability/presence row
		expect(allSql).not.toMatch(AGENCY_WRITE_PATTERN);
		// the LISTEN client only LISTENs — it asserts no presence either
		expect(listenerQueries.join("\n")).toMatch(/LISTEN work_offers/);
		expect(listenerQueries.join("\n")).not.toMatch(PRESENCE_PATTERN);
	});

	it("does not call onClaim (spawn) when there is no offer to claim — an unresponsive/idle agency simply doesn't win", async () => {
		const { loop, onClaim, getNotify } = makeLoop();
		await loop.start();
		getNotify()!({ channel: "work_offers" });
		await new Promise((r) => setTimeout(r, 20));
		await loop.stop();
		expect(onClaim).not.toHaveBeenCalled();
	});

	it("ignores notifications on unrelated channels (only the work_offers doorbell wakes a claim)", async () => {
		const { loop, sql, getNotify } = makeLoop();
		await loop.start();
		const claimsAfterStart = sql.filter((s) => /fn_claim_work_offer/.test(s)).length;
		getNotify()!({ channel: "msg_claude-bot-gary.a" }); // not work_offers
		await new Promise((r) => setTimeout(r, 20));
		await loop.stop();
		const claimsTotal = sql.filter((s) => /fn_claim_work_offer/.test(s)).length;
		expect(claimsTotal).toBe(claimsAfterStart); // no extra claim from the unrelated channel
	});
});
