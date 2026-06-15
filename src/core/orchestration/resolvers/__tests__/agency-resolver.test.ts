/**
 * P1375 AC-4: resolveAgency capacity-throttle audit wiring.
 *
 * Verifies, against the REAL resolveAgency + capacity-filter modules (query
 * fns injected via their _setQueryForTest seams — no logic copies):
 * - soft-throttled candidate: still selected, exactly one fire-and-forget
 *   message_ledger INSERT with message_type='throttle_decision' and the full
 *   metadata payload (AC-1/AC-2/AC-5)
 * - hard-throttled candidate: resolver returns null AND logs the decision
 * - healthy candidate: no audit row
 * - ledger INSERT failure does not break resolution (AC-3)
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
	resolveAgency,
	_setQueryForTest as setResolverQuery,
} from "../agency-resolver.ts";
import { _setQueryForTest as setCapacityQuery } from "../../capacity-filter.ts";

interface Captured {
	sql: string;
	params: unknown[];
}

const CANDIDATE_ROW = {
	id: "6015",
	agency_id: "73946",
	project_id: 1,
	capabilities: { provider: "claude", jobs: ["develop"] },
	status: "active",
	throttle_count: 0,
	last_seen_at: null,
	max_in_flight: 4,
	agency_identity: "claude-bot-gary.a",
	in_flight_count: 0,
};

function installResolverQuery(captured: Captured[]) {
	setResolverQuery((async (sql: string, params?: unknown[]) => {
		captured.push({ sql, params: params ?? [] });
		if (sql.includes("FROM roadmap_workforce.provider_registry")) {
			return { rows: [CANDIDATE_ROW] } as any;
		}
		// buildAgencyChain walk: terminate immediately
		return { rows: [] } as any;
	}) as any);
}

function installCapacityQuery(
	captured: Captured[],
	capacityRow: Record<string, unknown> | null,
	opts: { failLedgerInsert?: boolean } = {},
) {
	setCapacityQuery((async (sql: string, params?: unknown[]) => {
		captured.push({ sql, params: params ?? [] });
		if (sql.includes("agency_capacity")) {
			return { rows: capacityRow ? [capacityRow] : [] } as any;
		}
		if (sql.includes("INSERT INTO roadmap.message_ledger")) {
			if (opts.failLedgerInsert) {
				throw new Error("synthetic ledger failure");
			}
			return { rows: [] } as any;
		}
		return { rows: [] } as any;
	}) as any);
}

function ledgerInserts(captured: Captured[]): Captured[] {
	return captured.filter((c) =>
		c.sql.includes("INSERT INTO roadmap.message_ledger"),
	);
}

/** The fire-and-forget log resolves on the microtask queue; flush it. */
async function settle() {
	await new Promise((resolve) => setImmediate(resolve));
}

describe("P1375 resolveAgency capacity audit", () => {
	let resolverCalls: Captured[];
	let capacityCalls: Captured[];

	beforeEach(() => {
		resolverCalls = [];
		capacityCalls = [];
	});

	test("soft throttle: candidate selected + exactly one throttle_decision row", async () => {
		installResolverQuery(resolverCalls);
		installCapacityQuery(capacityCalls, {
			throttle_action: "soft",
			p_skip: "0.40",
			headroom_pct: "30.0",
			reset_at: null,
		});

		const candidate = await resolveAgency("1");
		await settle();

		assert.ok(candidate, "soft-throttled candidate must still be selected");
		assert.equal(String(candidate.agencyId), "73946");

		const inserts = ledgerInserts(capacityCalls);
		assert.equal(inserts.length, 1, "exactly one audit row per decision (AC-5)");
		const [fromAgent, channel, messageType, metadataJson] = inserts[0].params as string[];
		assert.equal(fromAgent, "orchestrator", "from_agent must be a registered identity");
		assert.equal(channel, "system:capacity-throttle");
		assert.equal(messageType, "throttle_decision");
		const metadata = JSON.parse(metadataJson);
		assert.equal(metadata.agency_id, "claude-bot-gary.a");
		assert.equal(metadata.provider, "claude");
		assert.equal(metadata.throttle_action, "soft");
		assert.equal(metadata.p_skip, 0.4);
		assert.equal(metadata.headroom_pct, 30);
		assert.equal(metadata.reason, "agency_soft_throttled");
		assert.ok("reset_at" in metadata, "metadata carries reset_at");
	});

	test("hard throttle: resolver returns null + decision logged", async () => {
		installResolverQuery(resolverCalls);
		installCapacityQuery(capacityCalls, {
			throttle_action: "hard",
			p_skip: "1.0",
			headroom_pct: "2.0",
			reset_at: new Date("2026-06-13T12:00:00Z"),
		});

		const candidate = await resolveAgency("1");
		await settle();

		assert.equal(candidate, null, "hard-throttled candidate must be rejected");
		const inserts = ledgerInserts(capacityCalls);
		assert.equal(inserts.length, 1);
		const metadata = JSON.parse((inserts[0].params as string[])[3]);
		assert.equal(metadata.throttle_action, "hard");
		assert.equal(metadata.reason, "agency_hard_throttled");
	});

	test("healthy candidate: no audit row", async () => {
		installResolverQuery(resolverCalls);
		installCapacityQuery(capacityCalls, null); // no agency_capacity row

		const candidate = await resolveAgency("1");
		await settle();

		assert.ok(candidate, "healthy candidate selected");
		assert.equal(ledgerInserts(capacityCalls).length, 0, "no decision → no audit");
	});

	test("AC-3: ledger INSERT failure does not block resolution", async () => {
		installResolverQuery(resolverCalls);
		installCapacityQuery(
			capacityCalls,
			{ throttle_action: "soft", p_skip: "0.25", headroom_pct: "40.0", reset_at: null },
			{ failLedgerInsert: true },
		);

		const candidate = await resolveAgency("1");
		await settle();

		assert.ok(candidate, "resolution must survive a failed audit write");
		assert.equal(String(candidate.agencyId), "73946");
	});
});
