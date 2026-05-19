/**
 * P902 AC-8: OfferClaimLoop unit tests.
 *
 * Verifies:
 *   1. Concurrent NOTIFYs for the same offer → exactly one claim + one dispatch
 *      (the second NOTIFY fires tryClaim again, but fn_claim_work_offer returns
 *      empty because the offer is already claimed, so dispatch is never called twice)
 *   2. Poll fallback — loop wakes every pollIntervalMs without a NOTIFY and
 *      claims any available offer, so a missed NOTIFY doesn't stall the pipeline.
 *
 * Uses _setQueryForTest to inject a mock query function (no DB required).
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
	OfferClaimLoop,
	_setQueryForTest,
	type ListenerClient,
} from "./offer-claim-loop.ts";
import type { ClaimedOffer, OfferDispatcher } from "./offer-dispatch.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeClaimRow(dispatchId: number) {
	return {
		dispatch_id: dispatchId,
		proposal_id: 100 + dispatchId,
		squad_name: `squad-${dispatchId}`,
		dispatch_role: "review",
		claim_token: `tok-${dispatchId}`,
		claim_expires_at: new Date(Date.now() + 60_000).toISOString(),
		offer_version: 1,
		metadata: null,
	};
}

function makeFakeListenerClient(): ListenerClient & {
	emit: (channel: string) => void;
} {
	const handlers: Array<(msg: { channel: string }) => void> = [];
	return {
		query: async () => ({}),
		on(event: string, handler: (arg: any) => void) {
			if (event === "notification") {
				handlers.push(handler as (msg: { channel: string }) => void);
			}
			return this;
		},
		removeListener() {
			return this;
		},
		release() {},
		emit(channel: string) {
			for (const h of handlers) h({ channel });
		},
	};
}

function silentLogger() {
	return { log: () => {}, warn: () => {}, error: () => {} };
}

// ─── AC-8 Test 1: Concurrent NOTIFYs → exactly one dispatch ─────────────────

test("OfferClaimLoop AC-8: concurrent NOTIFYs for same offer yield exactly one dispatch", async () => {
	let claimCallCount = 0;
	const dispatched: ClaimedOffer[] = [];

	// First claim call returns a row; subsequent calls return empty (already claimed).
	_setQueryForTest(async (_sql, _params) => {
		claimCallCount++;
		if (claimCallCount === 1) {
			return { rows: [makeClaimRow(1)] };
		}
		return { rows: [] };
	});

	const fakeClient = makeFakeListenerClient();

	let resolveDispatch: () => void;
	const dispatchDone = new Promise<void>((r) => {
		resolveDispatch = r;
	});

	const dispatcher: OfferDispatcher = {
		async dispatch(claim) {
			dispatched.push(claim);
			resolveDispatch();
		},
	};

	const loop = new OfferClaimLoop({
		orchestratorIdentity: "test-orch",
		dispatcher,
		connectListener: async () => fakeClient,
		leaseTtlSeconds: 60,
		pollIntervalMs: 60_000, // effectively infinite — don't rely on poll here
		maxConcurrent: 4,
		logger: silentLogger(),
	});

	await loop.start();

	// Fire two concurrent NOTIFYs — simulates a collision where NOTIFY fires
	// for the same offer row twice (e.g., retry insert + primary insert racing).
	fakeClient.emit("work_offers");
	fakeClient.emit("work_offers");

	// Wait for the one real dispatch to complete.
	await Promise.race([
		dispatchDone,
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error("dispatch timeout")), 500),
		),
	]);

	// Drain microtasks so any second dispatch attempt would complete.
	for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));

	await loop.stop();
	_setQueryForTest(undefined as never); // restore (will error loudly if used after)

	assert.equal(
		dispatched.length,
		1,
		`expected exactly 1 dispatch; got ${dispatched.length}`,
	);
	assert.equal(dispatched[0].dispatchId, 1);
	assert.ok(
		claimCallCount >= 2,
		`expected fn_claim_work_offer called ≥2 times; got ${claimCallCount}`,
	);
});

// ─── AC-8 Test 2: Poll fallback claims offer without NOTIFY ──────────────────

test("OfferClaimLoop AC-8: poll fallback claims available offer when no NOTIFY fires", async () => {
	let claimCallCount = 0;
	const dispatched: ClaimedOffer[] = [];

	_setQueryForTest(async (_sql, _params) => {
		claimCallCount++;
		if (claimCallCount === 1) {
			return { rows: [makeClaimRow(2)] };
		}
		return { rows: [] };
	});

	const fakeClient = makeFakeListenerClient();

	let resolveDispatch: () => void;
	const dispatchDone = new Promise<void>((r) => {
		resolveDispatch = r;
	});

	const dispatcher: OfferDispatcher = {
		async dispatch(claim) {
			dispatched.push(claim);
			resolveDispatch();
		},
	};

	const loop = new OfferClaimLoop({
		orchestratorIdentity: "test-orch",
		dispatcher,
		connectListener: async () => fakeClient,
		leaseTtlSeconds: 60,
		pollIntervalMs: 30, // short poll so the test is fast
		maxConcurrent: 4,
		logger: silentLogger(),
	});

	await loop.start(); // start() calls tryClaim() once immediately → picks up the offer

	await Promise.race([
		dispatchDone,
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error("poll dispatch timeout")), 500),
		),
	]);

	await loop.stop();
	_setQueryForTest(undefined as never);

	assert.equal(dispatched.length, 1, `expected 1 dispatch via poll; got ${dispatched.length}`);
	assert.equal(dispatched[0].dispatchId, 2);
});

// ─── AC-8 Test 3: maxConcurrent cap prevents dispatch storm ──────────────────

test("OfferClaimLoop AC-8: maxConcurrent=1 caps concurrent dispatches to one", async () => {
	// Returns offers indefinitely so the loop would keep claiming if uncapped.
	let claimSeq = 0;
	_setQueryForTest(async () => {
		claimSeq++;
		if (claimSeq <= 3) return { rows: [makeClaimRow(claimSeq)] };
		return { rows: [] };
	});

	const fakeClient = makeFakeListenerClient();
	const dispatched: ClaimedOffer[] = [];
	let concurrentPeak = 0;
	let concurrentNow = 0;

	const dispatcher: OfferDispatcher = {
		async dispatch(claim) {
			concurrentNow++;
			concurrentPeak = Math.max(concurrentPeak, concurrentNow);
			dispatched.push(claim);
			// Hold each dispatch for 50ms so they'd pile up if uncapped.
			await new Promise((r) => setTimeout(r, 50));
			concurrentNow--;
		},
	};

	const loop = new OfferClaimLoop({
		orchestratorIdentity: "test-orch",
		dispatcher,
		connectListener: async () => fakeClient,
		leaseTtlSeconds: 60,
		pollIntervalMs: 60_000,
		maxConcurrent: 1,
		logger: silentLogger(),
	});

	await loop.start();
	// Trigger multiple claim attempts.
	fakeClient.emit("work_offers");
	fakeClient.emit("work_offers");
	fakeClient.emit("work_offers");

	await new Promise((r) => setTimeout(r, 200));
	await loop.stop();
	_setQueryForTest(undefined as never);

	assert.ok(
		concurrentPeak <= 1,
		`maxConcurrent=1 violated; peak concurrent dispatches: ${concurrentPeak}`,
	);
});
