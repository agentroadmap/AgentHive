/**
 * P1065 — queries + render integration via a MOCK ctx.query (no live pg).
 * Run: node --import jiti/register --test src/apps/tui/panels/presence-board-queries.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	fetchFleet,
	fetchMessages,
	fetchTrust,
	FLEET_SQL,
	MESSAGES_SQL,
	probeStatusForFn,
	type ShellQueryFn,
	TRUST_IN_SQL,
	TRUST_OUT_SQL,
} from "./presence-board-queries.ts";
import {
	renderFleet,
	renderMessaging,
	renderTrust,
	statusBarText,
} from "./presence-board-render.ts";
import { splitMessages } from "./presence-board-model.ts";

const THEME = {
	fg: "white", muted: "gray", accent: "cyan", success: "green",
	warning: "yellow", danger: "red", selectionBg: "blue", selectionFg: "white",
};

/** Build a mock ctx.query that records SQL and returns canned rows by SQL. */
function mockQuery(canned: Record<string, unknown[]>): {
	q: ShellQueryFn;
	seen: { text: string; params?: unknown[] }[];
} {
	const seen: { text: string; params?: unknown[] }[] = [];
	const q: ShellQueryFn = async (text, params) => {
		seen.push({ text, params });
		const key = Object.keys(canned).find((k) => text.includes(k)) ?? "";
		return { rows: (canned[key] ?? []) as never[] };
	};
	return { q, seen };
}

test("AC-12 fetchFleet runs FLEET_SQL via ctx.query and coerces silence to number", async () => {
	const { q, seen } = mockQuery({
		"v_agency_status": [
			{ agency_id: "claude-bot-gary.a", display_name: "claude-bot-gary.a", status: "active", presence_state: "online", silence_seconds: "24", dispatchable: true, liveness_state: "live-but-idle", has_live_listener: true, active_task: "P3309" },
		],
	});
	const rows = await fetchFleet(q);
	assert.equal(rows.length, 1);
	assert.equal(typeof rows[0].silence_seconds, "number");
	assert.equal(rows[0].silence_seconds, 24);
	assert.equal(rows[0].active_task, "P3309");
	assert.ok(seen[0].text.includes("roadmap.v_agency_status"));
	// the SQL must NOT reference the fabricated objects (fn_agency_status_for,
	// bare agency.* schema, or bare workforce.* schema). roadmap_workforce.* IS
	// real and allowed, so we negative-lookbehind the legit prefixes.
	assert.equal(/fn_agency_status_for/.test(FLEET_SQL), false);
	assert.equal(/\bagency\.agency\b/.test(FLEET_SQL), false);
	assert.equal(/(?<!roadmap_)\bworkforce\./.test(FLEET_SQL), false);
});

test("AC-19 fetchMessages passes [agencyId, limit] and split counts are correct", async () => {
	const { q, seen } = mockQuery({
		"roadmap.liaison_message": [
			{ message_id: "1", direction: "orchestrator->liaison", kind: "offer_dispatch", created_at: "2026-06-14T11:00:00Z", acked_at: null },
			{ message_id: "2", direction: "liaison->orchestrator", kind: "spawn_failure", created_at: "2026-06-14T11:01:00Z", acked_at: null },
			{ message_id: "3", direction: "orchestrator->liaison", kind: "liaison_poke", created_at: "2026-06-14T11:02:00Z", acked_at: "2026-06-14T11:02:10Z" },
		],
	});
	const msgs = await fetchMessages(q, "codex-bot-andy.a", 40);
	assert.deepEqual(seen[0].params, ["codex-bot-andy.a", 40]);
	const v = splitMessages(msgs, Date.parse("2026-06-14T12:00:00Z"));
	assert.equal(v.inbox.length, 2);
	assert.equal(v.outbox.length, 1);
	assert.equal(v.unackedOffers.length, 1); // offer, unacked, >2min old
	assert.ok(MESSAGES_SQL.includes("roadmap.liaison_message"));
});

test("AC-5 fetchTrust queries agent_trust twice (out=agent_identity, in=trusted_agent)", async () => {
	const { q, seen } = mockQuery({
		"WHERE agent_identity = $1": [
			{ agent_identity: "codex-bot-andy.a", trusted_agent: "system", trust_level: "authority", created_at: null, expires_at: null },
		],
		"WHERE trusted_agent = $1": [
			{ agent_identity: "gary", trusted_agent: "codex-bot-andy.a", trust_level: "trusted", created_at: null, expires_at: null },
		],
	});
	const { outgoing, incoming } = await fetchTrust(q, "codex-bot-andy.a");
	assert.equal(outgoing.length, 1);
	assert.equal(incoming.length, 1);
	assert.equal(seen.length, 2);
	assert.ok(TRUST_OUT_SQL.includes("agent_identity = $1"));
	assert.ok(TRUST_IN_SQL.includes("trusted_agent = $1"));
	assert.ok(TRUST_OUT_SQL.includes("roadmap_workforce.agent_trust"));
});

test("AC-23 probeStatusForFn returns false when catalog lacks the fn", async () => {
	const { q } = mockQuery({ "pg_proc": [{ present: false }] });
	assert.equal(await probeStatusForFn(q), false);
});

test("AC-1 renderFleet: header + sorted rows; selected row highlighted; cold-wake :: overlay", () => {
	const rows = [
		{ agency_id: "fresh", display_name: "fresh", status: "active", presence_state: "online", silence_seconds: 5, dispatchable: true, liveness_state: "x", has_live_listener: true, active_task: "P1" },
		{ agency_id: "cold", display_name: "cold", status: "active", presence_state: "online", silence_seconds: 400, dispatchable: false, liveness_state: "stale", has_live_listener: false, active_task: null },
	];
	const { lines, sorted } = renderFleet(rows, 0, THEME);
	// 'cold' (silence 400) sorts above 'fresh' (silence 5) since both non-offline
	assert.equal(sorted[0].agency_id, "cold");
	assert.equal(lines.length, 2);
	assert.match(lines[0], /::/); // cold-wake overlay on selected row 0 (cold)
	assert.match(lines[0], /\{blue-bg\}/); // selection highlight
});

test("AC-5 renderTrust groups by tier and shows [expired] section", () => {
	const now = Date.parse("2026-06-14T12:00:00Z");
	const out = [
		{ agent_identity: "me", trusted_agent: "sys", trust_level: "authority", created_at: null, expires_at: null },
		{ agent_identity: "me", trusted_agent: "old", trust_level: "known", created_at: null, expires_at: "2026-06-01T00:00:00Z" },
	];
	const text = renderTrust("me", out, [], THEME, now);
	assert.match(text, /\[authority\]/);
	assert.match(text, /\[expired\]/);
	assert.match(text, /old/);
});

test("AC-2/AC-21 statusBarText shows mode tag, agency, refresh time, hints", () => {
	const s = statusBarText("board", "claude-bot-gary.a", "12:00:00");
	assert.match(s, /\[BOARD\]/);
	assert.match(s, /claude-bot-gary\.a/);
	assert.match(s, /Last refresh: 12:00:00/);
	assert.match(s, /Enter inspect/);
});
