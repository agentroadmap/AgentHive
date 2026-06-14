/**
 * P1065 — pure-logic unit tests (no blessed, no pg).
 * Run: node --import jiti/register --test src/apps/tui/panels/presence-board-model.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type AgencyRow,
	type BoardState,
	formatSilence,
	groupTrust,
	isColdWake,
	type MessageRow,
	modeTag,
	presenceColorKey,
	presenceLabel,
	reduceBoard,
	sortAgencyRows,
	splitMessages,
	trustExpiry,
	type TrustRow,
	unackedOfferLabel,
	fallbackBanner,
} from "./presence-board-model.ts";

function row(p: Partial<AgencyRow>): AgencyRow {
	return {
		agency_id: p.agency_id ?? "a",
		display_name: p.display_name ?? p.agency_id ?? "a",
		status: p.status ?? "active",
		presence_state: p.presence_state ?? "online",
		silence_seconds: p.silence_seconds ?? 10,
		dispatchable: p.dispatchable ?? true,
		liveness_state: p.liveness_state ?? "live-but-idle",
		has_live_listener: p.has_live_listener ?? true,
		active_task: p.active_task ?? null,
	};
}

// --- AC-9 / AC-17: presence colour ladder ----------------------------------
test("AC-17 presence colour map honours silence boundaries", () => {
	assert.equal(presenceColorKey(row({ dispatchable: true, silence_seconds: 5 })), "success");
	assert.equal(presenceColorKey(row({ dispatchable: false, silence_seconds: 60 })), "success");
	assert.equal(presenceColorKey(row({ dispatchable: false, silence_seconds: 61 })), "warning");
	assert.equal(presenceColorKey(row({ dispatchable: false, silence_seconds: 300 })), "warning");
	assert.equal(presenceColorKey(row({ dispatchable: false, silence_seconds: 301 })), "muted");
	assert.equal(presenceColorKey(row({ dispatchable: false, silence_seconds: 3600 })), "muted");
	assert.equal(presenceColorKey(row({ dispatchable: false, silence_seconds: 3601 })), "danger");
	assert.equal(presenceColorKey(row({ presence_state: "offline" })), "danger");
	assert.equal(presenceColorKey(row({ status: "paused" })), "danger");
	assert.equal(presenceColorKey(row({ presence_state: "unknown" })), "fg");
});

test("AC-9 presence labels match buckets", () => {
	assert.equal(presenceLabel(row({ dispatchable: false, silence_seconds: 120 })), "away");
	assert.equal(presenceLabel(row({ dispatchable: false, silence_seconds: 1000 })), "idle");
	assert.equal(presenceLabel(row({ presence_state: "offline" })), "offline");
	assert.equal(presenceLabel(row({ presence_state: "unknown" })), "restricted");
});

// --- AC-1 / AC-15: silence formatting --------------------------------------
test("AC-15 formatSilence s/m/h conversion", () => {
	assert.equal(formatSilence(5), "5s");
	assert.equal(formatSilence(59), "59s");
	assert.equal(formatSilence(60), "1m");
	assert.equal(formatSilence(75), "1m 15s");
	assert.equal(formatSilence(3600), "1h");
	assert.equal(formatSilence(3661), "1h 1m");
});

// --- AC-1 / AC-8 / AC-15: sort ---------------------------------------------
test("AC-8 sort: offline last, then silence DESC (stalest active first)", () => {
	const rows = [
		row({ agency_id: "fresh", silence_seconds: 5 }),
		row({ agency_id: "off", presence_state: "offline", silence_seconds: 99999 }),
		row({ agency_id: "stale", dispatchable: false, silence_seconds: 250 }),
	];
	const sorted = sortAgencyRows(rows).map((r) => r.agency_id);
	assert.deepEqual(sorted, ["stale", "fresh", "off"]);
});

// --- AC-10 / AC-24: cold-wake ----------------------------------------------
test("AC-10 cold-wake: stale heartbeat + active + no listener => coldwake", () => {
	assert.equal(
		isColdWake({ status: "active", silence_seconds: 300, has_live_listener: false, liveness_state: "stale" }),
		true,
	);
	// live listener overrides poke staleness
	assert.equal(
		isColdWake({ status: "active", silence_seconds: 300, has_live_listener: true, liveness_state: "stale" }),
		false,
	);
	// fully offline (>1h) is not cold-wake, it's offline
	assert.equal(
		isColdWake({ status: "active", silence_seconds: 4000, has_live_listener: false, liveness_state: "stale" }),
		false,
	);
	// not active => not cold-wake
	assert.equal(
		isColdWake({ status: "paused", silence_seconds: 300, has_live_listener: false, liveness_state: "stale" }),
		false,
	);
});

// --- AC-4 / AC-11 / AC-19 / AC-22: message split + unacked offer ------------
test("AC-11 splitMessages routes by direction; AC-22 flags old unacked offers", () => {
	const now = Date.parse("2026-06-14T12:00:00Z");
	const msgs: MessageRow[] = [
		{ message_id: "1", direction: "orchestrator->liaison", kind: "offer_dispatch", created_at: "2026-06-14T11:50:00Z", acked_at: null },
		{ message_id: "2", direction: "orchestrator->liaison", kind: "liaison_poke", created_at: "2026-06-14T11:59:00Z", acked_at: "2026-06-14T11:59:30Z" },
		{ message_id: "3", direction: "liaison->orchestrator", kind: "spawn_failure", created_at: "2026-06-14T11:58:00Z", acked_at: null },
		{ message_id: "4", direction: "orchestrator->liaison", kind: "offer_dispatch", created_at: "2026-06-14T11:59:30Z", acked_at: null },
	];
	const v = splitMessages(msgs, now);
	assert.equal(v.inbox.length, 3);
	assert.equal(v.outbox.length, 1);
	// only msg 1 is an offer, unacked, AND older than 2 min
	assert.deepEqual(v.unackedOffers.map((m) => m.message_id), ["1"]);
	assert.match(unackedOfferLabel(v.unackedOffers[0], now), /\[UNACK\] offer_dispatch — 10m ago/);
});

// --- AC-5 / AC-12 / AC-20: trust grouping + expiry --------------------------
test("AC-12 trustExpiry: expired / expiring(<24h) / ok", () => {
	const now = Date.parse("2026-06-14T12:00:00Z");
	const mk = (exp: string | null): TrustRow => ({
		agent_identity: "x", trusted_agent: "y", trust_level: "trusted", created_at: null, expires_at: exp,
	});
	assert.equal(trustExpiry(mk(null), now), "ok");
	assert.equal(trustExpiry(mk("2026-06-13T12:00:00Z"), now), "expired");
	assert.equal(trustExpiry(mk("2026-06-14T20:00:00Z"), now), "expiring");
	assert.equal(trustExpiry(mk("2026-06-20T12:00:00Z"), now), "ok");
});

test("AC-20 groupTrust: tiers grouped, expired separated", () => {
	const now = Date.parse("2026-06-14T12:00:00Z");
	const rows: TrustRow[] = [
		{ agent_identity: "a", trusted_agent: "sys", trust_level: "authority", created_at: null, expires_at: null },
		{ agent_identity: "a", trusted_agent: "b", trust_level: "trusted", created_at: null, expires_at: "2026-06-20T12:00:00Z" },
		{ agent_identity: "a", trusted_agent: "old", trust_level: "known", created_at: null, expires_at: "2026-06-01T12:00:00Z" },
	];
	const v = groupTrust(rows, now);
	assert.equal(v.activeByTier.get("authority")?.length, 1);
	assert.equal(v.activeByTier.get("trusted")?.length, 1);
	assert.equal(v.activeByTier.has("known"), false); // expired moved out
	assert.equal(v.expired.length, 1);
	assert.equal(v.expired[0].trusted_agent, "old");
});

// --- AC-6 / AC-21: keyboard state machine ----------------------------------
test("AC-21 reduceBoard: down down enter tab esc down enter sequence", () => {
	let s: BoardState = { mode: "board", cursor: 0, rowCount: 5 };
	s = reduceBoard(s, "down"); assert.equal(s.cursor, 1);
	s = reduceBoard(s, "down"); assert.equal(s.cursor, 2);
	s = reduceBoard(s, "enter"); assert.equal(s.mode, "inspector-messaging");
	s = reduceBoard(s, "tab"); assert.equal(s.mode, "inspector-trust");
	s = reduceBoard(s, "tab"); assert.equal(s.mode, "inspector-messaging");
	// down is ignored inside the inspector
	s = reduceBoard(s, "down"); assert.equal(s.cursor, 2);
	s = reduceBoard(s, "esc"); assert.equal(s.mode, "board");
	s = reduceBoard(s, "down"); assert.equal(s.cursor, 3);
	s = reduceBoard(s, "enter"); assert.equal(s.mode, "inspector-messaging");
});

test("AC-6 cursor clamps; enter no-op on empty board", () => {
	let s: BoardState = { mode: "board", cursor: 0, rowCount: 0 };
	s = reduceBoard(s, "down"); assert.equal(s.cursor, 0);
	s = reduceBoard(s, "up"); assert.equal(s.cursor, 0);
	s = reduceBoard(s, "enter"); assert.equal(s.mode, "board"); // empty → no inspect
	s = { mode: "board", cursor: 0, rowCount: 3 };
	s = reduceBoard(s, "up"); assert.equal(s.cursor, 0); // clamp low
	s.cursor = 2; s = reduceBoard(s, "down"); assert.equal(s.cursor, 2); // clamp high
});

test("AC-21 modeTag formatting", () => {
	assert.equal(modeTag("board"), "[BOARD]");
	assert.equal(modeTag("inspector-messaging"), "[INSPECTOR-messaging]");
	assert.equal(modeTag("inspector-trust"), "[INSPECTOR-trust]");
});

// --- AC-7 / AC-14 / AC-23: fallback banner ---------------------------------
test("AC-23 fallback banner shows iff fn_agency_status_for absent", () => {
	assert.equal(fallbackBanner(true), null);
	assert.match(fallbackBanner(false) ?? "", /Presence unfiltered/);
});
