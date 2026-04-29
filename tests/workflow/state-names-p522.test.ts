/**
 * P522 — Pool-leak guard unit tests
 *
 * These tests exercise the four new behaviors added by P522 using a mock Pool
 * so they require no live database connection.  Each test instantiates
 * StateNamesRegistry directly (or calls the module-level loadStateNames helper)
 * and asserts on the observable side-effects via the mock.
 *
 * Covered behaviours:
 *   1. dispose() releases the held NOTIFY PoolClient.
 *   2. load() is idempotent — calling it twice disposes the first subscription.
 *   3. Concurrent loadStateNames() calls share a single in-flight Promise,
 *      capping pool.connect() at exactly one call.
 *   4. A bootstrap failure (LISTEN throws) causes the acquired PoolClient to
 *      be released and leaves notifySubscription null.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	StateNamesRegistry,
	loadStateNames,
} from "../../src/core/workflow/state-names.ts";
import type { Pool, PoolClient } from "pg";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface MockClient {
	query: (sql: string) => Promise<void>;
	on: (event: string, handler: unknown) => void;
	removeListener: (event: string, handler: unknown) => void;
	release: () => void;
	/** test introspection */
	released: boolean;
	unlistenCalled: boolean;
}

function makeMockClient(opts: { listenThrows?: boolean } = {}): MockClient {
	const c: MockClient = {
		released: false,
		unlistenCalled: false,
		async query(sql: string) {
			if (sql.startsWith("LISTEN") && opts.listenThrows) {
				throw new Error("mock: LISTEN failed");
			}
			if (sql.startsWith("UNLISTEN")) c.unlistenCalled = true;
		},
		on() {},
		removeListener() {},
		release() {
			c.released = true;
		},
	};
	return c;
}

function makeMockPool(clients: MockClient[]): Pool {
	let idx = 0;
	return {
		query: async () => ({ rows: [], command: "", rowCount: 0, oid: 0, fields: [] }),
		connect: async () => {
			const c = clients[idx % clients.length];
			idx++;
			return c as unknown as PoolClient;
		},
	} as unknown as Pool;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("P522 — pool-leak guards (unit, mock pool)", () => {
	it("dispose() releases the held NOTIFY PoolClient", async () => {
		const client = makeMockClient();
		const pool = makeMockPool([client]);

		const registry = new StateNamesRegistry();
		await registry.load(pool);

		// At this point the registry holds client as its NOTIFY subscription.
		assert.equal(client.released, false, "client should not yet be released");

		await registry.dispose();

		assert.equal(client.released, true, "dispose() must release the PoolClient");
		assert.equal(
			(registry as any).notifySubscription,
			null,
			"notifySubscription must be null after dispose()",
		);
	});

	it("load() is idempotent — second call disposes the prior subscription", async () => {
		const client1 = makeMockClient();
		const client2 = makeMockClient();
		const pool = makeMockPool([client1, client2]);

		const registry = new StateNamesRegistry();
		await registry.load(pool); // acquires client1

		assert.equal(client1.released, false, "client1 not yet released after first load");

		await registry.load(pool); // must dispose client1, then acquire client2

		assert.equal(
			client1.released,
			true,
			"load() must release prior subscription before installing new one",
		);
		assert.equal(
			client1.unlistenCalled,
			true,
			"UNLISTEN must be issued for the prior subscription",
		);
		assert.equal(client2.released, false, "new subscription client should still be held");
	});

	it("concurrent loadStateNames() calls share a single in-flight Promise", async () => {
		let connectCount = 0;
		const client = makeMockClient();
		const pool: Pool = {
			query: async () => ({ rows: [], command: "", rowCount: 0, oid: 0, fields: [] }),
			connect: async () => {
				connectCount++;
				return client as unknown as PoolClient;
			},
		} as unknown as Pool;

		// Fire three concurrent calls before any await inside them can resolve.
		const [r1, r2, r3] = await Promise.all([
			loadStateNames(pool),
			loadStateNames(pool),
			loadStateNames(pool),
		]);

		assert.equal(
			connectCount,
			1,
			"Only one NOTIFY PoolClient should be acquired for concurrent in-flight loads",
		);
		assert.strictEqual(r1, r2, "All concurrent callers must receive the same registry");
		assert.strictEqual(r2, r3, "All concurrent callers must receive the same registry");
	});

	it("load() releases PoolClient when LISTEN throws (bootstrap failure)", async () => {
		const failingClient = makeMockClient({ listenThrows: true });
		const pool = makeMockPool([failingClient]);

		const registry = new StateNamesRegistry();
		// load() treats the NOTIFY failure as non-fatal and does NOT rethrow.
		await registry.load(pool);

		assert.equal(
			failingClient.released,
			true,
			"PoolClient must be released when LISTEN throws",
		);
		assert.equal(
			(registry as any).notifySubscription,
			null,
			"notifySubscription must remain null after bootstrap failure",
		);
	});
});
